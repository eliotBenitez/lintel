// SPDX-License-Identifier: GPL-2.0-or-later
//
// Independent menu-bar battery status item with its own Tahoe-style popup.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {_} from '../i18n.js';
import {BatteryService} from '../services/battery.js';
import {
    PowerProfilesService,
    powerProfileLabel,
} from '../services/powerProfiles.js';
import {styleStatusMenu} from './statusMenu.js';

export const LintelBatteryMenu = GObject.registerClass(
class LintelBatteryMenu extends PanelMenu.Button {
    _init() {
        super._init(0.0, _('Battery'), false);
        this.add_style_class_name('lintel-status-button');

        this._battery = new BatteryService();
        this._profiles = new PowerProfilesService();
        this._batteryChangedId = 0;
        this._profilesChangedId = 0;
        this._profileSignature = '';

        const indicator = new St.BoxLayout({
            style_class: 'lintel-battery-indicator',
        });
        this._panelIcon = new St.Icon({style_class: 'system-status-icon'});
        this._panelLabel = new St.Label({
            style_class: 'lintel-battery-percentage',
            y_align: Clutter.ActorAlign.CENTER,
        });
        indicator.add_child(this._panelIcon);
        indicator.add_child(this._panelLabel);
        this.add_child(indicator);

        styleStatusMenu(this.menu, 'lintel-battery-menu-content');
        this._buildMenu();

        this._batteryChangedId = this._battery.connect(
            'changed', () => this._sync());
        this._profilesChangedId = this._profiles.connect(
            'changed', () => this._sync());
        this._sync();
    }

    _buildMenu() {
        const summary = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'lintel-battery-summary',
        });
        this._summaryIcon = new St.Icon({
            style_class: 'lintel-battery-summary-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        summary.add_child(this._summaryIcon);

        const labels = new St.BoxLayout({
            vertical: true,
            style_class: 'lintel-battery-summary-labels',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._summaryPercentage = new St.Label({
            style_class: 'lintel-battery-summary-percentage',
        });
        this._summaryStatus = new St.Label({
            style_class: 'lintel-battery-summary-status',
        });
        this._summaryTime = new St.Label({
            style_class: 'lintel-battery-summary-time',
        });
        labels.add_child(this._summaryPercentage);
        labels.add_child(this._summaryStatus);
        labels.add_child(this._summaryTime);
        summary.add_child(labels);
        this.menu.addMenuItem(summary);

        this._powerSourceItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this._powerSourceItem.add_style_class_name('lintel-battery-source');
        this.menu.addMenuItem(this._powerSourceItem);

        this._profileHeading = new PopupMenu.PopupMenuItem(_('Power Mode'), {
            reactive: false,
            can_focus: false,
        });
        this._profileHeading.add_style_class_name('lintel-status-section-title');
        this.menu.addMenuItem(this._profileHeading);

        this._profilesSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._profilesSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addSettingsAction(_('Battery Settings…'), 'gnome-power-panel.desktop');
    }

    _sync() {
        if (!this._battery || !this._profiles)
            return;
        const available = this._battery.available;
        this.visible = available;
        if (!available)
            return;

        const percentage = `${this._battery.percentage}%`;
        const status = this._battery.statusText;
        const time = this._battery.timeText;
        const iconName = this._battery.iconName;
        const fallbackIconName = this._battery.fallbackIconName;
        this._panelIcon.set({icon_name: iconName, fallback_icon_name: fallbackIconName});
        this._panelLabel.text = percentage;
        this.accessible_name = _('Battery, %s, %s').format(percentage, status);

        this._summaryIcon.set({icon_name: iconName, fallback_icon_name: fallbackIconName});
        this._summaryPercentage.text = percentage;
        this._summaryStatus.text = status;
        this._summaryTime.text = time;
        this._summaryTime.visible = time.length > 0;
        this._powerSourceItem.label.text = _('Power Source: %s')
            .format(this._battery.powerSourceText);

        const profiles = this._profiles.profiles;
        const profileVisible = this._profiles.available;
        this._profileHeading.visible = profileVisible;
        this._profilesSection.actor.visible = profileVisible;
        const signature = `${profiles.join(',')}|${this._profiles.activeProfile}`;
        if (signature !== this._profileSignature) {
            this._profileSignature = signature;
            this._rebuildProfiles(profiles);
        }
    }

    _rebuildProfiles(profiles) {
        this._profilesSection.removeAll();
        for (const profile of profiles) {
            const item = new PopupMenu.PopupMenuItem(
                powerProfileLabel(profile));
            item.setOrnament(profile === this._profiles.activeProfile
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
            item.connect('activate', () => {
                this._profiles.setProfile(profile);
                this.menu.close();
            });
            this._profilesSection.addMenuItem(item);
        }
    }

    destroy() {
        if (this._batteryChangedId && this._battery)
            this._battery.disconnect(this._batteryChangedId);
        if (this._profilesChangedId && this._profiles)
            this._profiles.disconnect(this._profilesChangedId);
        this._batteryChangedId = 0;
        this._profilesChangedId = 0;
        this._battery?.destroy();
        this._profiles?.destroy();
        this._battery = null;
        this._profiles = null;
        super.destroy();
    }
});
