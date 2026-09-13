// SPDX-License-Identifier: GPL-2.0-or-later
//
// QuickSettingsBridge — a read/drive model of OTHER extensions' Quick Settings
// tiles, so our Control Center can offer them without embedding their actors.
//
// We deliberately mirror rather than adopt. `src/widgets/ccTile.js` already
// explains why this popup does not host GNOME Quick Settings widgets (their
// layout changes between Shell releases); a third-party QuickToggle brings the
// same problem plus two of its own: a QuickMenuToggle's sub-page actor lives in
// the QS menu's private `_overlay`, constrained to the QS grid, and extensions
// reach back into the grid on disable. Reparenting their tiles would therefore
// break both their sub-pages and their teardown. Instead this service reads
// their public GObject properties (title/subtitle/gicon/checked) and drives
// them the way St.Button does, leaving every actor exactly where its owner put
// it. Their sub-pages stay reachable through the stripped Quick Settings button
// that `src/externalIndicators.js` keeps in the menu bar.
//
// Verified against GNOME Shell 50.4: QuickSettingsItem extends St.Button and
// gains `.menu` when constructed with `hasMenu`; QuickToggle adds the
// title/subtitle/gicon properties; QuickSlider is a non-reactive item and is
// skipped, since a capsule cannot represent a slider.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {PanelAdapter} from '../compat/panelAdapter.js';

// Properties that change what our capsule shows.
const WATCHED_PROPERTIES = [
    'notify::title',
    'notify::subtitle',
    'notify::checked',
    'notify::gicon',
    'notify::icon-name',
    'notify::visible',
    'notify::reactive',
];

/**
 * Whether a third-party Quick Settings tile is one we can put in our popup.
 * QuickSlider is a non-reactive, title-less item — a capsule cannot stand in for
 * a slider — and neither can it for a bare custom widget. Exported because
 * src/externalIndicators.js decides whether the native Quick Settings button is
 * still needed as an escape hatch by exactly this question.
 */
export function isRepresentableQuickSettingsItem(item) {
    return item instanceof St.Button && item.reactive && 'title' in item;
}

export const QuickSettingsBridge = GObject.registerClass({
    Signals: {'changed': {}},
}, class QuickSettingsBridge extends GObject.Object {
    _init() {
        super._init();
        this._grid = null;
        this._gridIds = [];
        this._items = new Map(); // item -> [handler id, ...]
        this._changedId = 0;
        this._enabled = false;
    }

    /** Start tracking. Idempotent. */
    enable() {
        this._enabled = true;
        this._attach();
    }

    /**
     * Third-party tiles we can represent, in grid order. Items are only ever
     * read from here — the list is rebuilt from the live grid so a tile that
     * was destroyed behind our back cannot linger.
     */
    get items() {
        if (!this._enabled)
            return [];
        return PanelAdapter.externalQuickSettingsItems().filter(
            item => this._isRepresentable(item));
    }

    /**
     * Drive a third-party tile exactly as a real click would: St.Button flips
     * `checked` itself before emitting `clicked` when toggle-mode is on, so a
     * synthesised activation has to do the same or handlers read a stale state.
     */
    activate(item) {
        if (!item || !this._isRepresentable(item))
            return;
        try {
            if (item.toggle_mode)
                item.checked = !item.checked;
            item.emit('clicked', 0);
        } catch (e) {
            logError(e, 'lintel: activate third-party quick settings item');
        }
    }

    /** Whether this tile has a sub-page only native Quick Settings can show. */
    hasMenu(item) {
        return !!item?.menu;
    }

    destroy() {
        this._enabled = false;
        if (this._changedId) {
            GLib.Source.remove(this._changedId);
            this._changedId = 0;
        }
        for (const [item, ids] of this._items) {
            for (const id of ids)
                this._disconnect(item, id);
        }
        this._items.clear();
        if (this._grid) {
            for (const id of this._gridIds)
                this._disconnect(this._grid, id);
        }
        this._gridIds = [];
        this._grid = null;
    }

    // ---- Tracking -----------------------------------------------------------

    _attach() {
        const grid = PanelAdapter.quickSettingsGrid;
        if (!grid)
            return; // No Quick Settings in this session mode.

        if (this._grid && this._grid !== grid) {
            // Quick Settings was rebuilt under us; drop the stale bookkeeping.
            const stale = this._enabled;
            this.destroy();
            this._enabled = stale;
        }

        if (!this._grid) {
            this._grid = grid;
            this._gridIds.push(grid.connect(
                'child-added', (_g, child) => this._onChildAdded(child)));
            this._gridIds.push(grid.connect(
                'child-removed', (_g, child) => this._onChildRemoved(child)));
        }

        for (const item of PanelAdapter.externalQuickSettingsItems())
            this._watch(item);

        this._queueChanged();
    }

    _watch(item) {
        if (this._items.has(item) || !this._isRepresentable(item))
            return;
        const ids = WATCHED_PROPERTIES.map(
            signal => item.connect(signal, () => this._queueChanged()));
        this._items.set(item, ids);
    }

    _onChildAdded(child) {
        if (!this._enabled)
            return;
        this._watch(child);
        this._queueChanged();
    }

    _onChildRemoved(child) {
        if (!this._enabled)
            return;
        const ids = this._items.get(child);
        if (ids) {
            this._items.delete(child);
            for (const id of ids)
                this._disconnect(child, id);
        }
        this._queueChanged();
    }

    _isRepresentable(item) {
        return isRepresentableQuickSettingsItem(item);
    }

    _disconnect(object, id) {
        try {
            object.disconnect(id);
        } catch (_e) {
            // Already disposed; its handlers went with it.
        }
    }

    _queueChanged() {
        if (this._changedId)
            return;
        this._changedId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._changedId = 0;
            if (this._enabled)
                this.emit('changed');
            return GLib.SOURCE_REMOVE;
        });
    }
});
