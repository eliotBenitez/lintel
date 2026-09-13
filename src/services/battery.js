// SPDX-License-Identifier: GPL-2.0-or-later
//
// BatteryService — UPower "DisplayDevice" (the aggregate battery GNOME shows).
// Signatures verified live: Percentage (d), State (u), IsPresent (b),
// IconName (s), TimeToEmpty/TimeToFull (x) and EnergyRate (d).

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import {_, ngettext} from '../i18n.js';

const XML = `
<node><interface name="org.freedesktop.UPower.Device">
  <property name="Percentage" type="d" access="read"/>
  <property name="State" type="u" access="read"/>
  <property name="IsPresent" type="b" access="read"/>
  <property name="IconName" type="s" access="read"/>
  <property name="TimeToEmpty" type="x" access="read"/>
  <property name="TimeToFull" type="x" access="read"/>
  <property name="EnergyRate" type="d" access="read"/>
</interface></node>`;

const Proxy = Gio.DBusProxy.makeProxyWrapper(XML);

export const BatteryService = GObject.registerClass({
    Signals: {'changed': {}},
}, class BatteryService extends GObject.Object {
    _init() {
        super._init();
        this._proxy = null;
        this._propsId = 0;
        this._destroyed = false;
        new Proxy(Gio.DBus.system, 'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice',
            (proxy, error) => {
                if (this._destroyed)
                    return;
                if (error) {
                    logError(error, 'lintel: UPower DisplayDevice');
                    return;
                }
                this._proxy = proxy;
                this._propsId = proxy.connect(
                    'g-properties-changed', () => this.emit('changed'));
                this.emit('changed');
            });
    }

    get available() {
        return this._proxy?.IsPresent ?? false;
    }

    get percentage() {
        return Math.round(this._proxy?.Percentage ?? 0);
    }

    // UPower's IconName only has coarse buckets (full/good/low/caution/empty),
    // so 21% and 79% share a glyph.  Build the 10%-step name GNOME Shell's own
    // indicator uses; `fallbackIconName` covers themes without those icons.
    get iconName() {
        const proxy = this._proxy;
        if (!proxy?.IsPresent)
            return 'battery-missing-symbolic';
        const level = Math.min(100,
            10 * Math.floor((proxy.Percentage ?? 0) / 10));
        switch (proxy.State) {
        case 1: // charging
            return level === 100
                ? 'battery-level-100-charged-symbolic'
                : `battery-level-${level}-charging-symbolic`;
        case 4: // fully charged
            return 'battery-level-100-charged-symbolic';
        case 5: // pending charge: on AC but not charging
            return `battery-level-${level}-plugged-in-symbolic`;
        default:
            return `battery-level-${level}-symbolic`;
        }
    }

    get fallbackIconName() {
        return this._proxy?.IconName || 'battery-missing-symbolic';
    }

    get charging() {
        const s = this._proxy?.State;
        return s === 1 || s === 4; // charging | fully-charged
    }

    get statusText() {
        switch (this._proxy?.State ?? 0) {
        case 1:
            return _('Charging');
        case 2:
            return _('On Battery');
        case 3:
            return _('Empty');
        case 4:
            return _('Fully Charged');
        case 5:
            return _('Not Charging');
        case 6:
            return _('On Battery');
        default:
            return _('Battery');
        }
    }

    get powerSourceText() {
        switch (this._proxy?.State ?? 0) {
        case 1:
        case 4:
        case 5:
            return _('Power Adapter');
        default:
            return _('Battery');
        }
    }

    get timeText() {
        const seconds = this._proxy?.State === 1
            ? this._proxy?.TimeToFull ?? 0
            : this._proxy?.TimeToEmpty ?? 0;
        if (seconds <= 0)
            return '';

        const totalMinutes = Math.max(1, Math.round(seconds / 60));
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        const parts = [];
        if (hours > 0) {
            parts.push(ngettext('%d hour', '%d hours', hours).format(hours));
        }
        if (minutes > 0 || !parts.length) {
            parts.push(ngettext('%d minute', '%d minutes', minutes)
                .format(minutes));
        }
        const duration = parts.join(' ');
        return this._proxy?.State === 1
            ? _('%s until full').format(duration)
            : _('%s remaining').format(duration);
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (this._propsId && this._proxy)
            this._proxy.disconnect(this._propsId);
        this._propsId = 0;
        this._proxy = null;
    }
});
