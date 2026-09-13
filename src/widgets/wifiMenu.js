// SPDX-License-Identifier: GPL-2.0-or-later
//
// Independent menu-bar Wi-Fi status item, matching Tahoe's status-menu model:
// its own panel hit target, checked/open state, popup anchor and network list.

import Clutter from 'gi://Clutter';
import GioUnix from 'gi://GioUnix';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {_} from '../i18n.js';
import {WifiService} from '../services/wifi.js';
import {styleStatusMenu} from './statusMenu.js';

const MAX_VISIBLE_NETWORKS = 8;

export const LintelWifiMenu = GObject.registerClass(
class LintelWifiMenu extends PanelMenu.Button {
    _init() {
        super._init(0.0, _('Wi-Fi'), false);
        this.add_style_class_name('lintel-status-button');

        this._wifi = new WifiService();
        this._wifiChangedId = 0;
        this._openStateId = 0;
        this._syncing = false;

        this._panelIcon = new St.Icon({
            style_class: 'system-status-icon',
            icon_name: 'network-wireless-signal-none-symbolic',
        });
        this.add_child(this._panelIcon);

        styleStatusMenu(this.menu, 'lintel-wifi-menu-content');
        this._buildMenu();

        this._wifiChangedId = this._wifi.connect('changed', () => this._sync());
        this._openStateId = this.menu.connect(
            'open-state-changed', (_menu, open) => {
                if (open)
                    this._wifi.startScanning();
                else
                    this._wifi.stopScanning();
                this._sync();
            });
        this._sync();
    }

    _buildMenu() {
        this._toggle = new PopupMenu.PopupSwitchMenuItem(_('Wi-Fi'), false);
        this._toggle.add_style_class_name('lintel-status-toggle');
        this._toggle.connect('toggled', (_item, state) => {
            if (!this._syncing)
                this._wifi.setEnabled(state);
        });
        this.menu.addMenuItem(this._toggle);

        this._networkHeading = new PopupMenu.PopupMenuItem(_('Networks'), {
            reactive: false,
            can_focus: false,
        });
        this._networkHeading.add_style_class_name('lintel-status-section-title');
        this.menu.addMenuItem(this._networkHeading);

        this._networksSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._networksSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addSettingsAction(_('Wi-Fi Settings…'), 'gnome-wifi-panel.desktop');
    }

    _sync() {
        if (!this._wifi)
            return;
        this._syncing = true;
        try {
            const available = this._wifi.available;
            this.visible = available;
            this._panelIcon.icon_name = this._wifi.iconName;

            const active = this._wifi.activeNetwork;
            this.accessible_name = active
                ? _('Wi-Fi, connected to %s').format(active)
                : _('Wi-Fi, %s').format(this._wifi.enabled
                    ? _('not connected')
                    : _('off'));

            this._toggle.setToggleState(this._wifi.enabled);
            this._toggle.sensitive = this._wifi.hardwareEnabled;
            this._toggle.setStatus(this._wifi.hardwareEnabled
                ? null
                : _('Unavailable'));
            this._networkHeading.visible = this._wifi.enabled;
            this._rebuildNetworks();
        } finally {
            this._syncing = false;
        }
    }

    _rebuildNetworks() {
        this._networksSection.removeAll();
        if (!this._wifi.enabled)
            return;

        const networks = this._wifi.networks.slice(0, MAX_VISIBLE_NETWORKS);
        if (!networks.length) {
            const empty = new PopupMenu.PopupMenuItem(_('Searching for networks…'), {
                reactive: false,
                can_focus: false,
            });
            empty.add_style_class_name('lintel-status-empty');
            this._networksSection.addMenuItem(empty);
            return;
        }

        for (const network of networks) {
            const item = new PopupMenu.PopupImageMenuItem(
                network.name, network.iconName);
            item.add_style_class_name('lintel-wifi-network-item');
            item.label.x_expand = true;
            item.accessible_name = network.active
                ? _('Disconnect from %s').format(network.name)
                : _('Connect to %s').format(network.name);

            if (network.secure) {
                item.add_child(new St.Icon({
                    icon_name: 'network-wireless-encrypted-symbolic',
                    style_class: 'lintel-wifi-secure-icon',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }
            item.setOrnament(network.active
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
            item.connect('activate', () => {
                const handled = this._wifi.toggleNetwork(network);
                this.menu.close();
                if (!handled)
                    this._openWifiSettings();
            });
            this._networksSection.addMenuItem(item);
        }
    }

    _openWifiSettings() {
        try {
            GioUnix.DesktopAppInfo.new(
                'gnome-wifi-panel.desktop')?.launch([], null);
        } catch (e) {
            logError(e, 'lintel: open Wi-Fi settings');
        }
    }

    destroy() {
        if (this._wifiChangedId && this._wifi)
            this._wifi.disconnect(this._wifiChangedId);
        if (this._openStateId)
            this.menu.disconnect(this._openStateId);
        this._wifiChangedId = 0;
        this._openStateId = 0;
        this._wifi?.destroy();
        this._wifi = null;
        super.destroy();
    }
});
