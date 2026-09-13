// SPDX-License-Identifier: GPL-2.0-or-later
//
// ExternalIndicators — keeps OTHER extensions' Quick Settings items reachable
// while our custom Control Center is active.
//
// Extensions such as Caffeine do not call Main.panel.addToStatusArea(); they
// call QuickSettings.addExternalIndicator(), which parents their SystemIndicator
// inside the `quickSettings` button (quickSettings._indicators) and their tiles
// in the QS menu grid. Hiding that whole container therefore hid their icon AND
// — because Panel._toggleMenu() bails out on an unmapped indicator — turned
// Main.panel.toggleQuickSettings() into a no-op, leaving their toggles with no
// way in at all.
//
// So we strip the button instead of hiding it: GNOME's own indicators are forced
// hidden one by one, third-party ones are left alone, and the button is shown
// only while at least one of them is visible. The result is a Tahoe-styled group
// of third-party glyphs in the menu bar whose click still opens native Quick
// Settings — but only when it is still needed. Our Control Center now carries
// third-party toggles itself (services/quickSettingsBridge.js and
// services/extensionAdapters.js), so the button survives only while some
// third-party tile exists that our popup cannot represent — a QuickSlider, a
// bare custom widget. With everything covered it goes away, and the third-party
// glyphs inside it go with it, which is the point: their control lives in the
// Control Center now.
//
// Two deliberate non-moves:
//   • We never REPARENT a third-party indicator. Caffeine re-orders itself with
//     quickSettings._indicators.remove_child(this); if we had adopted the actor
//     that call would hit the wrong parent and raise a Clutter critical.
//   • We never touch a third-party actor at all — not its parent, not its
//     signals, not its visibility. Only GNOME's own indicators are driven, and
//     their hiding is re-asserted from `notify::visible`, because
//     SystemIndicator recomputes its own `visible` whenever one of its icons
//     changes and would undo a one-shot hide().

import GLib from 'gi://GLib';

import {PanelAdapter} from './compat/panelAdapter.js';
import {isRepresentableQuickSettingsItem} from './services/quickSettingsBridge.js';

export class ExternalIndicators {
    constructor() {
        this._active = false;
        this._box = null;
        this._boxIds = [];
        this._hidden = new Map();  // native indicator -> notify::visible id
        this._grid = null;
        this._gridIds = [];
        this._syncId = 0;
    }

    /**
     * Custom Control Center mode: hide GNOME's indicators, keep third-party
     * ones. Idempotent — safe to re-run on every applyLintelLayout().
     */
    apply() {
        const box = PanelAdapter.quickSettingsIndicatorBox;
        if (!box)
            return;

        // A rebuilt Quick Settings means our bookkeeping points at dead actors.
        if (this._box && this._box !== box)
            this._teardown();

        if (!this._active) {
            this._box = box;
            this._boxIds.push(box.connect(
                'child-added', (_b, child) => this._onChildAdded(child)));
            this._boxIds.push(box.connect(
                'child-removed', (_b, child) => this._onChildRemoved(child)));
            this._active = true;
        }

        // QuickSettings._setupIndicators() is async and extensions enable at any
        // time, so the box may still be empty here; 'child-added' covers the
        // rest.
        for (const child of box.get_children())
            this._track(child);

        this._attachGrid();
        this._sync();
    }

    /**
     * Native Control Center mode (and teardown): give GNOME its indicators back
     * and make the button fully visible again, so Panel._toggleMenu() can reach
     * it.
     */
    release() {
        this._teardown();
        const container = PanelAdapter.containerOf(PanelAdapter.quickSettings);
        if (container && !container.visible)
            container.show();
    }

    destroy() {
        this.release();
    }

    /**
     * Whether the button is still needed is decided by the TILES in the menu
     * grid, not by the glyphs in the indicator box, so watch that too.
     */
    _attachGrid() {
        const grid = PanelAdapter.quickSettingsGrid;
        if (!grid || grid === this._grid)
            return;

        if (this._grid) {
            for (const id of this._gridIds)
                this._disconnect(this._grid, id);
            this._gridIds = [];
        }

        this._grid = grid;
        this._gridIds.push(grid.connect('child-added', () => this._queueSync()));
        this._gridIds.push(grid.connect('child-removed', () => this._queueSync()));
    }

    // ---- Per-child bookkeeping ----------------------------------------------

    /**
     * GNOME's own indicators get hidden; a third-party one is left exactly as
     * its owner put it — untouched parent, untouched signals, untouched
     * visibility.
     */
    _track(child) {
        if (PanelAdapter.isNativeQuickSettingsIndicator(child))
            this._hideNative(child);
    }

    _hideNative(actor) {
        if (this._hidden.has(actor))
            return;
        // Re-hide rather than hide once: SystemIndicator._syncIndicatorsVisible()
        // re-asserts `visible` from its icons on every icon change. The guard
        // keeps this from recursing through our own assignment.
        const id = actor.connect('notify::visible', () => {
            if (actor.visible)
                actor.visible = false;
        });
        this._hidden.set(actor, id);
        actor.visible = false;
    }

    _onChildAdded(child) {
        if (!this._active)
            return;
        this._track(child);
        this._queueSync();
    }

    _onChildRemoved(child) {
        if (!this._active)
            return;
        // Caffeine reorders itself by remove_child + insert_child_at_index, so a
        // removal is not necessarily a death; 'child-added' re-tracks it.
        this._untrackHidden(child);
        this._queueSync();
    }

    _untrackHidden(actor) {
        const id = this._hidden.get(actor);
        if (id === undefined)
            return;
        this._hidden.delete(actor);
        this._disconnect(actor, id);
        // It left our control: hand its visibility back to GNOME's own rule.
        PanelAdapter.resyncIndicatorVisibility(actor);
    }

    _disconnect(actor, id) {
        try {
            actor.disconnect(id);
        } catch (_e) {
            // Actor already disposed; its handlers went with it.
        }
    }

    // ---- Button visibility ---------------------------------------------------

    _queueSync() {
        if (this._syncId)
            return;
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._syncId = 0;
            if (this._active)
                this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Keep the stripped Quick Settings button only as an escape hatch: it stays
     * exactly while some third-party tile exists that our Control Center cannot
     * represent. Once everything is covered — as it is for a plain toggle like
     * Caffeine's — the button and the third-party glyphs inside it are hidden,
     * because their control has moved into our popup.
     */
    _sync() {
        const container = PanelAdapter.containerOf(PanelAdapter.quickSettings);
        if (!container)
            return;

        // Read the live grid rather than our bookkeeping, so a coalesced sync
        // always reflects the state as it is now.
        const wanted = PanelAdapter.externalQuickSettingsItems().some(
            item => !isRepresentableQuickSettingsItem(item));

        if (container.visible !== wanted)
            container.visible = wanted;
    }

    // ---- Teardown ------------------------------------------------------------

    _teardown() {
        if (this._syncId) {
            GLib.Source.remove(this._syncId);
            this._syncId = 0;
        }

        for (const [actor, id] of this._hidden) {
            this._disconnect(actor, id);
            PanelAdapter.resyncIndicatorVisibility(actor);
        }
        this._hidden.clear();

        if (this._box) {
            for (const id of this._boxIds)
                this._disconnect(this._box, id);
        }
        this._boxIds = [];
        this._box = null;

        if (this._grid) {
            for (const id of this._gridIds)
                this._disconnect(this._grid, id);
        }
        this._gridIds = [];
        this._grid = null;

        this._active = false;
    }
}
