// NotificationAlignment — Stage 2.
//
// When the clock (dateMenu) moves to the far right, notification banners must
// follow it, otherwise they keep popping up centered while the clock — the thing
// they visually belong to — is on the right. macOS shows notifications top-right.
//
// Mechanism (verified against gnome-shell gnome-50, js/ui/messageTray.js):
//   Main.messageTray.bannerAlignment  ->  this._bannerBin.x_align
//   default Clutter.ActorAlign.CENTER
// So aligning banners right is `bannerAlignment = Clutter.ActorAlign.END`.
//
// Capture/apply/restore mirrors PanelSnapshot: we remember the pristine value
// once and put it back verbatim on disable, and apply() is idempotent so it is
// safe to re-run on every sessionMode re-assert.

import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class NotificationAlignment {
    constructor() {
        this._original = null;
        this._captured = false;
    }

    static get _tray() {
        return Main.messageTray ?? null;
    }

    /** Remember the pristine banner alignment (once, before any mutation). */
    capture() {
        const tray = NotificationAlignment._tray;
        if (!tray)
            return;
        try {
            this._original = tray.bannerAlignment;
            this._captured = true;
        } catch (_e) {
            // Property missing on this Shell version — degrade gracefully.
            this._captured = false;
        }
    }

    /** Align banners to the given edge (default: right, to match the clock). */
    apply(align = Clutter.ActorAlign.END) {
        const tray = NotificationAlignment._tray;
        if (!tray)
            return;
        try {
            if (tray.bannerAlignment !== align)
                tray.bannerAlignment = align;
        } catch (_e) {
            // Non-fatal: banner positioning is cosmetic.
        }
    }

    /** Put the original alignment back. No-op if we never captured one. */
    restore() {
        if (!this._captured)
            return;
        const tray = NotificationAlignment._tray;
        if (!tray)
            return;
        try {
            tray.bannerAlignment = this._original;
        } catch (_e) {
            // Non-fatal.
        }
    }

    destroy() {
        this._captured = false;
        this._original = null;
    }
}
