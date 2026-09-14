// PanelAdapter — the ONLY module allowed to touch private GNOME Panel fields.
//
// Everything version-fragile (Main.panel._leftBox / _centerBox / _rightBox,
// statusArea role names, indicator.container) is funnelled through here so that
// a GNOME 51/52 break is a one-file fix rather than a rewrite. See
// docs/ARCHITECTURE.md §Compatibility layer.
//
// Verified against GNOME Shell 50 (js/ui/panel.js, js/ui/panelMenu.js). The
// private box fields (_leftBox/_centerBox/_rightBox) have been stable since
// GNOME 3.x; PanelMenu.Button has exposed `.container` for just as long.

import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Known statusArea roles we care about (js/ui/panel.js PANEL_ITEM_IMPLEMENTATIONS
// + sessionMode.js panel layout). Kept here so callers never hard-code strings.
export const Roles = Object.freeze({
    ACTIVITIES: 'activities',
    DATE_MENU: 'dateMenu',
    QUICK_SETTINGS: 'quickSettings',
    KEYBOARD: 'keyboard',
    A11Y: 'a11y',
    DWELL_CLICK: 'dwellClick',
    SCREEN_RECORDING: 'screenRecording',
    SCREEN_SHARING: 'screenSharing',
});

// The private fields on the `quickSettings` indicator that hold GNOME's OWN
// SystemIndicators inside `quickSettings._indicators`. Verified against GNOME
// Shell 50.4 (js/ui/panel.js QuickSettings._setupIndicators). Anything in that
// box which is NOT one of these was parented there by another extension via
// QuickSettings.addExternalIndicator(), so this list is how we tell "ours to
// hide" from "somebody else's, hands off".
const NATIVE_QS_INDICATOR_FIELDS = Object.freeze([
    // privacy indicators, inserted first by _setupIndicators()
    '_remoteAccess', '_camera', '_volumeInput', '_location',
    // everything else, in _setupIndicators() order
    '_brightness', '_thunderbolt', '_nightLight', '_network', '_darkMode',
    '_doNotDisturb', '_backlight', '_bluetooth', '_rfkill', '_autoRotate',
    '_volumeOutput', '_unsafeMode', '_powerProfiles', '_system',
    // grid-only today, listed so it can never be mistaken for a third party
    '_backgroundApps',
]);

export const PanelAdapter = {
    get panel() {
        return Main.panel;
    },

    get actor() {
        // The Panel is itself an St.Widget.
        return Main.panel;
    },

    /** The native chrome container whose visibility tracks fullscreen. */
    get panelBox() {
        return Main.layoutManager?.panelBox ?? null;
    },

    // --- The three layout boxes (St.BoxLayout). Private fields, isolated here. ---
    get leftBox() {
        return Main.panel?._leftBox ?? null;
    },

    get centerBox() {
        return Main.panel?._centerBox ?? null;
    },

    get rightBox() {
        return Main.panel?._rightBox ?? null;
    },

    /** Ordered list of the layout boxes, left→center→right. */
    get boxes() {
        return [this.leftBox, this.centerBox, this.rightBox].filter(b => b != null);
    },

    // --- statusArea indicator lookup ---
    get statusArea() {
        return Main.panel?.statusArea ?? {};
    },

    /**
     * Look up a panel indicator (PanelMenu.Button subclass) by role.
     * Returns null when the current session mode doesn't provide it.
     */
    getIndicator(role) {
        return this.statusArea?.[role] ?? null;
    },

    get dateMenu() {
        return this.getIndicator(Roles.DATE_MENU);
    },

    /** Native PanelMenu gesture that normally toggles the combined date menu. */
    get dateMenuClickGesture() {
        return this.dateMenu?._clickGesture ?? null;
    },

    get activities() {
        return this.getIndicator(Roles.ACTIVITIES);
    },

    get quickSettings() {
        return this.getIndicator(Roles.QUICK_SETTINGS);
    },

    /**
     * The actor a panel indicator is actually parented by inside a box.
     * PanelMenu.Button wraps itself in `.container`; Main.panel adds the
     * container (not the button) to _leftBox/_centerBox/_rightBox.
     */
    containerOf(indicator) {
        return indicator?.container ?? indicator ?? null;
    },

    // --- Quick Settings indicator box (js/ui/quickSettings.js) --------------

    /**
     * The St.BoxLayout inside the `quickSettings` button that carries every
     * status icon — GNOME's own and, via addExternalIndicator(), other
     * extensions'. Private field, isolated here.
     */
    get quickSettingsIndicatorBox() {
        return this.quickSettings?._indicators ?? null;
    },

    /** The set of SystemIndicators GNOME itself put in that box. */
    nativeQuickSettingsIndicators() {
        const natives = new Set();
        const qs = this.quickSettings;
        if (!qs)
            return natives;
        for (const field of NATIVE_QS_INDICATOR_FIELDS) {
            const indicator = qs[field];
            if (indicator)
                natives.add(indicator);
        }
        return natives;
    },

    isNativeQuickSettingsIndicator(actor) {
        return this.nativeQuickSettingsIndicators().has(actor);
    },

    closeNativeDateMenu() {
        try {
            this.dateMenu?.menu?.close();
        } catch (_e) {
            // The panel can disappear during a session-mode transition.
        }
    },

    /**
     * MessageTray.bannerBlocked is setter-only in Shell 50 (js/ui/messageTray.js);
     * its current value lives in the private `_bannerBlocked`. Returns null when
     * that field is gone, so callers skip restoring a value they never read.
     */
    get messageTrayBannerBlocked() {
        const value = Main.messageTray?._bannerBlocked;
        return typeof value === 'boolean' ? value : null;
    },

    closeActiveMenu() {
        try {
            Main.panel?.menuManager?.activeMenu?.close();
        } catch (_e) {
            // A menu may already be tearing down.
        }
    },

    /**
     * Redirect the Shell's Super+V calendar handlers while the replacement
     * Notification Center is installed, then restore the exact original
     * methods. Keep this version-fragile Panel mutation in the adapter.
     */
    overrideCalendarHandlers(toggle, close) {
        const panel = this.panel;
        if (!panel)
            return null;

        const originalToggle = panel.toggleCalendar;
        const originalClose = panel.closeCalendar;
        const replacementToggle = () => toggle();
        const replacementClose = () => close();
        panel.toggleCalendar = replacementToggle;
        panel.closeCalendar = replacementClose;

        let restored = false;
        return {
            restore() {
                if (restored)
                    return;
                restored = true;
                if (panel.toggleCalendar === replacementToggle)
                    panel.toggleCalendar = originalToggle;
                if (panel.closeCalendar === replacementClose)
                    panel.closeCalendar = originalClose;
            },
        };
    },

    /** Everything in that box which another extension added. */
    externalQuickSettingsIndicators() {
        const box = this.quickSettingsIndicatorBox;
        if (!box)
            return [];
        const natives = this.nativeQuickSettingsIndicators();
        return box.get_children().filter(child => !natives.has(child));
    },

    // --- Quick Settings menu grid (js/ui/quickSettings.js) ------------------

    /**
     * The St.Widget holding every Quick Settings tile. Its layout manager is a
     * QuickSettingsLayout, and its FIRST child is a bare Clutter.Actor
     * placeholder that reserves height for an open sub-page — never a tile,
     * which is why the filters below keep St.Widgets only.
     */
    get quickSettingsGrid() {
        return this.quickSettings?.menu?._grid ?? null;
    },

    /** The set of tiles GNOME's own indicators contributed to that grid. */
    nativeQuickSettingsItems() {
        const items = new Set();
        for (const indicator of this.nativeQuickSettingsIndicators()) {
            for (const item of indicator.quickSettingsItems ?? [])
                items.add(item);
        }
        return items;
    },

    /**
     * Every tile another extension put in the grid — whether it came through
     * addExternalIndicator() or a direct menu.addItem() call.
     */
    externalQuickSettingsItems() {
        const grid = this.quickSettingsGrid;
        if (!grid)
            return [];
        const natives = this.nativeQuickSettingsItems();
        return grid.get_children().filter(
            child => child instanceof St.Widget && !natives.has(child));
    },

    /**
     * Re-run a SystemIndicator's own visibility rule — visible iff one of its
     * icons is (js/ui/quickSettings.js SystemIndicator._syncIndicatorsVisible).
     * Used to hand an indicator back to GNOME after we forced it hidden, so the
     * restored state is the one GNOME would compute now, not a stale snapshot.
     */
    resyncIndicatorVisibility(indicator) {
        if (!indicator)
            return;
        try {
            if (typeof indicator._syncIndicatorsVisible === 'function')
                indicator._syncIndicatorsVisible();
            else
                indicator.visible = indicator.get_children().some(c => c.visible);
        } catch (_e) {
            // Disposed actor: nothing left to restore.
        }
    },

    /**
     * Register one of our own indicators. Panel.addToStatusArea inserts
     * indicator.container at `position` in `box` ('left'|'center'|'right') and
     * self-cleans this.statusArea[role] when the indicator is destroyed, so
     * teardown is just indicator.destroy(). Verified against gnome-50 panel.js.
     */
    addToStatusArea(role, indicator, position = 0, box = 'left') {
        return Main.panel.addToStatusArea(role, indicator, position, box);
    },
};
