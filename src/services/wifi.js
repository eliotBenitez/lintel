// SPDX-License-Identifier: GPL-2.0-or-later
//
// WiFiService — a focused libnm model for the standalone menu-bar Wi-Fi menu.
// Unlike ConnectivityService (which only needs an on/off switch for Control
// Center), this service exposes real access points, signal/security state and
// activation.  GNOME Shell's already-running NetworkAgent supplies password
// prompts for personal networks; unsaved enterprise networks fall back to the
// native Wi-Fi settings panel.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import NM from 'gi://NM';

const SCAN_INTERVAL_SECONDS = 15;
const NM80211Mode = NM['80211Mode'];
const SECURITY_TYPES = Object.values(NM.UtilsSecurityType)
    .filter(Number.isInteger)
    .sort((a, b) => b - a);

export const WifiService = GObject.registerClass({
    Signals: {'changed': {}},
}, class WifiService extends GObject.Object {
    _init() {
        super._init();

        this._client = null;
        this._clientSignals = [];
        this._deviceSignals = [];
        this._accessPointSignals = [];
        this._devices = [];
        this._cancellable = new Gio.Cancellable();
        this._scanId = 0;
        this._scanning = false;
        this._destroyed = false;

        NM.Client.new_async(this._cancellable, (_source, result) => {
            let client = null;
            try {
                client = NM.Client.new_finish(result);
            } catch (e) {
                if (!this._destroyed)
                    logError(e, 'lintel: create NetworkManager client');
                return;
            }
            if (this._destroyed) {
                client.run_dispose();
                return;
            }
            this._setClient(client);
        });
    }

    get available() {
        return Boolean(this._client?.nm_running && this._devices.length);
    }

    get hardwareEnabled() {
        return this._client?.wireless_hardware_enabled ?? false;
    }

    get enabled() {
        return this._client?.wireless_enabled ?? false;
    }

    setEnabled(enabled) {
        if (!this._client || !this.hardwareEnabled)
            return;
        try {
            this._client.wireless_enabled = Boolean(enabled);
        } catch (e) {
            logError(e, 'lintel: change Wi-Fi state');
        }
    }

    get activeNetwork() {
        return this.networks.find(network => network.active)?.name ?? '';
    }

    get iconName() {
        if (!this.enabled)
            return 'network-wireless-disabled-symbolic';

        const device = this._devices.find(d => d.active_connection) ??
            this._devices[0];
        if (!device)
            return 'network-wireless-signal-none-symbolic';

        if (device.state === NM.DeviceState.PREPARE ||
            device.state === NM.DeviceState.CONFIG ||
            device.state === NM.DeviceState.NEED_AUTH ||
            device.state === NM.DeviceState.IP_CONFIG ||
            device.state === NM.DeviceState.IP_CHECK ||
            device.state === NM.DeviceState.SECONDARIES)
            return 'network-wireless-acquiring-symbolic';

        const ap = device.active_access_point;
        if (!ap)
            return 'network-wireless-signal-none-symbolic';
        if (this._client.connectivity !== NM.ConnectivityState.FULL)
            return 'network-wireless-no-route-symbolic';
        return signalIcon(ap.strength);
    }

    get networks() {
        const groups = new Map();

        for (const device of this._devices) {
            const connections = device.get_available_connections();
            for (const ap of device.get_access_points()) {
                const ssid = ap.get_ssid();
                if (!ssid)
                    continue;
                const name = NM.utils_ssid_to_utf8(ssid.get_data());
                if (!name)
                    continue;

                const securityType = this._securityType(device, ap);
                if (securityType === NM.UtilsSecurityType.INVALID)
                    continue;
                const key = `${name}\u0000${securityType}`;
                const active = device.active_access_point === ap;
                const known = connections.some(connection => {
                    try {
                        return ap.connection_valid(connection);
                    } catch (_e) {
                        return false;
                    }
                });
                const current = groups.get(key);
                if (!current) {
                    groups.set(key, {
                        name,
                        strength: ap.strength,
                        secure: isSecureType(securityType),
                        securityType,
                        active,
                        known,
                        iconName: signalIcon(ap.strength),
                        device,
                        accessPoint: ap,
                    });
                    continue;
                }

                current.active ||= active;
                current.known ||= known;
                if (active || (!current.active && ap.strength > current.strength)) {
                    current.strength = ap.strength;
                    current.iconName = signalIcon(ap.strength);
                    current.device = device;
                    current.accessPoint = ap;
                }
            }
        }

        return [...groups.values()].sort((a, b) =>
            Number(b.active) - Number(a.active) ||
            Number(b.known) - Number(a.known) ||
            b.strength - a.strength ||
            GLib.utf8_collate(a.name, b.name));
    }

    /** Connect to an AP, or disconnect it when it is already active. */
    toggleNetwork(network) {
        if (!this._client || !network?.device || !network?.accessPoint)
            return false;
        if (network.active) {
            const active = network.device.active_connection;
            if (active)
                this._deactivate(active);
            return true;
        }

        const {device, accessPoint} = network;
        const saved = device.get_available_connections().find(connection => {
            try {
                return accessPoint.connection_valid(connection);
            } catch (_e) {
                return false;
            }
        });
        if (saved) {
            try {
                this._client.activate_connection_async(
                    saved, device, accessPoint.get_path(), this._cancellable,
                    (client, result) => {
                        if (this._destroyed)
                            return;
                        try {
                            client.activate_connection_finish(result);
                        } catch (e) {
                            logError(e, `lintel: connect to ${network.name}`);
                        }
                    });
            } catch (e) {
                logError(e, `lintel: connect to ${network.name}`);
            }
            return true;
        }

        // NetworkManager cannot infer an unsaved 802.1x configuration. The
        // caller opens the native Wi-Fi panel for that one specialized case.
        if (isEnterpriseType(network.securityType))
            return false;

        const connection = new NM.SimpleConnection();
        const setting = new NM.SettingConnection();
        setting.add_permission('user', GLib.get_user_name(), null);
        connection.add_setting(setting);
        try {
            this._client.add_and_activate_connection_async(
                connection, device, accessPoint.get_path(), this._cancellable,
                (client, result) => {
                    if (this._destroyed)
                        return;
                    try {
                        client.add_and_activate_connection_finish(result);
                    } catch (e) {
                        logError(e, `lintel: connect to ${network.name}`);
                    }
                });
        } catch (e) {
            logError(e, `lintel: connect to ${network.name}`);
        }
        return true;
    }

    startScanning() {
        if (this._scanning)
            return;
        this._scanning = true;
        this.requestScan();
        this._scanId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, SCAN_INTERVAL_SECONDS, () => {
                this.requestScan();
                return GLib.SOURCE_CONTINUE;
            });
    }

    stopScanning() {
        this._scanning = false;
        if (this._scanId) {
            GLib.Source.remove(this._scanId);
            this._scanId = 0;
        }
    }

    requestScan() {
        if (!this.enabled)
            return;
        for (const device of this._devices) {
            try {
                device.request_scan_async(this._cancellable, (source, result) => {
                    if (this._destroyed)
                        return;
                    try {
                        source.request_scan_finish(result);
                    } catch (e) {
                        logError(e, 'lintel: request Wi-Fi scan');
                    }
                });
            } catch (e) {
                logError(e, 'lintel: request Wi-Fi scan');
            }
        }
    }

    _setClient(client) {
        this._client = client;
        const changed = () => this._emitChanged();
        const devicesChanged = () => this._syncDevices();
        for (const signal of [
            'notify::nm-running',
            'notify::wireless-enabled',
            'notify::wireless-hardware-enabled',
            'notify::primary-connection',
            'notify::connectivity',
            'connection-added',
            'connection-removed',
        ])
            this._connect(client, signal, changed, this._clientSignals);
        this._connect(client, 'device-added', devicesChanged, this._clientSignals);
        this._connect(client, 'device-removed', devicesChanged, this._clientSignals);
        this._syncDevices();
        if (this._scanning)
            this.requestScan();
    }

    _syncDevices() {
        this._disconnectAll(this._deviceSignals);
        this._disconnectAll(this._accessPointSignals);
        this._devices = this._client?.get_devices()
            .filter(device => device.device_type === NM.DeviceType.WIFI) ?? [];

        for (const device of this._devices) {
            for (const signal of [
                'state-changed',
                'notify::active-access-point',
                'notify::active-connection',
                'notify::available-connections',
            ]) {
                this._connect(device, signal,
                    () => this._emitChanged(), this._deviceSignals);
            }
            this._connect(device, 'access-point-added', () => {
                this._syncAccessPoints();
                this._emitChanged();
            }, this._deviceSignals);
            this._connect(device, 'access-point-removed', () => {
                this._syncAccessPoints();
                this._emitChanged();
            }, this._deviceSignals);
        }
        this._syncAccessPoints();
        this._emitChanged();
    }

    _syncAccessPoints() {
        this._disconnectAll(this._accessPointSignals);
        for (const device of this._devices) {
            for (const ap of device.get_access_points()) {
                for (const signal of [
                    'notify::strength',
                    'notify::ssid',
                    'notify::flags',
                    'notify::wpa-flags',
                    'notify::rsn-flags',
                ]) {
                    this._connect(ap, signal,
                        () => this._emitChanged(), this._accessPointSignals);
                }
            }
        }
    }

    _securityType(device, ap) {
        const caps = device.wirelessCapabilities;
        const haveAp = true;
        const adHoc = ap.mode === NM80211Mode.ADHOC;
        return SECURITY_TYPES.find(type => NM.utils_security_valid(
            type, caps, haveAp, adHoc,
            ap.flags, ap.wpaFlags, ap.rsnFlags)) ??
            NM.UtilsSecurityType.INVALID;
    }

    _deactivate(active) {
        try {
            this._client.deactivate_connection_async(
                active, this._cancellable, (client, result) => {
                    if (this._destroyed)
                        return;
                    try {
                        client.deactivate_connection_finish(result);
                    } catch (e) {
                        logError(e, 'lintel: disconnect Wi-Fi');
                    }
                });
        } catch (e) {
            logError(e, 'lintel: disconnect Wi-Fi');
        }
    }

    _connect(object, signal, callback, bucket) {
        try {
            bucket.push([object, object.connect(signal, callback)]);
        } catch (e) {
            logError(e, `lintel: connect Wi-Fi signal ${signal}`);
        }
    }

    _disconnectAll(bucket) {
        for (const [object, id] of bucket) {
            try {
                object.disconnect(id);
            } catch (_e) {
                // The object may already have vanished with NetworkManager.
            }
        }
        bucket.length = 0;
    }

    _emitChanged() {
        if (!this._destroyed)
            this.emit('changed');
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this.stopScanning();
        this._cancellable?.cancel();
        const client = this._client;
        this._disconnectAll(this._accessPointSignals);
        this._disconnectAll(this._deviceSignals);
        this._disconnectAll(this._clientSignals);
        this._devices = [];
        this._client = null;
        this._cancellable = null;
        client?.run_dispose();
    }
});

function signalIcon(strength) {
    let quality = 'excellent';
    if (strength < 20)
        quality = 'none';
    else if (strength < 40)
        quality = 'weak';
    else if (strength < 50)
        quality = 'ok';
    else if (strength < 80)
        quality = 'good';
    return `network-wireless-signal-${quality}-symbolic`;
}

function isSecureType(type) {
    return type !== NM.UtilsSecurityType.NONE &&
        type !== NM.UtilsSecurityType.OWE;
}

function isEnterpriseType(type) {
    return type === NM.UtilsSecurityType.WPA_ENTERPRISE ||
        type === NM.UtilsSecurityType.WPA2_ENTERPRISE ||
        type === NM.UtilsSecurityType.WPA3_SUITE_B_192;
}
