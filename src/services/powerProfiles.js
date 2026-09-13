// SPDX-License-Identifier: GPL-2.0-or-later
//
// PowerProfilesService — the system power-profile daemon used by GNOME's own
// Quick Settings.  It is optional; the battery popup simply omits its section
// on hardware or systems that do not provide it.

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import {_} from '../i18n.js';

const BUS_NAME = 'org.freedesktop.UPower.PowerProfiles';
const OBJECT_PATH = '/org/freedesktop/UPower/PowerProfiles';
const XML = `
<node><interface name="${BUS_NAME}">
  <property name="ActiveProfile" type="s" access="readwrite"/>
  <property name="Profiles" type="aa{sv}" access="read"/>
</interface></node>`;

const Proxy = Gio.DBusProxy.makeProxyWrapper(XML);

export const PowerProfilesService = GObject.registerClass({
    Signals: {'changed': {}},
}, class PowerProfilesService extends GObject.Object {
    _init() {
        super._init();
        this._proxy = null;
        this._signals = [];
        this._destroyed = false;

        new Proxy(Gio.DBus.system, BUS_NAME, OBJECT_PATH, (proxy, error) => {
            if (this._destroyed)
                return;
            if (error)
                return;
            this._proxy = proxy;
            for (const signal of ['g-properties-changed', 'notify::g-name-owner'])
                this._signals.push(proxy.connect(signal, () => this.emit('changed')));
            this.emit('changed');
        });
    }

    get available() {
        return Boolean(this._proxy?.g_name_owner && this.profiles.length);
    }

    get activeProfile() {
        return this._proxy?.ActiveProfile ?? '';
    }

    get profiles() {
        try {
            return (this._proxy?.Profiles ?? [])
                .map(profile => profile.Profile?.unpack?.() ?? profile.Profile)
                .filter(Boolean);
        } catch (_e) {
            return [];
        }
    }

    setProfile(profile) {
        if (!this._proxy || !this.profiles.includes(profile))
            return;
        try {
            this._proxy.ActiveProfile = profile;
        } catch (e) {
            logError(e, `lintel: set power profile ${profile}`);
        }
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (this._proxy) {
            for (const id of this._signals)
                this._proxy.disconnect(id);
        }
        this._signals = [];
        this._proxy = null;
    }
});

export function powerProfileLabel(profile) {
    switch (profile) {
    case 'power-saver':
        return _('Power Saver');
    case 'balanced':
        return _('Balanced');
    case 'performance':
        return _('High Performance');
    default:
        return _('Custom');
    }
}
