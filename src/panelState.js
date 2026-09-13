// PanelSnapshot — an immutable, pristine capture of the native top bar layout,
// taken once before any Lintel mutation and used to restore GNOME *exactly* as it
// was (Criterion #2). We snapshot at the box level (the ordered child actors of
// _leftBox/_centerBox/_rightBox plus their visibility) rather than per-indicator
// index math, because that survives reparenting between boxes and is robust to
// third-party items appearing while we're enabled.
//
// Note on lifetime: GNOME reuses indicator instances across sessionMode changes
// (Panel._updatePanel re-adds existing statusArea entries), so the actor
// references captured here stay valid across lock/unlock. We still guard every
// access with _isAlive() in case an actor was disposed.

import {PanelAdapter} from './compat/panelAdapter.js';

function _isAlive(actor) {
    if (!actor)
        return false;
    try {
        // Touching any property on a disposed GObject throws.
        void actor.visible;
        return true;
    } catch (_e) {
        return false;
    }
}

export class PanelSnapshot {
    constructor() {
        // box actor -> { children: [actor...], visible: Map<actor, bool> }
        this._boxes = new Map();
        // Extra style classes we may want to remember on the panel actor.
        this._panelStyleClasses = null;
    }

    /** Capture the current, pristine state of all three panel boxes. */
    static capture() {
        const snap = new PanelSnapshot();
        for (const box of PanelAdapter.boxes) {
            if (!_isAlive(box))
                continue;
            const children = box.get_children();
            const visible = new Map();
            for (const child of children) {
                if (_isAlive(child))
                    visible.set(child, child.visible);
            }
            snap._boxes.set(box, {children, visible});
        }

        const panel = PanelAdapter.actor;
        if (_isAlive(panel)) {
            try {
                snap._panelStyleClasses = panel.get_style_class_name();
            } catch (_e) {
                snap._panelStyleClasses = null;
            }
        }
        return snap;
    }

    /**
     * Restore every captured box to its recorded child order and visibility,
     * reparenting any actor that has since moved to a different box.
     */
    restore() {
        for (const [box, state] of this._boxes) {
            if (!_isAlive(box))
                continue;

            const {children, visible} = state;
            children.forEach((child, idx) => {
                if (!_isAlive(child))
                    return;

                const currentParent = child.get_parent();
                if (currentParent !== box) {
                    currentParent?.remove_child(child);
                    const at = Math.min(idx, box.get_n_children());
                    box.insert_child_at_index(child, at);
                } else {
                    const at = Math.min(idx, box.get_n_children() - 1);
                    box.set_child_at_index(child, at);
                }

                if (visible.has(child))
                    child.visible = visible.get(child);
            });
        }

        const panel = PanelAdapter.actor;
        if (this._panelStyleClasses !== null && _isAlive(panel)) {
            try {
                panel.set_style_class_name(this._panelStyleClasses);
            } catch (_e) {
                // Non-fatal: styling is cosmetic.
            }
        }
    }

    destroy() {
        this._boxes.clear();
        this._panelStyleClasses = null;
    }
}
