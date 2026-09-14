// SPDX-License-Identifier: GPL-2.0-or-later
//
// FullscreenReveal — macOS-style access to the panel from a fullscreen app.
//
// GNOME tracks LayoutManager.panelBox with `trackFullscreen`, so the box is
// normally hidden while a fullscreen window is present on the primary monitor.
// We keep that native resting state and add a deliberate trigger on the top
// edge: a pressure barrier, the same mechanism as GNOME's hot corner, so the
// pointer has to push up against the edge rather than merely touch it.  Merely
// reaching the top row happens all the time in fullscreen browsers, editors and
// video players, and must not cover their UI.  Only when another monitor sits
// directly above (a barrier would impede crossing to it) do we fall back to a
// one-pixel, non-strut edge that reveals after the pointer dwells on it.
//
// The reveal shows the existing panel as an overlay; leaving the panel hides it
// again once no panel popup is open.  We never replace the panel or change its
// chrome tracking/struts, and destroy() restores the visibility that GNOME
// would currently choose.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PanelAdapter} from './compat/panelAdapter.js';

const EDGE_HEIGHT = 1;
// Matches GNOME's hot corner (HOT_CORNER_PRESSURE_THRESHOLD/_TIMEOUT).
const PRESSURE_THRESHOLD = 100;
const PRESSURE_TIMEOUT_MS = 1000;
const EDGE_DWELL_MS = 500;
const REVEAL_DURATION_MS = 160;
const HIDE_DURATION_MS = 140;
const INITIAL_HIDE_DELAY_MS = 650;
const HIDE_DELAY_MS = 280;
const BUTTON_MASK = Clutter.ModifierType.BUTTON1_MASK |
    Clutter.ModifierType.BUTTON2_MASK | Clutter.ModifierType.BUTTON3_MASK;

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
        this._dwellId = 0;
        this._edge = null;
        this._pressureBarrier = null;
        this._barrier = null;
        this._barrierKey = '';
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

        this._pressureBarrier = new Layout.PressureBarrier(
            PRESSURE_THRESHOLD, PRESSURE_TIMEOUT_MS, Shell.ActionMode.NORMAL);
        // Dragging (a selection, a scrollbar, a game's mouselook) into the
        // edge is not a request for the panel.
        this._pressureBarrier.setEventFilter(() => this._pointerButtonHeld());
        this._pressureBarrier.connect('trigger', () => this._reveal());

        this._edge = new St.Widget({
            name: 'lintel-fullscreen-edge',
            reactive: true,
            track_hover: true,
            visible: false,
        });
        this._edge.connect('enter-event', () => {
            this._startDwell();
            return Clutter.EVENT_PROPAGATE;
        });
        this._edge.connect('leave-event', () => {
            this._cancelDwell();
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

    _pointerButtonHeld() {
        const [, , mods] = global.get_pointer();
        return (mods & BUTTON_MASK) !== 0;
    }

    _hasMonitorAbove(monitor) {
        return Main.layoutManager.monitors.some(other =>
            other !== monitor &&
            other.y + other.height === monitor.y &&
            other.x < monitor.x + monitor.width &&
            other.x + other.width > monitor.x);
    }

    _armTrigger() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) {
            this._disarmTrigger();
            return;
        }

        if (!this._hasMonitorAbove(monitor) && this._ensureBarrier(monitor)) {
            this._hideEdge();
            return;
        }

        this._destroyBarrier();
        // While revealed the edge would sit over the panel's top row.
        if (this._revealed || !this._edge) {
            this._hideEdge();
            return;
        }
        this._edge.set_position(monitor.x, monitor.y);
        this._edge.set_size(monitor.width, EDGE_HEIGHT);
        this._edge.show();
    }

    _disarmTrigger() {
        this._destroyBarrier();
        this._hideEdge();
    }

    _ensureBarrier(monitor) {
        if (!this._pressureBarrier)
            return false;

        const key = `${monitor.x},${monitor.y},${monitor.width}`;
        if (this._barrier && this._barrierKey === key)
            return true;

        this._destroyBarrier();
        try {
            this._barrier = new Meta.Barrier({
                backend: global.backend,
                x1: monitor.x, y1: monitor.y,
                x2: monitor.x + monitor.width, y2: monitor.y,
                directions: Meta.BarrierDirection.POSITIVE_Y,
            });
        } catch (e) {
            logError(e, 'lintel: fullscreen reveal barrier');
            this._barrier = null;
            return false;
        }
        this._pressureBarrier.addBarrier(this._barrier);
        this._barrierKey = key;
        return true;
    }

    _destroyBarrier() {
        if (!this._barrier)
            return;
        this._pressureBarrier?.removeBarrier(this._barrier);
        this._barrier.destroy();
        this._barrier = null;
        this._barrierKey = '';
    }

    _hideEdge() {
        this._cancelDwell();
        this._edge?.hide();
    }

    _startDwell() {
        this._cancelDwell();
        this._dwellId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EDGE_DWELL_MS, () => {
            this._dwellId = 0;
            if (this._edge?.hover && !this._pointerButtonHeld())
                this._reveal();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelDwell() {
        if (!this._dwellId)
            return;
        GLib.Source.remove(this._dwellId);
        this._dwellId = 0;
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

        if (this._shouldHandleFullscreen()) {
            this._armTrigger();
            return;
        }

        this._cancelHide();
        this._revealed = false;
        this._disarmTrigger();

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
        this._hideEdge();
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
                    this._armTrigger();
            },
        });
    }

    destroy() {
        if (!this._enabled)
            return;
        this._enabled = false;
        this._cancelHide();
        this._cancelDwell();

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

        // Remove the barrier before destroying its PressureBarrier, which
        // would otherwise splice the wrong entry out of its list.
        this._destroyBarrier();
        this._pressureBarrier?.destroy();
        this._pressureBarrier = null;

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
