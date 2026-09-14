// SPDX-License-Identifier: GPL-2.0-or-later
//
// ControlCenter — Stage 6 + custom macOS Tahoe Control Center (phase 3).
//
// Only mounted when `control-center-mode` is 'custom'. In 'native' mode the
// PanelController does not create this button at all and GNOME's own Quick
// Settings indicator is left in the bar to do the job — two triggers for one
// popup was a duplicate, not a feature.
//
// The popup is a Tahoe-style composition (capsule modules + slider cards); the
// controller hides GNOME's own QS indicators and creates separate Wi-Fi/battery
// status menus beside this button. Controls are wired to existing backends only
// (no daemon reimplemented): Gvc volume, Power/brightnessctl brightness, NM
// Wi-Fi, GNOME Rfkill BT, MPRIS media and gsettings dark/DND.
//
// Third-party extensions reach the popup two ways: an adapter drives the ones
// we know through their own settings contract (src/services/extensionAdapters.js),
// and everything else is mirrored generically from its Quick Settings tile
// (src/services/quickSettingsBridge.js). Their actors are never adopted, and an
// adapter supersedes the mirror of the same extension.
//
// Every backend is optional; a tile/card hides when its hardware or service is
// absent (a desktop has no backlight, often no Wi-Fi or Bluetooth), and the
// grid (ccGrid.js) closes the gap it would leave.
// Actor construction and popup opening are exercised in a headless GNOME 50
// session; `control-center-mode = native` remains the compatibility fallback.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {_} from '../i18n.js';
import {settingsText, shellText} from '../compat/borrowedStrings.js';
import {VolumeService} from '../services/volume.js';
import {BrightnessService} from '../services/brightness.js';
import {ConnectivityService} from '../services/connectivity.js';
import {MediaService} from '../services/media.js';
import {QuickSettingsBridge} from '../services/quickSettingsBridge.js';
import {ExtensionAdapters} from '../services/extensionAdapters.js';
import {
    PowerProfilesService,
    powerProfileShortLabel,
} from '../services/powerProfiles.js';
import {
    CCMediaCard,
    CCSlider,
    CCTile,
} from './ccTile.js';
import {CCGrid} from './ccGrid.js';

const ORDER_KEY = 'control-center-controls';
const SIZES_KEY = 'control-center-control-sizes';

// Reading order that reproduces
// docs/audits/tahoe-reference/26-Tahoe-Finder-Control-Center.png on the grid:
//   Wi-Fi       | Now Playing
//   Bluetooth   | Now Playing
//   AirDrop     | Stage Manager, Screen Mirroring
//   Dark, Shot  | Focus
// Only one of Wi-Fi and the wired network is ever available. Keep in step with
// the schema defaults.
const DEFAULT_ORDER = Object.freeze([
    'wifi', 'network', 'media', 'bluetooth', 'airdrop', 'stage-manager',
    'screen-mirroring', 'dark-mode', 'screenshot', 'focus', 'display', 'sound',
]);

const DEFAULT_SIZES = Object.freeze({
    wifi: 'wide',
    network: 'wide',
    bluetooth: 'wide',
    airdrop: 'wide',
    'stage-manager': 'small',
    'screen-mirroring': 'small',
    'dark-mode': 'small',
    screenshot: 'small',
    focus: 'wide',
    airplane: 'small',
    'power-mode': 'wide',
    'night-light': 'small',
});

// Profiles power-profiles-daemon documents; each has an Adwaita glyph.
const POWER_PROFILES = new Set(['power-saver', 'balanced', 'performance']);

const COLOR_SCHEMA = 'org.gnome.settings-daemon.plugins.color';

// The grid cells a size occupies, as the editor names them.
const SIZE_LABELS = Object.freeze({small: '1×1', wide: '2×1', large: '2×2'});

// GNOME has no AirDrop of its own, and its Sharing panel is about host name,
// media and remote desktop, not sending files. The capsule therefore opens the
// first nearby-sharing app that is installed, in this order of preference.
const AIRDROP_APP_IDS = [
    'localsend.desktop',
    'org.localsend.localsend_app.desktop',
    'org.gnome.Shell.Extensions.GSConnect.desktop',
    'org.kde.kdeconnect.app.desktop',
    'bluetooth-sendto.desktop',
];

export const ControlCenter = GObject.registerClass(
class ControlCenter extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, _('Control Center'), false);
        this.add_style_class_name('lintel-control-center-button');

        this._extension = extension;
        this._openId = 0;
        this._serviceIds = [];
        this._gsettingsIds = [];
        this._extensionTiles = new Map();   // entry key -> our capsule
        this._extensionEntries = new Map(); // entry key -> current entry
        this._extensionOrder = [];          // entry keys in display order
        this._controls = new Map();         // control id -> descriptor
        this._settings = null;
        this._settingsIds = [];
        this._localOrder = null;            // used only without the schema key
        this._localSizes = null;
        this._editing = false;
        this._selected = null;
        this._galleryKey = null;
        this._syncing = false;
        this._disposed = false;

        // When the Shell tears the stage down, Clutter destroys these actors
        // from C without calling destroy() below, and a service can still emit
        // `changed` afterwards. The signal runs before the children die.
        this.connect('destroy', () => {
            this._disposed = true;
        });

        this._buildCustom();
    }

    _buildCustom() {
        this._volume = new VolumeService();
        this._brightness = new BrightnessService();
        this._net = new ConnectivityService();
        this._media = new MediaService();
        this._powerProfiles = new PowerProfilesService();
        this._qsBridge = new QuickSettingsBridge();
        this._qsBridge.enable();
        this._adapters = new ExtensionAdapters();
        this._adapters.enable();

        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._notif = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        // Night Light belongs to gnome-settings-daemon, which a non-GNOME
        // session may lack; opening a missing schema would abort the Shell.
        const color = Gio.SettingsSchemaSource.get_default()
            ?.lookup(COLOR_SCHEMA, true);
        this._color = color?.has_key('night-light-enabled')
            ? new Gio.Settings({schema_id: COLOR_SCHEMA})
            : null;
        try {
            this._settings = this._extension?.getSettings?.() ?? null;
        } catch (_e) {
            this._settings = null;
        }

        // In Tahoe the Control Center glyph, Wi-Fi and battery are three
        // independent menu-bar items. PanelController owns the latter two.
        this.add_child(_newControlCenterIcon());

        this._buildPopup();

        for (const svc of [this._volume, this._brightness, this._net, this._media,
            this._powerProfiles, this._qsBridge, this._adapters])
            this._serviceIds.push([svc, svc.connect('changed', () => this._sync())]);
        for (const s of [this._iface, this._notif, this._color].filter(Boolean))
            this._gsettingsIds.push([s, s.connect('changed', () => this._sync())]);
        const appSystem = Shell.AppSystem.get_default();
        this._serviceIds.push([appSystem,
            appSystem.connect('installed-changed', () => this._sync())]);
        for (const key of [ORDER_KEY, SIZES_KEY]) {
            if (this._settings)
                this._settingsIds.push(this._settings.connect(`changed::${key}`,
                    () => this._sync()));
        }

        this._openId = this.menu.connect('open-state-changed', (_m, open) => {
            if (!open) {
                this._setEditing(false);
            } else {
                this._brightness.refresh?.();
                // Idempotent: re-attaches if Quick Settings was rebuilt (or was
                // not there yet) since the popup was last opened.
                this._qsBridge.enable();
                this._adapters.enable();
                this._sync();
            }
        });

        this._sync();
    }

    _buildPopup() {
        this.menu.actor.add_style_class_name('lintel-cc-menu');
        this.menu.box.add_style_class_name('lintel-cc-popup');

        const content = new St.BoxLayout({
            vertical: true,
            style_class: 'lintel-cc-content',
        });

        this._wifiTile = this._tile('network-wireless-signal-good-symbolic',
            _('Wi-Fi'), () => this._net.setWifi(this._wifiTile.checked));
        // A desktop on a cable has no Wi-Fi card to toggle. It gets the wired
        // link instead, as a launcher into Settings → Network.
        this._wiredTile = this._tile('network-wired-symbolic',
            settingsText('Network'), () => this._openSettings('network'), false);
        this._btTile = this._tile('bluetooth-active-symbolic', _('Bluetooth'),
            () => this._net.setBluetooth(this._btTile.checked));
        // AirDrop is a launcher, not a toggle: the sharing app owns its own
        // visibility state, so the control must not latch when clicked.
        this._airDropTile = this._tile('network-transmit-receive-symbolic',
            'AirDrop', () => this._openAirDrop(), false);
        const stageManager = this._tile(
            'preferences-desktop-multitasking-symbolic', _('Stage Manager'),
            () => {
                this.menu.close();
                Main.overview.toggle();
            }, false);
        const mirroring = this._tile('video-joined-displays-symbolic',
            _('Screen Mirroring'), () => this._openSettings('display'), false);
        this._darkTile = this._tile('dark-mode-symbolic', _('Dark Mode'),
            () => this._iface.set_string('color-scheme',
                this._darkTile.checked ? 'prefer-dark' : 'default'));
        const screenshot = this._tile('screenshot-selection-symbolic',
            _('Screenshot'), () => {
                this.menu.close();
                Main.screenshotUI?.open();
            }, false);
        this._focusTile = this._tile('weather-clear-night-symbolic', _('Focus'),
            () => this._notif.set_boolean(
                'show-banners', !this._focusTile.checked));
        this._airplaneTile = this._tile('airplane-mode-symbolic',
            shellText('Airplane Mode'),
            () => this._net.setAirplane(this._airplaneTile.checked));
        // Power Mode steps through the daemon's profiles on each click, the
        // way a one-button control can; the status line names the current one.
        // The capsule is titled "Power" (Settings' own panel name): "Режим
        // питания" does not fit a half-width capsule, and the status line
        // already names the mode. The editor still calls it Power Mode.
        this._powerTile = this._tile('power-profile-balanced-symbolic',
            settingsText('Power'), () => this._cyclePowerProfile(), false);
        this._nightLightTile = this._tile('night-light-symbolic',
            shellText('Night Light'),
            () => this._color?.set_boolean('night-light-enabled',
                this._nightLightTile.checked));

        this._mediaCard = new CCMediaCard();
        this._mediaCard.connect('previous', () => this._media.previous());
        this._mediaCard.connect('play-pause', () => this._media.playPause());
        this._mediaCard.connect('next', () => this._media.next());

        this._brightCard = new CCSlider(
            _('Display'), 'display-brightness-symbolic',
            'display-brightness-symbolic');
        this._brightCard.connect('moved', (_c, v) => this._brightness.setLevel(v));
        this._volCard = new CCSlider(
            _('Sound'), 'audio-volume-low-symbolic',
            'audio-volume-high-symbolic', true);
        this._volCard.connect('moved', (_c, v) => this._volume.setLevel(v));
        this._volCard.connect('icon-clicked', () => this._volume.toggleMute());
        this._micCard = new CCSlider(
            shellText('Microphone'), 'microphone-sensitivity-medium-symbolic',
            'microphone-sensitivity-high-symbolic', true);
        this._micCard.connect('moved',
            (_c, v) => this._volume.setInputLevel(v));
        this._micCard.connect('icon-clicked',
            () => this._volume.toggleInputMute());

        const wide = ['wide', 'small'];
        for (const [id, actor, title, sizes] of [
            ['wifi', this._wifiTile, _('Wi-Fi'), wide],
            ['network', this._wiredTile, settingsText('Network'), wide],
            ['media', this._mediaCard, _('Now Playing'), ['large']],
            ['bluetooth', this._btTile, _('Bluetooth'), wide],
            ['airdrop', this._airDropTile, 'AirDrop', wide],
            ['stage-manager', stageManager, _('Stage Manager'), wide],
            ['screen-mirroring', mirroring, _('Screen Mirroring'), wide],
            ['dark-mode', this._darkTile, _('Dark Mode'), wide],
            ['screenshot', screenshot, _('Screenshot'), wide],
            ['focus', this._focusTile, _('Focus'), wide],
            // Not in the default layout (it stays the Tahoe reference);
            // offered in the editor's gallery.
            ['airplane', this._airplaneTile, shellText('Airplane Mode'), wide],
            ['power-mode', this._powerTile, settingsText('Power Mode'), wide],
            ['night-light', this._nightLightTile, shellText('Night Light'), wide],
            ['display', this._brightCard, _('Display'), []],
            ['sound', this._volCard, _('Sound'), []],
            ['microphone', this._micCard, shellText('Microphone'), []],
        ]) {
            const control = {
                id, actor, title, sizes,
                slider: sizes.length === 0,
                available: true,
                shape: sizes[0] ?? null,
            };
            this._newSlot(control);
            this._controls.set(id, control);
        }

        // Grid controls, then the full-width sliders, then the editor's
        // toolbar and gallery, which only exist while editing.
        this._grid = new CCGrid();
        content.add_child(this._grid);
        this._sliderBox = new St.BoxLayout({
            vertical: true,
            style_class: 'lintel-cc-sliders',
        });
        content.add_child(this._sliderBox);
        this._buildEditor(content);

        this._editButton = new St.Button({
            style_class: 'lintel-cc-edit-controls',
            accessible_name: _('Edit Controls'),
            label: _('Edit Controls'),
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._editButton.connect('clicked',
            () => this._setEditing(!this._editing));
        content.add_child(this._editButton);

        this.menu.box.add_child(content);
    }

    _tile(iconName, title, onClick, toggleMode = true) {
        const tile = new CCTile(iconName, title);
        tile.toggle_mode = toggleMode;
        tile.connect('clicked', () => {
            if (!this._syncing && !this._editing)
                onClick();
        });
        return tile;
    }

    // ---- Editor -------------------------------------------------------------

    /**
     * Wrap a control in a slot that carries its edit affordances: a shield that
     * takes clicks while editing, so selecting a control never operates it, and
     * Tahoe's remove badge on the top-left corner.
     */
    _newSlot(control) {
        const slot = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        // BinLayout fills a child only along axes it expands on; y_align FILL
        // alone left a circle at its 24px natural height inside a 62px cell.
        control.actor.x_expand = true;
        control.actor.y_expand = true;
        slot.add_child(control.actor);

        control.shield = new St.Button({
            style_class: 'lintel-cc-slot-shield',
            accessible_name: control.title,
            can_focus: true,
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        control.shield.connect('clicked', () =>
            this._select(this._selected === control.id ? null : control.id));
        slot.add_child(control.shield);

        control.remove = new St.Button({
            style_class: 'lintel-cc-slot-remove',
            icon_name: 'list-remove-symbolic',
            accessible_name: _('Remove %s').format(control.title),
            can_focus: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
            translation_x: -6,
            translation_y: -6,
            visible: false,
        });
        control.remove.connect('clicked', () => this._removeControl(control.id));
        slot.add_child(control.remove);

        control.slot = slot;
    }

    _buildEditor(content) {
        this._toolbar = new St.BoxLayout({
            style_class: 'lintel-cc-edit-toolbar',
            visible: false,
        });
        this._toolbarTitle = new St.Label({
            style_class: 'lintel-cc-edit-toolbar-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._toolbar.add_child(this._toolbarTitle);
        this._moveEarlier = this._editTool({icon_name: 'go-previous-symbolic'},
            () => this._moveControl(this._selected, -1));
        this._moveLater = this._editTool({icon_name: 'go-next-symbolic'},
            () => this._moveControl(this._selected, 1));
        this._sizeTool = this._editTool({label: ''},
            () => this._cycleSize(this._selected));
        for (const tool of [this._moveEarlier, this._moveLater, this._sizeTool])
            this._toolbar.add_child(tool);
        content.add_child(this._toolbar);

        this._gallery = new St.BoxLayout({
            vertical: true,
            style_class: 'lintel-cc-gallery',
            visible: false,
        });
        content.add_child(this._gallery);
    }

    _editTool(params, callback) {
        const tool = new St.Button({
            style_class: 'lintel-cc-edit-tool',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            ...params,
        });
        tool.connect('clicked', () => {
            if (this._selected)
                callback();
        });
        return tool;
    }

    _setEditing(editing) {
        if (this._editing === editing)
            return;
        this._editing = editing;
        this._selected = null;
        this._galleryKey = null;

        this._editButton.label = editing ? _('Done') : _('Edit Controls');
        this._editButton.accessible_name = this._editButton.label;
        if (editing)
            this._editButton.add_style_class_name('lintel-cc-edit-done');
        else
            this._editButton.remove_style_class_name('lintel-cc-edit-done');

        for (const control of this._controls.values()) {
            control.shield.visible = editing;
            control.remove.visible = editing;
            // Keyboard focus belongs to the shield while editing.
            if (control.actor instanceof CCTile) {
                control.actor.reactive = !editing;
                control.actor.can_focus = !editing;
            }
        }
        // Third-party toggles are not part of the saved layout; they stay
        // where they are and simply cannot be operated while editing.
        for (const tile of this._extensionTiles.values())
            tile.reactive = !editing;

        this._syncEditor();
    }

    _select(id) {
        this._selected = id;
        this._syncEditor();
    }

    _syncEditor() {
        if (!this._toolbar)
            return;
        const order = this._controlOrder();
        for (const control of this._controls.values())
            control.shield.checked = this._editing && control.id === this._selected;

        const selected = this._controls.get(this._selected);
        this._toolbar.visible = Boolean(this._editing && selected);
        if (selected) {
            const peers = this._peers(order, selected);
            const index = peers.indexOf(selected.id);
            this._toolbarTitle.text = selected.title;
            this._moveEarlier.reactive = index > 0;
            this._moveLater.reactive = index >= 0 && index < peers.length - 1;
            this._moveEarlier.accessible_name =
                _('Move %s earlier').format(selected.title);
            this._moveLater.accessible_name =
                _('Move %s later').format(selected.title);
            this._sizeTool.visible = selected.sizes.length > 1;
            this._sizeTool.label = SIZE_LABELS[selected.shape] ?? '';
            this._sizeTool.accessible_name =
                _('Change %s size').format(selected.title);
        }

        const hidden = this._editing
            ? [...this._controls.values()].filter(control =>
                control.available && !order.includes(control.id))
            : [];
        const key = hidden.map(control => control.id).join(',');
        if (key === this._galleryKey)
            return;
        this._galleryKey = key;
        this._gallery.destroy_all_children();
        this._gallery.visible = hidden.length > 0;
        if (!hidden.length)
            return;
        this._gallery.add_child(new St.Label({
            text: _('Add Controls'),
            style_class: 'lintel-cc-gallery-title',
        }));
        for (const control of hidden) {
            const box = new St.BoxLayout({
                style_class: 'lintel-cc-gallery-item-box',
                x_expand: true,
            });
            box.add_child(new St.Icon({
                icon_name: 'list-add-symbolic',
                style_class: 'lintel-cc-gallery-add',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            box.add_child(new St.Label({
                text: control.title,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const item = new St.Button({
                child: box,
                style_class: 'lintel-cc-gallery-item',
                accessible_name: _('Add %s').format(control.title),
                can_focus: true,
                x_expand: true,
            });
            item.connect('clicked',
                () => this._setControlOrder([...this._controlOrder(), control.id]));
            this._gallery.add_child(item);
        }
    }

    /** Controls a move can swap with: same section, present on this machine. */
    _peers(order, control) {
        return order.filter(id => {
            const other = this._controls.get(id);
            return other && other.slider === control.slider && other.available;
        });
    }

    _moveControl(id, delta) {
        const control = this._controls.get(id);
        if (!control)
            return;
        const order = this._controlOrder();
        const peers = this._peers(order, control);
        const target = peers[peers.indexOf(id) + delta];
        if (!target)
            return;
        const from = order.indexOf(id);
        const to = order.indexOf(target);
        [order[from], order[to]] = [order[to], order[from]];
        this._setControlOrder(order);
    }

    _removeControl(id) {
        if (this._selected === id)
            this._selected = null;
        this._setControlOrder(this._controlOrder().filter(other => other !== id));
    }

    _cycleSize(id) {
        const control = this._controls.get(id);
        if (!control || control.sizes.length < 2)
            return;
        const sizes = this._controlSizes();
        const index = control.sizes.indexOf(control.shape);
        sizes[id] = control.sizes[(index + 1) % control.sizes.length];
        this._setControlSizes(sizes);
    }

    // ---- Saved layout -------------------------------------------------------

    /**
     * Writing a key the compiled schema lacks aborts the whole Shell, and a
     * stale schema is exactly what an update leaves behind until the next
     * login. Without the key the layout lives in memory for the session.
     */
    _hasKey(key) {
        return Boolean(this._settings?.settings_schema?.has_key(key));
    }

    _controlOrder() {
        let order = this._localOrder ?? [...DEFAULT_ORDER];
        if (this._hasKey(ORDER_KEY))
            order = this._settings.get_strv(ORDER_KEY);
        const seen = new Set();
        return order.filter(id => {
            if (!this._controls.has(id) || seen.has(id))
                return false;
            seen.add(id);
            return true;
        });
    }

    _setControlOrder(order) {
        if (this._hasKey(ORDER_KEY)) {
            this._settings.set_strv(ORDER_KEY, order);
        } else {
            this._localOrder = order;
            this._sync();
        }
    }

    _controlSizes() {
        let stored = this._localSizes ?? {};
        if (this._hasKey(SIZES_KEY))
            stored = this._settings.get_value(SIZES_KEY).deep_unpack();
        return {...DEFAULT_SIZES, ...stored};
    }

    _setControlSizes(sizes) {
        if (this._hasKey(SIZES_KEY)) {
            this._settings.set_value(SIZES_KEY, new GLib.Variant('a{ss}', sizes));
        } else {
            this._localSizes = sizes;
            this._sync();
        }
    }

    /** Apply the saved order and sizes to the grid and the slider column. */
    _layoutControls() {
        const order = this._controlOrder();
        const sizes = this._controlSizes();
        const listed = new Set(order);
        const ordered = [
            ...order.map(id => this._controls.get(id)),
            ...[...this._controls.values()].filter(c => !listed.has(c.id)),
        ];

        const grid = [];
        let sliderIndex = 0;
        for (const control of ordered) {
            control.slot.visible = listed.has(control.id) && control.available;
            if (control.slider) {
                const parent = control.slot.get_parent();
                if (parent !== this._sliderBox) {
                    parent?.remove_child(control.slot);
                    this._sliderBox.add_child(control.slot);
                }
                if (this._sliderBox.get_child_at_index(sliderIndex) !== control.slot)
                    this._sliderBox.set_child_at_index(control.slot, sliderIndex);
                sliderIndex++;
                continue;
            }

            control.shape = control.sizes.includes(sizes[control.id])
                ? sizes[control.id]
                : control.sizes[0];
            control.actor.setCompact?.(control.shape === 'small');
            for (const shape of ['small', 'wide', 'large']) {
                if (shape === control.shape)
                    control.shield.add_style_class_name(`lintel-cc-shape-${shape}`);
                else
                    control.shield.remove_style_class_name(`lintel-cc-shape-${shape}`);
            }
            grid.push({actor: control.slot, shape: control.shape});
        }

        // Mirrored third-party toggles follow the user's controls as capsules.
        for (const key of this._extensionOrder)
            grid.push({actor: this._extensionTiles.get(key), shape: 'wide'});
        this._grid.setModules(grid);
    }

    _airDropApp() {
        const appSystem = Shell.AppSystem.get_default();
        for (const id of AIRDROP_APP_IDS) {
            if (id === 'bluetooth-sendto.desktop' && !this._net.bluetoothAvailable)
                continue;
            const app = appSystem.lookup_app(id);
            if (app)
                return app;
        }
        return null;
    }

    _openAirDrop() {
        const app = this._airDropApp();
        if (!app) {
            this._openSettings('sharing');
            return;
        }
        this.menu.close();
        app.activate();
    }

    _cyclePowerProfile() {
        const profiles = this._powerProfiles.profiles;
        const index = profiles.indexOf(this._powerProfiles.activeProfile);
        const next = profiles[(index + 1) % profiles.length];
        if (next)
            this._powerProfiles.setProfile(next);
    }

    _openSettings(panel = '') {
        if (!GLib.find_program_in_path('gnome-control-center'))
            return;
        try {
            const command = panel
                ? `gnome-control-center ${panel}`
                : 'gnome-control-center';
            Gio.AppInfo.create_from_commandline(command, null,
                Gio.AppInfoCreateFlags.NONE).launch([], null);
            this.menu.close();
        } catch (e) {
            logError(e, 'lintel: launch settings');
        }
    }

    // ---- Sync UI from backends ----------------------------------------------

    _sync() {
        if (this._disposed)
            return;
        this._syncing = true;
        try {
            const wifi = this._net.wifiAvailable;
            this._setTile('wifi', wifi,
                this._net.wifiEnabled,
                this._net.wifiEnabled ? _('On') : _('Off'));
            const wired = this._net.wiredState;
            this._setTile('network', !wifi && this._net.wiredAvailable,
                wired === 'connected', {
                    connected: settingsText('Connected'),
                    connecting: settingsText('Connecting'),
                    unplugged: settingsText('Cable unplugged'),
                }[wired] ?? '');
            this._setTile('bluetooth', this._net.bluetoothAvailable,
                this._net.bluetoothEnabled,
                this._net.bluetoothEnabled ? _('On') : _('Off'));
            // Name the app the control will open; GNOME exposes no discovery
            // state to put there instead.
            this._setTile('airdrop', true, false,
                this._airDropApp()?.get_name() ?? '');

            const dark = this._iface.get_string('color-scheme') === 'prefer-dark';
            this._setTile('dark-mode', true, dark, '');
            // The reference shows Focus as a bare label when it is off, and
            // only names a mode once one is active.
            const dnd = !this._notif.get_boolean('show-banners');
            this._setTile('focus', true, dnd, dnd ? _('On') : '');

            this._setTile('airplane', this._net.airplaneAvailable,
                this._net.airplaneEnabled,
                this._net.airplaneEnabled ? _('On') : _('Off'));
            // Tinted like GNOME's own toggle: anything but Balanced is "on".
            const profile = this._powerProfiles.activeProfile;
            this._setTile('power-mode', this._powerProfiles.available,
                profile !== 'balanced', powerProfileShortLabel(profile));
            this._powerTile.setIcon(POWER_PROFILES.has(profile)
                ? `power-profile-${profile}-symbolic`
                : 'power-profile-balanced-symbolic');
            const night = this._color?.get_boolean('night-light-enabled') ?? false;
            this._setTile('night-light', Boolean(this._color), night,
                night ? _('On') : _('Off'));
            this._controls.get('screenshot').available = Boolean(Main.screenshotUI);

            this._mediaCard.setTrack(this._media.title, this._media.artist,
                this._media.artUrl, this._media.playing);

            this._setCard('display', this._brightness.available,
                this._brightness.level, 'display-brightness-symbolic');
            this._setCard('sound', this._volume.available,
                this._volume.level, this._volume.iconName);
            this._setCard('microphone', this._volume.inputAvailable,
                this._volume.inputLevel, this._volume.inputIconName);

            this._syncExtensions();
            this._layoutControls();
            if (this._editing)
                this._syncEditor();
        } catch (e) {
            logError(e, 'lintel: control center sync');
        } finally {
            this._syncing = false;
        }
    }

    /**
     * Everything a third party contributes, adapters first. An adapter entry
     * supersedes the generic mirror of the same extension's tile, so the two
     * sources can never produce two capsules for one extension.
     */
    _extensionEntryList() {
        const entries = [];

        for (const entry of this._adapters.entries)
            entries.push(entry);

        for (const item of this._qsBridge.items) {
            if (this._adapters.claims(item))
                continue;
            entries.push({
                key: item,
                title: item.title ?? '',
                // A QuickMenuToggle's sub-page stays in native Quick Settings;
                // the subtitle is what it already uses to spell out its state.
                subtitle: item.subtitle ?? '',
                gicon: item.gicon,
                active: item.checked,
                visible: item.visible,
            });
        }

        return entries;
    }

    _activateExtensionEntry(key) {
        if (typeof key === 'string')
            this._adapters.toggle(key);
        else
            this._qsBridge.activate(key);
    }

    /**
     * Reconcile our capsules against the entries that exist right now: drop the
     * gone, create the new, re-order and refresh the rest. We reconcile instead
     * of rebuilding because `changed` also fires for a plain state flip, and
     * rebuilding would drop hover/focus on every toggle.
     */
    _syncExtensions() {
        const entries = this._extensionEntryList();
        const live = new Set(entries.map(entry => entry.key));

        for (const [key, tile] of this._extensionTiles) {
            if (live.has(key))
                continue;
            this._extensionTiles.delete(key);
            this._extensionEntries.delete(key);
            tile.destroy();
        }

        // Placement belongs to the grid; this only fixes the order.
        this._extensionOrder = [];
        for (const entry of entries) {
            const key = entry.key;
            this._extensionEntries.set(key, entry);

            let tile = this._extensionTiles.get(key);
            if (!tile) {
                tile = new CCTile(entry.iconName ?? 'applications-system-symbolic',
                    entry.title);
                // Look the entry up on click rather than capturing it: entries
                // are rebuilt on every sync, a tile is not.
                tile.connect('clicked', () => {
                    if (!this._syncing)
                        this._activateExtensionEntry(key);
                });
                tile.reactive = !this._editing;
                this._extensionTiles.set(key, tile);
            }
            this._extensionOrder.push(key);

            tile.setTitle(entry.title);
            if (entry.iconName)
                tile.setIcon(entry.iconName);
            else
                tile.setGicon(entry.gicon);
            tile.setActive(entry.active, entry.subtitle);
            tile.visible = entry.visible;
        }
    }

    _destroyExtensionTiles() {
        for (const tile of this._extensionTiles.values())
            tile.destroy();
        this._extensionTiles.clear();
        this._extensionEntries.clear();
    }

    /** Availability hides the control's slot in _layoutControls(). */
    _setTile(id, available, active, status) {
        const control = this._controls.get(id);
        control.available = available;
        if (available)
            control.actor.setActive(active, status);
    }

    _setCard(id, available, value, iconName) {
        const control = this._controls.get(id);
        const card = control.actor;
        // Hidden rather than dimmed: a desktop monitor has no backlight to
        // dim, and a disabled slider there is a control that can never work.
        control.available = available;
        card.setAvailable(available);
        if (available) {
            card.setValue(value);
            card.setIcon(iconName);
        }
    }

    destroy() {
        if (this._openId) {
            this.menu.disconnect(this._openId);
            this._openId = 0;
        }
        for (const [obj, id] of this._serviceIds)
            obj.disconnect(id);
        this._serviceIds = [];
        for (const [obj, id] of this._gsettingsIds)
            obj.disconnect(id);
        this._gsettingsIds = [];
        for (const id of this._settingsIds)
            this._settings?.disconnect(id);
        this._settingsIds = [];
        this._settings = null;

        this._destroyExtensionTiles();
        this._controls.clear();
        this._grid = this._sliderBox = null;
        this._toolbar = this._gallery = this._editButton = null;

        this._volume?.destroy();
        this._brightness?.destroy();
        this._net?.destroy();
        this._media?.destroy();
        this._powerProfiles?.destroy();
        this._powerProfiles = null;
        this._color = null;
        this._qsBridge?.destroy();
        this._adapters?.destroy();
        this._volume = this._brightness = this._net = null;
        this._media = null;
        this._qsBridge = null;
        this._adapters = null;
        this._iface = this._notif = null;
        this._extension = null;

        super.destroy();
    }
});

/**
 * Draw the fixed Tahoe Control Center glyph ourselves. St.Icon delegates file
 * icons to the active icon theme, where an otherwise valid extension SVG can
 * resolve to a missing or transparent texture. DrawingArea keeps the glyph
 * independent from theme lookup while still inheriting the panel foreground.
 *
 * Geometry is measured off the reference bar and expressed in the icon's own
 * 16-unit grid: two stacked toggle switches filling about 12.5 x 12.5 units of
 * ink — an outlined switch whose knob rests at the leading edge above a filled
 * switch whose knob is knocked out at the trailing edge. The previous glyph
 * drew two hairline tracks instead, which read as half the height of the
 * reference and much lighter than the surrounding status icons.
 */
const CC_TRACK_WIDTH = 12.4;
const CC_TRACK_HEIGHT = 5.6;
const CC_TRACK_GAP = 1.2;
const CC_STROKE = 1.1;
const CC_KNOB_WIDTH = 4.6;
const CC_KNOB_HEIGHT = 2.8;

function _newControlCenterIcon() {
    const icon = new St.DrawingArea({
        style_class: 'system-status-icon lintel-control-center-icon',
        width: 16,
        height: 16,
        reactive: false,
    });

    icon.connect('repaint', area => {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const color = area.get_theme_node().get_foreground_color();
        const scale = Math.min(width, height) / 16;
        const offsetX = (width - 16 * scale) / 2;
        const offsetY = (height - 16 * scale) / 2;

        const px = v => offsetX + v * scale;
        const py = v => offsetY + v * scale;

        // A capsule: a rectangle capped by two half circles.
        const capsule = (x, y, w, h) => {
            const r = h / 2;
            cr.newSubPath();
            cr.arc(px(x + r), py(y + r), r * scale,
                Math.PI / 2, Math.PI * 1.5);
            cr.arc(px(x + w - r), py(y + r), r * scale,
                Math.PI * 1.5, Math.PI / 2);
            cr.closePath();
        };

        const trackX = (16 - CC_TRACK_WIDTH) / 2;
        const upperY = (16 - (2 * CC_TRACK_HEIGHT + CC_TRACK_GAP)) / 2;
        const lowerY = upperY + CC_TRACK_HEIGHT + CC_TRACK_GAP;
        const knobInset = (CC_TRACK_HEIGHT - CC_KNOB_HEIGHT) / 2;
        const knobY = trackY => trackY + knobInset;

        cr.setSourceColor(color);
        cr.setLineWidth(CC_STROKE * scale);

        // Upper switch: outline plus a solid knob at the leading edge.
        capsule(trackX + CC_STROKE / 2, upperY + CC_STROKE / 2,
            CC_TRACK_WIDTH - CC_STROKE, CC_TRACK_HEIGHT - CC_STROKE);
        cr.stroke();
        capsule(trackX + knobInset, knobY(upperY),
            CC_KNOB_WIDTH, CC_KNOB_HEIGHT);
        cr.fill();

        // Lower switch: solid, with the knob knocked out of the fill so the
        // panel background shows through it the way the reference glyph does.
        cr.setFillRule(Cairo.FillRule.EVEN_ODD);
        capsule(trackX, lowerY, CC_TRACK_WIDTH, CC_TRACK_HEIGHT);
        capsule(trackX + CC_TRACK_WIDTH - knobInset - CC_KNOB_WIDTH,
            knobY(lowerY), CC_KNOB_WIDTH, CC_KNOB_HEIGHT);
        cr.fill();

        cr.$dispose();
    });

    return icon;
}
