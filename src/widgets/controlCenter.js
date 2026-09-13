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
// Every backend is optional; a tile/card hides when its service is absent.
// Actor construction and popup opening are exercised in a headless GNOME 50
// session; `control-center-mode = native` remains the compatibility fallback.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {_} from '../i18n.js';
import {VolumeService} from '../services/volume.js';
import {BrightnessService} from '../services/brightness.js';
import {ConnectivityService} from '../services/connectivity.js';
import {MediaService} from '../services/media.js';
import {QuickSettingsBridge} from '../services/quickSettingsBridge.js';
import {ExtensionAdapters} from '../services/extensionAdapters.js';
import {
    CCActionButton,
    CCMediaCard,
    CCSlider,
    CCTile,
} from './ccTile.js';

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
        this._syncing = false;

        this._buildCustom();
    }

    _buildCustom() {
        this._volume = new VolumeService();
        this._brightness = new BrightnessService();
        this._net = new ConnectivityService();
        this._media = new MediaService();
        this._qsBridge = new QuickSettingsBridge();
        this._qsBridge.enable();
        this._adapters = new ExtensionAdapters();
        this._adapters.enable();

        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._notif = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});

        // In Tahoe the Control Center glyph, Wi-Fi and battery are three
        // independent menu-bar items. PanelController owns the latter two.
        this.add_child(_newControlCenterIcon());

        this._buildPopup();

        for (const svc of [this._volume, this._brightness, this._net, this._media,
            this._qsBridge, this._adapters])
            this._serviceIds.push([svc, svc.connect('changed', () => this._sync())]);
        for (const s of [this._iface, this._notif])
            this._gsettingsIds.push([s, s.connect('changed', () => this._sync())]);

        this._openId = this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
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

        // Tahoe composition, measured off
        // docs/audits/tahoe-reference/26-Tahoe-Finder-Control-Center.png:
        // Wi-Fi, Bluetooth and AirDrop are three stacked full-column capsules on
        // the left; Now Playing plus two square utilities on the right.
        this._wifiTile = this._tile('network-wireless-signal-good-symbolic',
            _('Wi-Fi'), () => this._net.setWifi(this._wifiTile.checked));
        this._btTile = this._tile('bluetooth-active-symbolic', _('Bluetooth'),
            () => this._net.setBluetooth(this._btTile.checked));
        this._airDropTile = this._tile(
            'network-transmit-receive-symbolic', 'AirDrop',
            () => this._openSettings('sharing'), 'lintel-cc-navigation');
        // AirDrop is a navigation capsule, not a toggle: GNOME has no AirDrop
        // state to reflect, so it must not latch when clicked.
        this._airDropTile.toggle_mode = false;
        this._focusTile = this._tile('weather-clear-night-symbolic', _('Focus'),
            () => this._notif.set_boolean(
                'show-banners', !this._focusTile.checked),
            'lintel-cc-focus');

        const primary = new St.BoxLayout({style_class: 'lintel-cc-primary'});
        const connectivity = new St.BoxLayout({
            vertical: true,
            style_class: 'lintel-cc-connectivity',
            x_expand: true,
        });
        connectivity.add_child(this._wifiTile);
        connectivity.add_child(this._btTile);
        connectivity.add_child(this._airDropTile);
        primary.add_child(connectivity);

        const right = new St.BoxLayout({
            vertical: true,
            style_class: 'lintel-cc-primary-right',
            x_expand: true,
        });
        this._mediaCard = new CCMediaCard();
        this._mediaCard.connect('previous', () => this._media.previous());
        this._mediaCard.connect('play-pause', () => this._media.playPause());
        this._mediaCard.connect('next', () => this._media.next());
        right.add_child(this._mediaCard);
        const utilityRow = new St.BoxLayout({
            style_class: 'lintel-cc-utility-row',
            x_expand: true,
        });
        const overview = new CCActionButton(
            'preferences-desktop-multitasking-symbolic', _('Stage Manager'), false,
            'lintel-cc-utility');
        overview.connect('clicked', () => {
            this.menu.close();
            Main.overview.toggle();
        });
        const displays = new CCActionButton(
            'video-joined-displays-symbolic', _('Screen Mirroring'), false,
            'lintel-cc-utility');
        displays.connect('clicked', () => this._openSettings('display'));
        utilityRow.add_child(overview);
        utilityRow.add_child(displays);
        right.add_child(utilityRow);
        primary.add_child(right);
        content.add_child(primary);

        // The reference puts this row between the columns and the sliders, and
        // it follows the same two-column grid: two circles occupy the left
        // column's width, the Focus capsule the right column's.
        const actions = new St.BoxLayout({style_class: 'lintel-cc-actions'});
        const circles = new St.BoxLayout({
            style_class: 'lintel-cc-circle-row',
            x_expand: false,
        });
        this._darkButton = this._action('dark-mode-symbolic', _('Dark Mode'),
            () => this._iface.set_string('color-scheme',
                this._darkButton.checked ? 'prefer-dark' : 'default'), true,
            'lintel-cc-circle-action');
        const screenshot = this._action(
            'screenshot-selection-symbolic', _('Screenshot'),
            () => {
                this.menu.close();
                Main.screenshotUI?.open();
            }, false, 'lintel-cc-circle-action');
        for (const button of [this._darkButton, screenshot]) {
            button.x_expand = false;
            circles.add_child(button);
        }
        actions.add_child(circles);
        actions.add_child(this._focusTile);
        content.add_child(actions);

        // Labelled full-width slider modules.
        this._brightCard = new CCSlider(
            _('Display'), 'display-brightness-symbolic',
            'display-brightness-symbolic');
        this._brightCard.connect('moved', (_c, v) => this._brightness.setLevel(v));
        content.add_child(this._brightCard);

        this._volCard = new CCSlider(
            _('Sound'), 'audio-volume-low-symbolic',
            'audio-volume-high-symbolic', true);
        this._volCard.connect('moved', (_c, v) => this._volume.setLevel(v));
        this._volCard.connect('icon-clicked', () => this._volume.toggleMute());
        content.add_child(this._volCard);

        // Third-party Quick Settings toggles, mirrored as ordinary capsules.
        // Empty (and hidden) unless another extension contributes one.
        this._extensionsBox = new St.BoxLayout({
            vertical: true,
            style_class: 'lintel-cc-extensions',
            visible: false,
        });
        content.add_child(this._extensionsBox);

        const editControls = new St.Button({
            style_class: 'lintel-cc-edit-controls',
            accessible_name: _('Edit Controls'),
            label: _('Edit Controls'),
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        editControls.connect('clicked', () => {
            this.menu.close();
            this._extension?.openPreferences?.();
        });
        content.add_child(editControls);

        this.menu.box.add_child(content);
    }

    _tile(iconName, title, onClick, styleClass = '') {
        const tile = new CCTile(iconName, title, styleClass);
        tile.connect('clicked', () => {
            if (!this._syncing)
                onClick();
        });
        return tile;
    }

    _action(iconName, title, onClick, toggleMode = false, styleClass = '') {
        const button = new CCActionButton(
            iconName, title, toggleMode, styleClass);
        button.connect('clicked', () => {
            if (!this._syncing)
                onClick();
        });
        return button;
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
        this._syncing = true;
        try {
            this._setTile(this._wifiTile, this._net.wifiAvailable,
                this._net.wifiEnabled,
                this._net.wifiEnabled ? _('On') : _('Off'));
            this._setTile(this._btTile, this._net.bluetoothAvailable,
                this._net.bluetoothEnabled,
                this._net.bluetoothEnabled ? _('On') : _('Off'));

            const dark = this._iface.get_string('color-scheme') === 'prefer-dark';
            this._darkButton.setActive(dark);
            // The reference shows Focus as a bare label when it is off, and
            // only names a mode once one is active.
            const dnd = !this._notif.get_boolean('show-banners');
            this._setTile(this._focusTile, true, dnd, dnd ? _('On') : '');

            this._mediaCard.setTrack(this._media.title, this._media.artist,
                this._media.artUrl, this._media.playing);

            this._setCard(this._brightCard, this._brightness.available,
                this._brightness.level, 'display-brightness-symbolic');
            this._setCard(this._volCard, this._volume.available,
                this._volume.level, this._volume.iconName);

            this._syncExtensions();

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
        const box = this._extensionsBox;
        if (!box)
            return;

        const entries = this._extensionEntryList();
        const live = new Set(entries.map(entry => entry.key));

        for (const [key, tile] of this._extensionTiles) {
            if (live.has(key))
                continue;
            this._extensionTiles.delete(key);
            this._extensionEntries.delete(key);
            tile.destroy();
        }

        let index = 0;
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
                this._extensionTiles.set(key, tile);
                box.add_child(tile);
            }
            if (box.get_child_at_index(index) !== tile)
                box.set_child_at_index(tile, index);
            index++;

            tile.setTitle(entry.title);
            if (entry.iconName)
                tile.setIcon(entry.iconName);
            else
                tile.setGicon(entry.gicon);
            tile.setActive(entry.active, entry.subtitle);
            tile.visible = entry.visible;
        }

        box.visible = index > 0;
    }

    _destroyExtensionTiles() {
        for (const tile of this._extensionTiles.values())
            tile.destroy();
        this._extensionTiles.clear();
        this._extensionEntries.clear();
    }

    _setTile(tile, available, active, status) {
        if (!tile)
            return;
        tile.visible = available;
        if (available)
            tile.setActive(active, status);
    }

    _setCard(card, available, value, iconName) {
        if (!card)
            return;
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

        this._destroyExtensionTiles();
        this._extensionsBox = null;

        this._volume?.destroy();
        this._brightness?.destroy();
        this._net?.destroy();
        this._media?.destroy();
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
