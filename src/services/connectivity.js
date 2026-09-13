// SPDX-License-Identifier: GPL-2.0-or-later
//
// ConnectivityService — Wi-Fi via NetworkManager, Bluetooth/Airplane via GNOME's
// Rfkill service. We only read/flip well-defined properties on existing daemons
// (no NM/BlueZ reimplementation). Signatures verified live:
//   NM   /org/freedesktop/NetworkManager      WirelessEnabled(b rw), Connectivity(u)
//   Rfkill /org/gnome/SettingsDaemon/Rfkill    AirplaneMode(b rw), HasAirplaneMode(b),
//          BluetoothAirplaneMode(b rw), BluetoothHasAirplaneMode(b)

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const NM_NAME = 'org.freedesktop.NetworkManager';
const NM_PATH = '/org/freedesktop/NetworkManager';
const NM_XML = `
<node><interface name="${NM_NAME}">
  <property name="WirelessEnabled" type="b" access="readwrite"/>
  <property name="Connectivity" type="u" access="read"/>
</interface></node>`;

const RFKILL_NAME = 'org.gnome.SettingsDaemon.Rfkill';
const RFKILL_PATH = '/org/gnome/SettingsDaemon/Rfkill';
const RFKILL_XML = `
<node><interface name="${RFKILL_NAME}">
  <property name="AirplaneMode" type="b" access="readwrite"/>
  <property name="HasAirplaneMode" type="b" access="read"/>
  <property name="BluetoothAirplaneMode" type="b" access="readwrite"/>
  <property name="BluetoothHasAirplaneMode" type="b" access="read"/>
</interface></node>`;

const NMProxy = Gio.DBusProxy.makeProxyWrapper(NM_XML);
const RfkillProxy = Gio.DBusProxy.makeProxyWrapper(RFKILL_XML);

export const ConnectivityService = GObject.registerClass({
    Signals: {'changed': {}},
}, class ConnectivityService extends GObject.Object {
    _init() {
        super._init();
        this._nm = null;
        this._rfkill = null;
        this._nmId = 0;
        this._rfkillId = 0;

        new NMProxy(Gio.DBus.system, NM_NAME, NM_PATH, (proxy, error) => {
            if (error)
                return; // NM absent — Wi-Fi tile hidden.
            this._nm = proxy;
            this._nmId = proxy.connect('g-properties-changed',
                () => this.emit('changed'));
            this.emit('changed');
        });

        new RfkillProxy(Gio.DBus.session, RFKILL_NAME, RFKILL_PATH,
            (proxy, error) => {
                if (error)
                    return; // Rfkill absent — BT/airplane tiles hidden.
                this._rfkill = proxy;
                this._rfkillId = proxy.connect('g-properties-changed',
                    () => this.emit('changed'));
                this.emit('changed');
            });
    }

    // ---- Wi-Fi --------------------------------------------------------------

    get wifiAvailable() {
        return this._nm != null;
    }

    get wifiEnabled() {
        return this._nm?.WirelessEnabled ?? false;
    }

    setWifi(on) {
        this._setProp(Gio.DBus.system, NM_NAME, NM_PATH, NM_NAME,
            'WirelessEnabled', GLibBool(on));
    }

    get networkIcon() {
        if (!this._nm)
            return 'network-wired-symbolic';
        return this._nm.WirelessEnabled
            ? 'network-wireless-signal-good-symbolic'
            : 'network-wireless-offline-symbolic';
    }

    // ---- Bluetooth ----------------------------------------------------------

    get bluetoothAvailable() {
        return this._rfkill?.BluetoothHasAirplaneMode ?? false;
    }

    get bluetoothEnabled() {
        // "airplane mode for bluetooth" is the inverse of "bluetooth on".
        return this._rfkill ? !this._rfkill.BluetoothAirplaneMode : false;
    }

    setBluetooth(on) {
        this._setProp(Gio.DBus.session, RFKILL_NAME, RFKILL_PATH, RFKILL_NAME,
            'BluetoothAirplaneMode', GLibBool(!on));
    }

    // ---- Airplane -----------------------------------------------------------

    get airplaneAvailable() {
        return this._rfkill?.HasAirplaneMode ?? false;
    }

    get airplaneEnabled() {
        return this._rfkill?.AirplaneMode ?? false;
    }

    setAirplane(on) {
        this._setProp(Gio.DBus.session, RFKILL_NAME, RFKILL_PATH, RFKILL_NAME,
            'AirplaneMode', GLibBool(on));
    }

    // ---- helpers ------------------------------------------------------------

    _setProp(bus, name, path, iface, prop, variant) {
        bus.call(name, path, 'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', [iface, prop, variant]),
            null, Gio.DBusCallFlags.NONE, -1, null,
            (src, res) => {
                try {
                    src.call_finish(res);
                } catch (e) {
                    logError(e, `lintel: set ${prop}`);
                }
            });
    }

    destroy() {
        if (this._nmId && this._nm)
            this._nm.disconnect(this._nmId);
        if (this._rfkillId && this._rfkill)
            this._rfkill.disconnect(this._rfkillId);
        this._nm = null;
        this._rfkill = null;
    }
});

function GLibBool(v) {
    return GLib.Variant.new_boolean(!!v);
}
