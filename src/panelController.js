// PanelController — Stage 1 core (see docs/ARCHITECTURE.md).
//
// Responsibilities in this stage:
//   • captureOriginalState()  — snapshot the pristine top bar once, up front.
//   • applyLintelLayout()        — idempotent macOS-style layout mutation. For the
//                               skeleton this is limited to the two changes that
//                               prove the framework: hide Activities, move the
//                               clock (dateMenu) to the far right. Widgets come
//                               in later stages.
//   • restoreOriginalState()  — put GNOME back exactly as it was.
//   • handleSessionMode()     — GNOME rebuilds the panel on sessionMode changes;
//                               re-assert our layout afterwards, idempotently.
//   • destroy()               — full teardown: no leaked signals/timeouts/actors.
//
// Everything that touches private Shell internals goes through PanelAdapter.

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PanelAdapter} from './compat/panelAdapter.js';
import {PanelSnapshot} from './panelState.js';
import {NotificationAlignment} from './notificationAlignment.js';
import {ExternalIndicators} from './externalIndicators.js';
import {LintelSystemMenu} from './widgets/systemMenu.js';
import {ActiveApp} from './widgets/activeApp.js';
import {ControlCenter} from './widgets/controlCenter.js';
import {LintelWifiMenu} from './widgets/wifiMenu.js';
import {LintelBatteryMenu} from './widgets/batteryMenu.js';
import {LintelClock} from './widgets/clock.js';
import {LintelNotificationCenter} from './widgets/notificationCenter.js';
import {ThemeManager} from './theme.js';
import {FullscreenReveal} from './fullscreenReveal.js';
import {shutdownSystemStats} from './services/systemStats.js';
import {shutdownWeather} from './services/weather.js';

const PANEL_STYLE_CLASS = 'lintel';
const SYSTEM_MENU_ROLE = 'lintel-system-menu';
const ACTIVE_APP_ROLE = 'lintel-active-app';
const WIFI_ROLE = 'lintel-wifi';
const BATTERY_ROLE = 'lintel-battery';
const CONTROL_CENTER_ROLE = 'lintel-control-center';
const CLOCK_STYLE_CLASS = 'lintel-clock-button';

// Keys that change the *structure* of the panel (which widgets exist, where the
// clock and Activities sit). Appearance/clock-format/tunable keys are watched
// live by ThemeManager and LintelClock, so they are intentionally NOT listed here.
const STRUCTURAL_KEYS = new Set([
    'hide-activities',
    'clock-on-right',
    'show-system-menu',
    'system-menu-icon',
    'show-active-app',
    'empty-app-label',
    'control-center-mode',
    'notification-center-enabled',
]);

export class PanelController {
    constructor(extension) {
        this._extension = extension;
        this._snapshot = null;
        this._notifications = new NotificationAlignment();
        this._externalIndicators = new ExternalIndicators();
        this._clock = new LintelClock(extension);
        this._theme = new ThemeManager(extension);
        this._fullscreenReveal = new FullscreenReveal(
            extension,
            () => this._theme.requestContrastUpdate(0),
            () => this._notificationCenter?.isOpen ?? false);
        this._notificationCenter = null;
        this._systemMenu = null;
        this._activeApp = null;
        this._wifiMenu = null;
        this._batteryMenu = null;
        this._controlCenter = null;
        this._settings = null;
        this._settingsChangedId = 0;
        this._clockHome = null; // pristine placement of the dateMenu container.
        this._sessionModeId = 0;
        this._monitorsId = 0;
        this._reapplyId = 0; // GLib idle source id, coalesced.
        this._enabled = false;
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;

        // 1. Snapshot the pristine layout BEFORE any mutation.
        this.captureOriginalState();

        // 2. Apply our layout.
        this.applyLintelLayout();

        // 3. Re-assert after GNOME rebuilds the panel on session changes, and
        // after monitor hotplug / resolution / fractional-scale changes (which
        // reallocate the panel). Both funnel through the same coalesced idle.
        this._sessionModeId = Main.sessionMode.connect(
            'updated', () => this._queueReapply());
        this._monitorsId = Main.layoutManager.connect(
            'monitors-changed', () => this._queueReapply());

        // 4. React to structural settings changes live (from prefs).
        try {
            this._settings = this._extension?.getSettings?.() ?? null;
        } catch (_e) {
            this._settings = null;
        }
        if (this._settings) {
            this._settingsChangedId = this._settings.connect(
                'changed', (_s, key) => this._onSettingsChanged(key));
        }
    }

    // ---- Stage 1: capture / apply / restore ---------------------------------

    captureOriginalState() {
        this._snapshot = PanelSnapshot.capture();
        this._notifications.capture();

        // Remember exactly where the clock lived so `clock-on-right = false` can
        // put it back precisely, not just "somewhere in the center".
        const container = PanelAdapter.containerOf(PanelAdapter.dateMenu);
        const parent = container?.get_parent() ?? null;
        this._clockHome = container && parent
            ? {container, parent, index: parent.get_children().indexOf(container)}
            : null;
    }

    applyLintelLayout() {
        if (!this._enabled)
            return;

        const panel = PanelAdapter.actor;
        if (panel && !panel.has_style_class_name(PANEL_STYLE_CLASS))
            panel.add_style_class_name(PANEL_STYLE_CLASS);

        this._addSystemMenu();
        this._addActiveApp();
        this._ensureLeftOrder();
        this._applyActivitiesVisibility();
        this._addControlCenter();
        this._addStatusMenus();
        this._applyQuickSettingsVisibility();
        this._applyClockPosition();
        this._positionRightControls();

        // Re-format the clock text (idempotent — no-op once active).
        this._clock.enable();

        // Replace the native combined date menu with Tahoe's free-floating
        // notifications and widget column. The clock actor itself stays native.
        this._addNotificationCenter();

        // Tahoe appearance / dynamic stylesheet (idempotent).
        this._theme.enable();

        // Reveal the native panel on the top edge of a fullscreen app.
        this._fullscreenReveal.enable();

        // Notifications follow the clock to the right edge (macOS-style).
        this._notifications.apply();
    }

    restoreOriginalState() {
        const panel = PanelAdapter.actor;
        if (panel)
            panel.remove_style_class_name(PANEL_STYLE_CLASS);
        PanelAdapter.dateMenu?.remove_style_class_name(CLOCK_STYLE_CLASS);

        // Destroy our own widgets BEFORE restoring the box order, so the
        // snapshot only reconciles GNOME's original actors. Panel.addToStatusArea
        // removes us from statusArea automatically on destroy.
        // Unload our dynamic stylesheet and restore the native clock label first
        // (both independent of the box order).
        this._removeNotificationCenter();
        this._fullscreenReveal.destroy();
        this._theme.destroy();
        this._clock.destroy();

        this._removeStatusMenus();
        this._removeControlCenter();
        this._removeActiveApp();
        this._removeSystemMenu();
        this._externalIndicators.release();

        this._notifications.restore();
        this._snapshot?.restore();
    }

    // ---- Individual, idempotent layout mutations ----------------------------

    _applyActivitiesVisibility() {
        const container = PanelAdapter.containerOf(PanelAdapter.activities);
        if (!container)
            return;
        const hide = this._settingBool('hide-activities', true);
        if (hide && container.visible)
            container.hide();
        else if (!hide && !container.visible)
            container.show();
    }

    _applyClockPosition() {
        const dateMenu = PanelAdapter.dateMenu;
        if (this._settingBool('clock-on-right', true)) {
            dateMenu?.add_style_class_name(CLOCK_STYLE_CLASS);
            this._moveClockRight();
        } else {
            dateMenu?.remove_style_class_name(CLOCK_STYLE_CLASS);
            this._moveClockHome();
        }
    }

    _moveClockRight() {
        const container = PanelAdapter.containerOf(PanelAdapter.dateMenu);
        const rightBox = PanelAdapter.rightBox;
        if (!container || !rightBox)
            return;

        const parent = container.get_parent();
        const lastIndex = rightBox.get_n_children() - 1;
        const alreadyLast =
            parent === rightBox &&
            rightBox.get_child_at_index(lastIndex) === container;
        if (alreadyLast)
            return;

        parent?.remove_child(container);
        rightBox.insert_child_at_index(container, rightBox.get_n_children());
    }

    _moveClockHome() {
        const home = this._clockHome;
        const container = PanelAdapter.containerOf(PanelAdapter.dateMenu);
        if (!home || !home.parent || !container)
            return;
        if (container.get_parent() === home.parent)
            return;
        container.get_parent()?.remove_child(container);
        const idx = Math.min(home.index, home.parent.get_n_children());
        home.parent.insert_child_at_index(container, idx);
    }

    // ---- System menu (Stage 3) ----------------------------------------------

    _addSystemMenu() {
        if (!this._settingBool('show-system-menu', true))
            return;
        if (this._systemMenu)
            return; // persists across sessionMode; ordering handled centrally.
        const menu = new LintelSystemMenu(this._extension);
        PanelAdapter.addToStatusArea(SYSTEM_MENU_ROLE, menu, 0, 'left');
        this._systemMenu = menu;
    }

    _addActiveApp() {
        if (!this._settingBool('show-active-app', true))
            return;
        if (this._activeApp)
            return;
        const widget = new ActiveApp(this._extension);
        PanelAdapter.addToStatusArea(ACTIVE_APP_ROLE, widget, 1, 'left');
        this._activeApp = widget;
    }

    /**
     * Keep our left-hand widgets in macOS order — system menu, then active app —
     * at the very start of _leftBox. Idempotent; re-run after sessionMode
     * rebuilds may have shuffled GNOME's own actors back in.
     */
    _ensureLeftOrder() {
        const left = PanelAdapter.leftBox;
        if (!left)
            return;
        let idx = 0;
        for (const widget of [this._systemMenu, this._activeApp]) {
            const container = PanelAdapter.containerOf(widget);
            if (!container || container.get_parent() !== left)
                continue;
            if (left.get_child_at_index(idx) !== container)
                left.set_child_at_index(container, Math.min(idx, left.get_n_children() - 1));
            idx++;
        }
    }

    _removeSystemMenu() {
        if (!this._systemMenu)
            return;
        // destroy() removes the container AND self-cleans panel.statusArea.
        this._systemMenu.destroy();
        this._systemMenu = null;
    }

    _removeActiveApp() {
        if (!this._activeApp)
            return;
        this._activeApp.destroy();
        this._activeApp = null;
    }

    // ---- Control Center (Stage 6) -------------------------------------------

    _addControlCenter() {
        if (this._controlCenter)
            return;
        // In native mode GNOME's own Quick Settings indicator stays in the bar
        // and is the trigger. Mounting our glyph as well put two buttons for
        // one popup side by side.
        if (!this._customControlCenterActive())
            return;
        const cc = new ControlCenter(this._extension);
        const right = PanelAdapter.rightBox;
        const pos = right ? right.get_n_children() : 0;
        PanelAdapter.addToStatusArea(CONTROL_CENTER_ROLE, cc, pos, 'right');
        this._controlCenter = cc;
    }

    _addStatusMenus() {
        if (!this._customControlCenterActive())
            return;

        const right = PanelAdapter.rightBox;
        const pos = right ? right.get_n_children() : 0;
        if (!this._wifiMenu) {
            const menu = new LintelWifiMenu();
            PanelAdapter.addToStatusArea(WIFI_ROLE, menu, pos, 'right');
            this._wifiMenu = menu;
        }
        if (!this._batteryMenu) {
            const menu = new LintelBatteryMenu();
            PanelAdapter.addToStatusArea(BATTERY_ROLE, menu, pos + 1, 'right');
            this._batteryMenu = menu;
        }
    }

    /**
     * Keep the Tahoe controls as three independent hit targets immediately
     * left of the clock: Wi-Fi, battery, then Control Center.
     */
    _positionRightControls() {
        const right = PanelAdapter.rightBox;
        if (!right)
            return;

        const clock = PanelAdapter.containerOf(PanelAdapter.dateMenu);
        const controls = [
            this._wifiMenu,
            this._batteryMenu,
            this._controlCenter,
        ].map(widget => PanelAdapter.containerOf(widget))
            .filter(container => container?.get_parent() === right);
        if (!controls.length)
            return;

        for (const container of controls)
            right.remove_child(container);

        let idx = right.get_n_children();
        if (clock && clock.get_parent() === right)
            idx = right.get_children().indexOf(clock);
        for (const container of controls)
            right.insert_child_at_index(container, idx++);
    }

    _removeStatusMenus() {
        this._wifiMenu?.destroy();
        this._batteryMenu?.destroy();
        this._wifiMenu = null;
        this._batteryMenu = null;
    }

    _removeControlCenter() {
        if (!this._controlCenter)
            return;
        this._controlCenter.destroy();
        this._controlCenter = null;
    }

    /**
     * In custom Control Center mode the native Quick Settings button is stripped
     * rather than hidden: GNOME's own indicators go away (our Control Center,
     * Wi-Fi and battery menus replace them), third-party indicators added via
     * addExternalIndicator() stay, and the button survives only while it carries
     * one of those. Hiding the container outright also unmapped it, and
     * Panel._toggleMenu() bails on an unmapped indicator — which left
     * extensions like Caffeine with neither a glyph nor a reachable toggle.
     * See src/externalIndicators.js. Reversible in both directions.
     */
    _applyQuickSettingsVisibility() {
        if (this._customControlCenterActive())
            this._externalIndicators.apply();
        else
            this._externalIndicators.release();
    }

    _customControlCenterActive() {
        return this._settingString(
            'control-center-mode', 'custom') === 'custom';
    }

    _addNotificationCenter() {
        if (!this._settingBool('notification-center-enabled', true))
            return;
        if (this._notificationCenter) {
            this._notificationCenter.reapply();
            return;
        }

        const center = new LintelNotificationCenter(this._extension);
        try {
            center.enable();
            this._notificationCenter = center;
        } catch (e) {
            try {
                center.destroy();
            } catch (cleanupError) {
                logError(cleanupError, 'lintel: clean up Notification Center');
            }
            logError(e, 'lintel: enable Notification Center');
        }
    }

    _removeNotificationCenter() {
        this._notificationCenter?.destroy();
        this._notificationCenter = null;
    }

    _settingBool(key, fallback) {
        try {
            const settings = this._settings ?? this._extension?.getSettings?.();
            return settings ? settings.get_boolean(key) : fallback;
        } catch (_e) {
            return fallback;
        }
    }

    _settingString(key, fallback) {
        try {
            const settings = this._settings ?? this._extension?.getSettings?.();
            return settings ? settings.get_string(key) : fallback;
        } catch (_e) {
            return fallback;
        }
    }

    // ---- Live settings changes (from prefs) ---------------------------------

    _onSettingsChanged(key) {
        if (!this._enabled || !STRUCTURAL_KEYS.has(key))
            return; // appearance/clock/tunables are handled live elsewhere.
        this._reapplyStructure();
    }

    /**
     * Rebuild the structural widgets to match current settings, without touching
     * the clock text or the dynamic stylesheet (those manage themselves live).
     */
    _reapplyStructure() {
        this._removeNotificationCenter();
        this._removeStatusMenus();
        this._removeControlCenter();
        this._removeActiveApp();
        this._removeSystemMenu();

        this._addSystemMenu();
        this._addActiveApp();
        this._ensureLeftOrder();
        this._applyActivitiesVisibility();
        this._addControlCenter();
        this._addStatusMenus();
        this._applyQuickSettingsVisibility();
        this._applyClockPosition();
        this._positionRightControls();
        this._addNotificationCenter();
    }

    // ---- Session mode handling ----------------------------------------------

    handleSessionMode() {
        // Only re-assert while the normal user panel is present. When the panel
        // is gone (or we're in a restricted mode) there is nothing to lay out.
        if (!this._enabled)
            return;
        if (!PanelAdapter.leftBox)
            return;
        this.applyLintelLayout();
    }

    _queueReapply() {
        if (this._reapplyId)
            return; // coalesce; already queued.

        // Defer to idle so we run AFTER GNOME's own Panel._updatePanel handler
        // has finished rebuilding the boxes for the new session mode.
        this._reapplyId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._reapplyId = 0;
            this.handleSessionMode();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- Teardown -----------------------------------------------------------

    destroy() {
        this._enabled = false;

        if (this._sessionModeId) {
            Main.sessionMode.disconnect(this._sessionModeId);
            this._sessionModeId = 0;
        }

        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }

        if (this._reapplyId) {
            GLib.Source.remove(this._reapplyId);
            this._reapplyId = 0;
        }

        if (this._settingsChangedId && this._settings) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        this._settings = null;

        this.restoreOriginalState();
        // Backstop after every widget is gone: shared service stores outlive
        // the modules' users if any single destroy() was missed.
        shutdownWeather();
        shutdownSystemStats();

        this._externalIndicators.destroy();
        this._notifications.destroy();
        this._snapshot?.destroy();
        this._snapshot = null;
        this._clockHome = null;
        this._notificationCenter = null;
        this._fullscreenReveal = null;
        this._extension = null;
    }
}
