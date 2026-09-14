// SPDX-License-Identifier: GPL-2.0-or-later
//
// LintelNotificationCenter — Tahoe-style clock surface.
//
// GNOME's DateMenuButton combines notifications, a calendar and displays in one
// opaque BoxPointer.  Tahoe instead places independent cards directly over the
// wallpaper.  This module keeps GNOME's notification model and action actors,
// but presents them in a non-strut top-chrome overlay aligned to the right edge
// of the primary monitor.  The native date menu remains alive and is restored
// verbatim when the extension is disabled.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';
import {ensureActorVisibleInScrollView} from
    'resource:///org/gnome/shell/misc/animationUtils.js';

import {_, pgettext} from '../i18n.js';
import {PanelAdapter} from '../compat/panelAdapter.js';
import {
    BatteryWidget,
    CalendarWidget,
    ClockWidget,
    MediaWidget,
    ScreenTimeWidget,
    SystemWidget,
    UpNextWidget,
    WeatherWidget,
} from './ncWidgets.js';

const COLUMN_WIDTH = 345;
const SCREEN_INSET = 15;
const TOP_INSET = 50;
const BOTTOM_INSET = 15;
const OPEN_DURATION_MS = 180;
const CLOSE_DURATION_MS = 140;
const MIN_NOTIFICATION_HEIGHT = 84;

const WIDGETS = Object.freeze([
    {id: 'calendar', title: _('Calendar')},
    {id: 'upnext', title: _('Up Next')},
    {id: 'weather', title: _('Weather')},
    {id: 'screentime', title: _('Screen Time')},
    {id: 'system', title: _('System')},
    {id: 'battery', title: _('Battery')},
    {id: 'media', title: _('Now Playing')},
    {id: 'clock', title: _('Clock')},
]);
const WIDGET_IDS = new Set(WIDGETS.map(widget => widget.id));
const WIDGET_SIZES = Object.freeze(['small', 'medium', 'large']);
const WIDGET_SIZE_LABELS = Object.freeze({
    small: pgettext('widget size', 'S'),
    medium: pgettext('widget size', 'M'),
    large: pgettext('widget size', 'L'),
});

export class LintelNotificationCenter {
    constructor(extension) {
        this._extension = extension;
        this._settings = null;
        this._settingsIds = [];
        this._desktop = null;
        this._desktopId = 0;
        this._monitorsId = 0;
        this._overviewId = 0;
        this._sessionId = 0;
        this._rootEventId = 0;
        this._messageIds = [];
        this._notificationGroups = new Map();
        this._notificationMessages = new Map();
        this._root = null;
        this._chromeAdded = false;
        this._columnScroll = null;
        this._column = null;
        this._header = null;
        this._clearButton = null;
        this._notificationScroll = null;
        this._messageView = null;
        this._widgetsBox = null;
        this._gallery = null;
        this._editButton = null;
        this._widgetRows = new Map();
        this._hookedDateMenu = null;
        this._nativeClickGesture = null;
        this._nativeClickEnabled = true;
        this._hookedNativeMenu = null;
        this._nativeMenuOpenId = 0;
        this._clockClickGesture = null;
        this._clockKeyId = 0;
        this._clockMenuSetId = 0;
        this._calendarOverride = null;
        this._grab = null;
        this._bannerBlocked = false;
        this._bannerBlockedCaptured = false;
        this._editing = false;
        this._open = false;
        this._closing = false;
        this._enabled = false;
    }

    get isOpen() {
        return this._open;
    }

    enable() {
        if (this._enabled) {
            this.reapply();
            return;
        }
        this._enabled = true;

        try {
            this._settings = this._extension?.getSettings?.() ?? null;
        } catch (_e) {
            this._settings = null;
        }
        for (const key of [
            'notification-center-widgets',
            'notification-center-widget-sizes',
        ]) {
            if (!this._settings)
                break;
            try {
                this._settingsIds.push(this._settings.connect(
                    `changed::${key}`, () => this._rebuildWidgets()));
            } catch (_e) {
                // New source with a stale compiled schema: use defaults.
            }
        }

        this._desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._desktopId = this._desktop.connect(
            'changed::color-scheme', () => this._syncAppearance());

        this._buildOverlay();
        this._installClockHook();

        this._monitorsId = Main.layoutManager.connect(
            'monitors-changed', () => this._position());
        this._overviewId = Main.overview.connect('showing', () => this.close(false));
        this._sessionId = Main.sessionMode.connect('updated', () => {
            if (Main.sessionMode.isGreeter || !Main.sessionMode.hasNotifications)
                this.close(false);
            this.reapply();
        });
    }

    reapply() {
        if (!this._enabled)
            return;
        if (PanelAdapter.dateMenu !== this._hookedDateMenu) {
            this.close(false);
            this._removeClockHook();
            this._installClockHook();
        }
        this._position();
    }

    _buildOverlay() {
        this._root = new St.Widget({
            name: 'lintelNotificationCenterRoot',
            style_class: 'lintel-notification-center-root',
            layout_manager: new Clutter.FixedLayout(),
            reactive: true,
            can_focus: true,
            visible: false,
        });
        this._column = new St.BoxLayout({
            name: 'lintelNotificationCenter',
            style_class: 'lintel-notification-center',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            can_focus: true,
            width: COLUMN_WIDTH,
        });
        this._columnScroll = new St.ScrollView({
            style_class: 'lintel-nc-column-scroll',
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            // Keep wheel/touchpad scrolling, but Tahoe does not draw a
            // persistent scrollbar beside the widget column.
            vscrollbar_policy: St.PolicyType.NEVER,
            width: COLUMN_WIDTH,
            child: this._column,
        });
        this._root.add_child(this._columnScroll);

        this._header = new St.BoxLayout({
            style_class: 'lintel-nc-header',
            x_expand: true,
        });
        this._header.add_child(new St.Label({
            text: _('Notification Center'),
            style_class: 'lintel-nc-heading',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._clearButton = new St.Button({
            icon_name: 'window-close-symbolic',
            style_class: 'lintel-nc-clear-button',
            accessible_name: _('Clear all notifications'),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._clearButton.connect('clicked', () => this._messageView?.clear());
        this._header.add_child(this._clearButton);
        this._column.add_child(this._header);

        this._messageView = new MessageList.MessageView();
        this._notificationScroll = new St.ScrollView({
            style_class: 'lintel-nc-notifications vfade',
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.NEVER,
            x_expand: true,
            y_expand: false,
            child: this._messageView,
        });
        this._column.add_child(this._notificationScroll);

        this._messageIds.push(this._messageView.connect(
            'notify::empty', () => this._syncNotifications()));
        this._messageIds.push(this._messageView.connect(
            'notify::can-clear', () => this._syncNotifications()));
        this._messageIds.push(this._messageView.connect(
            'message-focused', (_view, message) => {
                ensureActorVisibleInScrollView(this._notificationScroll, message);
            }));
        this._messageIds.push(this._messageView.connect(
            'child-added', (_view, item) => {
                this._trackNotificationGroup(item.child);
            }));
        for (const message of this._messageView.messages)
            this._trackNotificationGroup(message);

        this._widgetsBox = new St.BoxLayout({
            style_class: 'lintel-nc-widgets',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._column.add_child(this._widgetsBox);

        this._gallery = new St.BoxLayout({
            style_class: 'lintel-nc-widget-gallery',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            visible: false,
        });
        this._column.add_child(this._gallery);

        this._editButton = new St.Button({
            label: _('Edit Widgets'),
            style_class: 'lintel-nc-edit-button',
            accessible_name: _('Edit Widgets'),
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._editButton.connect('clicked', () => this._setEditing(!this._editing));
        this._column.add_child(this._editButton);

        this._rootEventId = this._root.connect(
            'captured-event', (_actor, event) => this._onCapturedEvent(event));

        Main.layoutManager.addTopChrome(this._root, {
            affectsStruts: false,
            trackFullscreen: false,
        });
        this._chromeAdded = true;
        this._syncAppearance();
        this._rebuildWidgets();
        this._syncNotifications();
        this._position();
    }

    _trackNotificationGroup(group) {
        if (!group?.has_style_class_name?.('message-notification-group') ||
            this._notificationGroups.has(group))
            return;

        const ids = [
            group.connect('notification-added', () => {
                this._syncNotificationGroup(group);
            }),
            group.connect('notify::expanded', () => {
                this._syncNotificationGroup(group);
            }),
            group.connect('destroy', () => {
                this._notificationGroups.delete(group);
            }),
        ];
        this._notificationGroups.set(group, ids);
        this._syncNotificationGroup(group);
    }

    _syncNotificationGroup(group) {
        for (const item of group.get_children()) {
            const message = item.child;
            if (!message?.has_style_class_name?.('message'))
                continue;
            this._trackNotificationMessage(message, group);
            this._syncNotificationMessage(message);
        }
    }

    _trackNotificationMessage(message, group) {
        if (this._notificationMessages.has(message))
            return;

        const content = message.get_child?.();
        if (!content)
            return;
        const record = {
            content,
            group,
            opacity: content.opacity,
            ids: [],
        };
        record.ids.push(message.connect('style-changed', () => {
            this._syncNotificationMessage(message);
        }));
        record.ids.push(message.connect('destroy', () => {
            this._notificationMessages.delete(message);
        }));
        this._notificationMessages.set(message, record);
    }

    _syncNotificationMessage(message) {
        const record = this._notificationMessages.get(message);
        if (!record)
            return;

        // Shell intentionally overlaps messages in a collapsed source group.
        // Its stock cards are opaque; our translucent material would otherwise
        // reveal the text and icons from every card underneath the first one.
        const stacked = message.has_style_pseudo_class('second-in-stack') ||
            message.has_style_pseudo_class('lower-in-stack');
        record.content.opacity = stacked ? 0 : record.opacity;

        // Mask the translucent background layers underneath the front card.
        // The class is absent while expanded, so individual cards keep their
        // normal material once GNOME lays them out vertically.
        const collapsedFront = !record.group.expanded && !stacked;
        if (collapsedFront)
            message.add_style_class_name('lintel-nc-collapsed-stack-front');
        else
            message.remove_style_class_name('lintel-nc-collapsed-stack-front');
    }

    _installClockHook() {
        const dateMenu = PanelAdapter.dateMenu;
        if (!dateMenu)
            return;

        this._hookedDateMenu = dateMenu;
        this._nativeClickGesture = PanelAdapter.dateMenuClickGesture;
        try {
            this._nativeClickEnabled =
                this._nativeClickGesture?.get_enabled?.() ?? true;
            this._nativeClickGesture?.set_enabled(false);
        } catch (_e) {
            this._nativeClickEnabled = true;
        }

        this._clockClickGesture = new Clutter.ClickGesture();
        this._clockClickGesture.set_recognize_on_press(true);
        this._clockClickGesture.connect('recognize', () => this.toggle());
        dateMenu.add_action(this._clockClickGesture);
        this._clockKeyId = dateMenu.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol !== Clutter.KEY_Return &&
                symbol !== Clutter.KEY_KP_Enter &&
                symbol !== Clutter.KEY_space)
                return Clutter.EVENT_PROPAGATE;
            this.toggle();
            return Clutter.EVENT_STOP;
        });
        this._clockMenuSetId = dateMenu.connect('menu-set', () => {
            try {
                this._nativeClickGesture?.set_enabled(false);
            } catch (_e) {
                // A replacement date menu will be picked up by reapply().
            }
            this._installNativeMenuRedirect();
        });
        this._installNativeMenuRedirect();

        this._calendarOverride = PanelAdapter.overrideCalendarHandlers(
            () => this.toggle(), () => this.close());
    }

    _installNativeMenuRedirect() {
        this._removeNativeMenuRedirect();
        const menu = this._hookedDateMenu?.menu;
        if (!menu)
            return;

        this._hookedNativeMenu = menu;
        this._nativeMenuOpenId = menu.connect(
            'open-state-changed', (nativeMenu, open) => {
                if (!open || !this._enabled)
                    return;

                // PopupMenuManager opens adjacent panel menus directly when the
                // pointer crosses from an already-open menu to the clock. That
                // path bypasses both the disabled click gesture and the panel's
                // overridden toggleCalendar(), so redirect the native open too.
                nativeMenu.close();
                if (!this._open)
                    this.open();
            });
    }

    _removeNativeMenuRedirect() {
        if (this._nativeMenuOpenId && this._hookedNativeMenu) {
            try {
                this._hookedNativeMenu.disconnect(this._nativeMenuOpenId);
            } catch (_e) {
                // The menu may have been destroyed during a panel rebuild.
            }
        }
        this._nativeMenuOpenId = 0;
        this._hookedNativeMenu = null;
    }

    _removeClockHook() {
        this._calendarOverride?.restore();
        this._calendarOverride = null;
        this._removeNativeMenuRedirect();

        if (this._clockKeyId && this._hookedDateMenu) {
            try {
                this._hookedDateMenu.disconnect(this._clockKeyId);
            } catch (_e) {
                // The native date menu may have been rebuilt already.
            }
        }
        this._clockKeyId = 0;

        if (this._clockMenuSetId && this._hookedDateMenu) {
            try {
                this._hookedDateMenu.disconnect(this._clockMenuSetId);
            } catch (_e) {
                // The native date menu may have been rebuilt already.
            }
        }
        this._clockMenuSetId = 0;

        if (this._clockClickGesture && this._hookedDateMenu) {
            try {
                this._hookedDateMenu.remove_action(this._clockClickGesture);
            } catch (_e) {
                // The actor may be disposed during Shell shutdown.
            }
        }
        this._clockClickGesture = null;

        try {
            this._nativeClickGesture?.set_enabled(this._nativeClickEnabled);
        } catch (_e) {
            // The native action may have gone away with its actor.
        }
        this._nativeClickGesture = null;
        this._hookedDateMenu = null;
    }

    _position() {
        if (!this._root || !this._column || !this._columnScroll)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        this._root.set_position(0, 0);
        this._root.set_size(global.stage.width, global.stage.height);
        this._columnScroll.set_position(
            monitor.x + monitor.width - SCREEN_INSET - COLUMN_WIDTH,
            monitor.y + TOP_INSET);
        this._columnScroll.set_size(
            COLUMN_WIDTH, monitor.height - TOP_INSET - BOTTOM_INSET);

        const [, widgetHeight] = this._widgetsBox?.get_preferred_height(
            COLUMN_WIDTH) ?? [0, 0];
        const [, galleryHeight] = this._gallery?.visible
            ? this._gallery.get_preferred_height(COLUMN_WIDTH)
            : [0, 0];
        const fixedHeight = widgetHeight + galleryHeight + 82;
        const available = monitor.height - TOP_INSET - BOTTOM_INSET - fixedHeight;
        const messageHeight = Math.max(
            MIN_NOTIFICATION_HEIGHT,
            Math.min(430, available));
        if (this._notificationScroll)
            this._notificationScroll.style = `max-height: ${messageHeight}px;`;
    }

    _syncAppearance() {
        if (!this._column)
            return;
        let dark = false;
        try {
            dark = this._desktop?.get_string('color-scheme') === 'prefer-dark';
        } catch (_e) {
            dark = false;
        }
        this._column.remove_style_class_name(
            dark ? 'lintel-nc-light' : 'lintel-nc-dark');
        this._column.add_style_class_name(
            dark ? 'lintel-nc-dark' : 'lintel-nc-light');
    }

    _syncNotifications() {
        if (!this._messageView)
            return;
        const hasMessages = !this._messageView.empty;
        this._header.visible = hasMessages;
        this._notificationScroll.visible = hasMessages;
        this._clearButton.reactive = this._messageView.canClear;
        this._clearButton.can_focus = this._messageView.canClear;
        this._clearButton.opacity = this._messageView.canClear ? 255 : 110;
        this._position();
    }

    _widgetOrder() {
        let order = ['calendar', 'weather', 'battery'];
        try {
            order = this._settings?.get_strv('notification-center-widgets') ?? order;
        } catch (_e) {
            // A stale compiled schema gets the new default.
        }
        const seen = new Set();
        return order.filter(id => {
            if (!WIDGET_IDS.has(id) || seen.has(id))
                return false;
            seen.add(id);
            return true;
        });
    }

    _widgetSizes() {
        const fallback = {
            calendar: 'large',
            upnext: 'medium',
            weather: 'medium',
            screentime: 'small',
            system: 'medium',
            battery: 'small',
            media: 'medium',
            clock: 'small',
        };
        try {
            const stored = this._settings
                ?.get_value('notification-center-widget-sizes')
                ?.deep_unpack() ?? {};
            const sizes = {...fallback};
            for (const {id} of WIDGETS) {
                if (WIDGET_SIZES.includes(stored[id]))
                    sizes[id] = stored[id];
            }
            return sizes;
        } catch (_e) {
            return fallback;
        }
    }

    _setWidgetOrder(order) {
        try {
            this._settings?.set_strv('notification-center-widgets', order);
        } catch (e) {
            logError(e, 'lintel: saving Notification Center widgets');
        }
    }

    _setWidgetSize(id, size) {
        try {
            const sizes = this._widgetSizes();
            sizes[id] = size;
            this._settings?.set_value(
                'notification-center-widget-sizes',
                new GLib.Variant('a{ss}', sizes));
        } catch (e) {
            logError(e, 'lintel: saving Notification Center widget size');
        }
    }

    _newWidget(id, size) {
        const close = () => this.close();
        switch (id) {
        case 'calendar':
            return new CalendarWidget(size, close);
        case 'upnext':
            return new UpNextWidget(size, close);
        case 'screentime':
            return new ScreenTimeWidget(size, close);
        case 'system':
            return new SystemWidget(size, close);
        case 'weather':
            return new WeatherWidget(size, close, {
                settings: this._settings,
                openPreferences: () => this._extension?.openPreferences(),
            });
        case 'battery':
            return new BatteryWidget(size, close);
        case 'media':
            return new MediaWidget(size);
        case 'clock':
            return new ClockWidget(size, close);
        default:
            return null;
        }
    }

    _newEditButton(iconName, accessibleName, callback,
        styleClass = 'lintel-nc-widget-edit-control') {
        const button = new St.Button({
            icon_name: iconName,
            style_class: styleClass,
            accessible_name: accessibleName,
            can_focus: true,
        });
        button.connect('clicked', callback);
        return button;
    }

    _newWidgetSlot(id, order, size) {
        const widget = this._newWidget(id, size);
        if (!widget)
            return null;

        const title = WIDGETS.find(candidate => candidate.id === id)?.title ?? id;
        // Tahoe edits widgets in place: the controls float over the widget
        // rather than pushing a toolbar into the column and moving every card.
        const slot = new St.Widget({
            style_class: `lintel-nc-widget-slot lintel-nc-slot-${size}`,
            layout_manager: new Clutter.BinLayout(),
            x_expand: size !== 'small',
        });

        // A widget with nothing to show (no battery, nothing playing) hides
        // itself; while editing it still needs a surface to carry its controls.
        const placeholder = new St.Bin({
            style_class: `lintel-nc-widget-card lintel-nc-widget-${size} ` +
                'lintel-nc-widget-placeholder',
            child: new St.Label({
                text: title,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }),
            x_expand: true,
            visible: false,
        });
        slot.add_child(placeholder);
        slot.add_child(widget);

        const controls = new St.BoxLayout({
            style_class: 'lintel-nc-widget-edit-bar',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.START,
            visible: false,
        });
        controls.add_child(this._newEditButton(
            'list-remove-symbolic', _('Remove %s').format(title), () => {
                this._setWidgetOrder(order.filter(widgetId => widgetId !== id));
            }, 'lintel-nc-widget-remove'));
        controls.add_child(new St.Widget({x_expand: true}));
        const pill = new St.BoxLayout({style_class: 'lintel-nc-widget-edit-pill'});
        pill.add_child(this._newEditButton(
            'go-up-symbolic', _('Move %s up').format(title),
            () => this._moveWidget(id, -1)));
        pill.add_child(this._newEditButton(
            'go-down-symbolic', _('Move %s down').format(title),
            () => this._moveWidget(id, 1)));
        const sizeButton = new St.Button({
            label: WIDGET_SIZE_LABELS[size],
            style_class: 'lintel-nc-widget-size-control',
            accessible_name: _('Change %s widget size').format(title),
            can_focus: true,
        });
        sizeButton.connect('clicked', () => this._cycleWidgetSize(id));
        pill.add_child(sizeButton);
        controls.add_child(pill);
        slot.add_child(controls);

        slot._lintelWidget = widget;
        slot._lintelControls = controls;
        slot._lintelPlaceholder = placeholder;
        widget.connectObject('notify::visible', () => this._syncSlot(slot), slot);
        return slot;
    }

    _syncSlot(slot) {
        const widget = slot._lintelWidget;
        slot._lintelControls.visible = this._editing;
        slot._lintelPlaceholder.visible = this._editing && !widget.visible;
        // Clicking a widget launches its app; while editing it must not.
        widget.reactive = !this._editing;
        slot.visible = this._editing || widget.visible;

        const pair = slot.get_parent();
        if (pair?._lintelPair)
            pair.visible = pair.get_children().some(child => child.visible);
    }

    _rebuildWidgets() {
        if (!this._widgetsBox || !this._gallery)
            return;
        this._widgetsBox.destroy_all_children();
        this._gallery.destroy_all_children();
        this._widgetRows.clear();

        const order = this._widgetOrder();
        const sizes = this._widgetSizes();
        // Small widgets are squares that share a row two at a time, as in
        // Tahoe; a lone small widget keeps its size and sits at the left.
        let pair = null;
        for (const id of order) {
            const size = sizes[id] ?? 'medium';
            const slot = this._newWidgetSlot(id, order, size);
            if (!slot)
                continue;
            this._widgetRows.set(id, slot);
            if (size !== 'small') {
                pair = null;
                this._widgetsBox.add_child(slot);
            } else if (pair) {
                pair.add_child(slot);
                pair = null;
            } else {
                pair = new St.BoxLayout({
                    style_class: 'lintel-nc-widget-pair',
                    x_expand: true,
                });
                pair._lintelPair = true;
                pair.add_child(slot);
                this._widgetsBox.add_child(pair);
            }
        }
        for (const slot of this._widgetRows.values())
            this._syncSlot(slot);

        const disabled = WIDGETS.filter(widget => !order.includes(widget.id));
        if (disabled.length) {
            this._gallery.add_child(new St.Label({
                text: _('Add Widgets'),
                style_class: 'lintel-nc-gallery-title',
                x_align: Clutter.ActorAlign.START,
            }));
        }
        for (const widget of disabled) {
            const content = new St.BoxLayout({
                style_class: 'lintel-nc-gallery-item-box',
                x_expand: true,
            });
            content.add_child(new St.Icon({
                icon_name: 'list-add-symbolic',
                style_class: 'lintel-nc-gallery-add',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            content.add_child(new St.Label({
                text: widget.title,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const button = new St.Button({
                child: content,
                style_class: 'lintel-nc-gallery-item',
                accessible_name: _('Add %s').format(widget.title),
                can_focus: true,
                x_expand: true,
            });
            button.connect('clicked', () => this._setWidgetOrder([...order, widget.id]));
            this._gallery.add_child(button);
        }
        this._gallery.visible = this._editing && disabled.length > 0;
        this._position();
    }

    _moveWidget(id, delta) {
        const order = this._widgetOrder();
        const from = order.indexOf(id);
        const to = Math.max(0, Math.min(order.length - 1, from + delta));
        if (from < 0 || from === to)
            return;
        [order[from], order[to]] = [order[to], order[from]];
        this._setWidgetOrder(order);
    }

    _cycleWidgetSize(id) {
        const current = this._widgetSizes()[id] ?? 'medium';
        const index = WIDGET_SIZES.indexOf(current);
        const next = WIDGET_SIZES[(index + 1) % WIDGET_SIZES.length];
        this._setWidgetSize(id, next);
    }

    _setEditing(editing) {
        this._editing = editing;
        this._editButton.label = editing ? _('Done') : _('Edit Widgets');
        this._editButton.accessible_name = this._editButton.label;
        if (editing)
            this._editButton.add_style_class_name('lintel-nc-edit-done');
        else
            this._editButton.remove_style_class_name('lintel-nc-edit-done');
        for (const slot of this._widgetRows.values())
            this._syncSlot(slot);
        this._gallery.visible = editing && this._gallery.get_n_children() > 0;
        this._position();
    }

    _refreshWidgets() {
        for (const row of this._widgetRows.values())
            row._lintelWidget.refresh?.();
    }

    _onCapturedEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS) {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            if (this._messageView?.expandedGroup) {
                this._messageView.collapse();
                return Clutter.EVENT_STOP;
            }
            this.close();
            return Clutter.EVENT_STOP;
        }

        if (type !== Clutter.EventType.BUTTON_PRESS &&
            type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;

        const target = global.stage.get_event_actor(event);
        if (this._columnScroll?.contains(target)) {
            const group = this._messageView?.expandedGroup;
            if (group && !group.contains(target))
                this._messageView.collapse();
            return Clutter.EVENT_PROPAGATE;
        }

        this.close();
        return Clutter.EVENT_STOP;
    }

    toggle() {
        if (this._open)
            this.close();
        else
            this.open();
    }

    open() {
        if (!this._enabled || this._open || !this._root ||
            Main.sessionMode.isGreeter)
            return;

        PanelAdapter.closeActiveMenu();
        PanelAdapter.closeNativeDateMenu();
        this._open = true;
        this._closing = false;
        this._setEditing(false);
        this._refreshWidgets();
        this._position();

        this._bannerBlockedCaptured = false;
        try {
            // Retain the prior state so teardown restores the exact value. If
            // it cannot be read, block anyway but leave it alone on close
            // rather than unblocking something another component blocked.
            const prior = PanelAdapter.messageTrayBannerBlocked;
            if (prior !== null) {
                this._bannerBlocked = prior;
                this._bannerBlockedCaptured = true;
            }
            Main.messageTray.bannerBlocked = true;
        } catch (_e) {
            // Cosmetic only; the center remains usable.
        }

        this._root.remove_all_transitions();
        this._column.remove_all_transitions();
        this._root.reactive = true;
        this._root.show();
        this._column.opacity = 0;
        this._column.translation_x = 34;
        this._hookedDateMenu?.add_style_pseudo_class('active');
        try {
            this._grab = Main.pushModal(this._root, {
                actionMode: Shell.ActionMode.POPUP,
            });
        } catch (e) {
            logError(e, 'lintel: acquire Notification Center input grab');
            this.close(false);
            return;
        }
        if (!this._grab) {
            this.close(false);
            return;
        }
        this._column.ease({
            opacity: 255,
            translation_x: 0,
            duration: OPEN_DURATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (this._open)
                    this._column.navigate_focus(
                        null, St.DirectionType.TAB_FORWARD, false);
            },
        });
    }

    close(animate = true) {
        if (!this._open && !this._closing)
            return;

        this._open = false;
        this._closing = animate;
        this._hookedDateMenu?.remove_style_pseudo_class('active');

        if (this._grab) {
            try {
                Main.popModal(this._grab);
            } catch (_e) {
                // A session transition may already have dismissed the grab.
            }
            this._grab = null;
        }

        if (this._bannerBlockedCaptured) {
            try {
                Main.messageTray.bannerBlocked = this._bannerBlocked;
            } catch (_e) {
                // Shell teardown; there is nothing left to restore.
            }
        }
        this._bannerBlockedCaptured = false;

        const finish = () => {
            if (this._open || !this._root)
                return;
            this._closing = false;
            this._root.hide();
            this._root.reactive = true;
            this._column.opacity = 255;
            this._column.translation_x = 0;
        };

        this._column?.remove_all_transitions();
        if (!animate || !this._root?.visible) {
            finish();
            return;
        }

        // Once the modal grab is gone, keep the full-stage actor out of the
        // compositor input region while its cards finish animating away.
        this._root.reactive = false;
        this._column.ease({
            opacity: 0,
            translation_x: 28,
            duration: CLOSE_DURATION_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: finish,
        });
    }

    destroy() {
        if (!this._enabled)
            return;
        this._enabled = false;
        this.close(false);
        this._removeClockHook();

        for (const id of this._settingsIds)
            this._settings?.disconnect(id);
        this._settingsIds = [];
        if (this._desktopId && this._desktop)
            this._desktop.disconnect(this._desktopId);
        this._desktopId = 0;
        if (this._monitorsId)
            Main.layoutManager.disconnect(this._monitorsId);
        this._monitorsId = 0;
        if (this._overviewId)
            Main.overview.disconnect(this._overviewId);
        this._overviewId = 0;
        if (this._sessionId)
            Main.sessionMode.disconnect(this._sessionId);
        this._sessionId = 0;

        for (const id of this._messageIds)
            this._messageView?.disconnect(id);
        this._messageIds = [];
        for (const [group, ids] of this._notificationGroups) {
            for (const id of ids) {
                try {
                    group.disconnect(id);
                } catch (_e) {
                    // A notification source may already have been destroyed.
                }
            }
        }
        this._notificationGroups.clear();
        for (const [message, record] of this._notificationMessages) {
            for (const id of record.ids) {
                try {
                    message.disconnect(id);
                } catch (_e) {
                    // A notification may already have been destroyed.
                }
            }
        }
        this._notificationMessages.clear();
        if (this._rootEventId && this._root)
            this._root.disconnect(this._rootEventId);
        this._rootEventId = 0;

        if (this._root) {
            if (this._chromeAdded) {
                try {
                    Main.layoutManager.removeChrome(this._root);
                } catch (_e) {
                    // LayoutManager may already be tearing its chrome down.
                }
            }
            this._chromeAdded = false;
            this._root.destroy();
        }

        this._widgetRows.clear();
        this._root = null;
        this._columnScroll = null;
        this._column = null;
        this._header = null;
        this._clearButton = null;
        this._notificationScroll = null;
        this._messageView = null;
        this._widgetsBox = null;
        this._gallery = null;
        this._editButton = null;
        this._desktop?.run_dispose();
        this._desktop = null;
        this._settings = null;
        this._extension = null;
    }
}
