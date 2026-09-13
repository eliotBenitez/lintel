// SPDX-License-Identifier: GPL-2.0-or-later
//
// FullscreenReveal — macOS-style access to the panel from a fullscreen app.
//
// GNOME tracks LayoutManager.panelBox with `trackFullscreen`, so the box is
// normally hidden while a fullscreen window is present on the primary monitor.
// We keep that native resting state and add only a one-pixel, non-strut hot edge.
// Entering the edge reveals the existing panel as an overlay; leaving the panel
// hides it again once no panel popup is open.  We never replace the panel or
// change its chrome tracking/struts, and destroy() restores the visibility that
// GNOME would currently choose.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PanelAdapter} from './compat/panelAdapter.js';

const EDGE_HEIGHT = 1;
const REVEAL_DURATION_MS = 160;
const HIDE_DURATION_MS = 140;
const INITIAL_HIDE_DELAY_MS = 650;
const HIDE_DELAY_MS = 280;

export class FullscreenReveal {
    constructor(extension, onReveal = null, isEngaged = null) {
        this._extension = extension;
        this._onReveal = onReveal;
        this._isEngaged = isEngaged;
        this._settings = null;
        this._settingsId = 0;
        this._fullscreenId = 0;
        this._monitorsId = 0;
        this._overviewShowingId = 0;
        this._overviewHidingId = 0;
        this._panelHoverId = 0;
        this._panelVisibleId = 0;
        this._syncId = 0;
        this._hideId = 0;
        this._edge = null;
        this._panel = null;
        this._panelTrackHover = false;
        this._revealed = false;
        this._enabled = false;
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;

        try {
            this._settings = this._extension?.getSettings?.() ?? null;
        } catch (_e) {
            this._settings = null;
        }
        if (this._settings) {
            this._settingsId = this._settings.connect(
                'changed::fullscreen-reveal', () => this._queueSync());
        }

        this._panel = PanelAdapter.actor;
        if (this._panel) {
            this._panelTrackHover = this._panel.track_hover;
            this._panel.track_hover = true;
            this._panelHoverId = this._panel.connect(
                'notify::hover', () => this._onPanelHoverChanged());
        }

        const panelBox = PanelAdapter.panelBox;
        if (panelBox) {
            // LayoutManager may re-assert trackFullscreen visibility after a
            // restack. Keep the box visible only during our explicit reveal.
            this._panelVisibleId = panelBox.connect(
                'notify::visible', () => this._onPanelVisibilityChanged());
        }

        this._edge = new St.Widget({
            name: 'lintel-fullscreen-edge',
            reactive: true,
            track_hover: true,
            visible: false,
        });
        this._edge.connect('enter-event', () => {
            this._reveal();
            return Clutter.EVENT_PROPAGATE;
        });
        Main.layoutManager.addTopChrome(this._edge, {
            affectsStruts: false,
            trackFullscreen: false,
        });

        this._fullscreenId = global.display.connect(
            'in-fullscreen-changed', () => this._queueSync());
        this._monitorsId = Main.layoutManager.connect(
            'monitors-changed', () => this._queueSync());
        this._overviewShowingId = Main.overview.connect(
            'showing', () => this._queueSync());
        this._overviewHidingId = Main.overview.connect(
            'hiding', () => this._queueSync());

        this._sync();
    }

    _settingEnabled() {
        try {
            return this._settings
                ? this._settings.get_boolean('fullscreen-reveal')
                : true;
        } catch (_e) {
            // A stale compiled schema should degrade to the new default.
            return true;
        }
    }

    _isPrimaryFullscreen() {
        const index = Main.layoutManager.primaryIndex;
        return index >= 0 && global.display.get_monitor_in_fullscreen(index);
    }

    _shouldHandleFullscreen() {
        return this._settingEnabled() &&
            this._isPrimaryFullscreen() &&
            !Main.overview.visible &&
            global.window_group.visible;
    }

    _positionEdge() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!this._edge || !monitor)
            return;
        this._edge.set_position(monitor.x, monitor.y);
        this._edge.set_size(monitor.width, EDGE_HEIGHT);
    }

    _queueSync() {
        if (!this._enabled || this._syncId)
            return;
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._syncId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        if (!this._enabled)
            return;

        this._positionEdge();
        if (this._shouldHandleFullscreen()) {
            if (!this._revealed)
                this._edge?.show();
            return;
        }

        this._cancelHide();
        this._revealed = false;
        this._edge?.hide();

        const panelBox = PanelAdapter.panelBox;
        if (!panelBox)
            return;
        panelBox.remove_all_transitions();
        panelBox.translation_y = 0;

        // Outside fullscreen GNOME's tracked panel is visible. During Overview
        // it is also visible, but LayoutManager owns that transition; showing it
        // here is safe and avoids leaving it hidden after an interrupted reveal.
        if (!this._isPrimaryFullscreen() || Main.overview.visible)
            panelBox.show();
        else if (global.window_group.visible)
            panelBox.hide();
    }

    _reveal() {
        if (!this._enabled || this._revealed || !this._shouldHandleFullscreen())
            return;

        const panelBox = PanelAdapter.panelBox;
        if (!panelBox)
            return;

        this._revealed = true;
        this._edge?.hide();
        panelBox.remove_all_transitions();
        panelBox.translation_y = -Math.max(1, panelBox.height);
        panelBox.show();
        panelBox.ease({
            translation_y: 0,
            duration: REVEAL_DURATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        try {
            this._onReveal?.();
        } catch (e) {
            logError(e, 'lintel: fullscreen reveal callback');
        }
        this._scheduleHide(INITIAL_HIDE_DELAY_MS);
    }

    _onPanelVisibilityChanged() {
        if (!this._enabled || !this._revealed ||
            !this._shouldHandleFullscreen())
            return;
        const panelBox = PanelAdapter.panelBox;
        if (panelBox && !panelBox.visible)
            panelBox.show();
    }

    _onPanelHoverChanged() {
        if (!this._revealed)
            return;
        if (this._panel?.hover)
            this._cancelHide();
        else
            this._scheduleHide(HIDE_DELAY_MS);
    }

    _panelIsEngaged() {
        let externalEngaged = false;
        try {
            externalEngaged = this._isEngaged?.() ?? false;
        } catch (e) {
            logError(e, 'lintel: fullscreen engagement callback');
        }
        return Boolean(this._panel?.hover ||
            Main.panel?.menuManager?.activeMenu || externalEngaged);
    }

    _scheduleHide(delay = HIDE_DELAY_MS) {
        this._cancelHide();
        if (!this._revealed)
            return;
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._hideId = 0;
            if (!this._revealed)
                return GLib.SOURCE_REMOVE;
            if (this._panelIsEngaged()) {
                this._scheduleHide(HIDE_DELAY_MS);
                return GLib.SOURCE_REMOVE;
            }
            this._hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelHide() {
        if (!this._hideId)
            return;
        GLib.Source.remove(this._hideId);
        this._hideId = 0;
    }

    _hide() {
        if (!this._revealed)
            return;
        if (!this._shouldHandleFullscreen()) {
            this._sync();
            return;
        }

        const panelBox = PanelAdapter.panelBox;
        if (!panelBox) {
            this._revealed = false;
            return;
        }

        panelBox.remove_all_transitions();
        panelBox.ease({
            translation_y: -Math.max(1, panelBox.height),
            duration: HIDE_DURATION_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (!this._enabled || !this._revealed)
                    return;
                this._revealed = false;
                panelBox.hide();
                panelBox.translation_y = 0;
                if (this._shouldHandleFullscreen())
                    this._edge?.show();
            },
        });
    }

    destroy() {
        if (!this._enabled)
            return;
        this._enabled = false;
        this._cancelHide();

        if (this._syncId) {
            GLib.Source.remove(this._syncId);
            this._syncId = 0;
        }
        if (this._settingsId && this._settings) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        if (this._fullscreenId) {
            global.display.disconnect(this._fullscreenId);
            this._fullscreenId = 0;
        }
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = 0;
        }
        if (this._overviewHidingId) {
            Main.overview.disconnect(this._overviewHidingId);
            this._overviewHidingId = 0;
        }
        if (this._panelHoverId && this._panel) {
            this._panel.disconnect(this._panelHoverId);
            this._panelHoverId = 0;
        }

        const panelBox = PanelAdapter.panelBox;
        if (this._panelVisibleId && panelBox) {
            panelBox.disconnect(this._panelVisibleId);
            this._panelVisibleId = 0;
        }
        if (panelBox) {
            panelBox.remove_all_transitions();
            panelBox.translation_y = 0;
        }

        if (this._panel)
            this._panel.track_hover = this._panelTrackHover;

        if (this._edge) {
            Main.layoutManager.removeChrome(this._edge);
            this._edge.destroy();
            this._edge = null;
        }

        // Recreate the visibility decision that trackFullscreen would make at
        // this instant, because no fullscreen signal is guaranteed on disable.
        if (panelBox) {
            if (this._isPrimaryFullscreen() &&
                !Main.overview.visible && global.window_group.visible)
                panelBox.hide();
            else if (!this._isPrimaryFullscreen() || Main.overview.visible)
                panelBox.show();
        }

        this._revealed = false;
        this._panel = null;
        this._settings = null;
        this._extension = null;
        this._onReveal = null;
        this._isEngaged = null;
    }
}
