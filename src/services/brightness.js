// SPDX-License-Identifier: GPL-2.0-or-later
//
// BrightnessService — screen backlight.
//   1) org.gnome.SettingsDaemon.Power.Screen (Brightness i, 0-100) when present.
//   2) otherwise `brightnessctl` (verified: `brightnessctl -m -c backlight` →
//      "amdgpu_bl1,backlight,62258,95%,65535", set via `brightnessctl set N%`).
// `available` is false only when neither works (e.g. a desktop with no backlight).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const NAME = 'org.gnome.SettingsDaemon.Power';
const PATH = '/org/gnome/SettingsDaemon/Power';
const IFACE = 'org.gnome.SettingsDaemon.Power.Screen';
const XML = `
<node><interface name="${IFACE}">
  <property name="Brightness" type="i" access="readwrite"/>
</interface></node>`;

const Proxy = Gio.DBusProxy.makeProxyWrapper(XML);

export const BrightnessService = GObject.registerClass({
    Signals: {'changed': {}},
}, class BrightnessService extends GObject.Object {
    _init() {
        super._init();
        this._proxy = null;
        this._propsId = 0;
        this._ctl = GLib.find_program_in_path('brightnessctl');
        this._ctlLevel = this._ctlGet(); // null if no backlight

        try {
            new Proxy(Gio.DBus.session, NAME, PATH, (proxy, error) => {
                if (error)
                    return;
                if ((proxy.Brightness ?? -1) < 0)
                    return; // no D-Bus backlight; keep brightnessctl path
                this._proxy = proxy;
                this._propsId = proxy.connect(
                    'g-properties-changed', () => this.emit('changed'));
                this.emit('changed');
            });
        } catch (_e) {
            // ignore — fall back to brightnessctl
        }
    }

    get available() {
        if (this._proxy && (this._proxy.Brightness ?? -1) >= 0)
            return true;
        return this._ctl != null && this._ctlLevel != null;
    }

    get level() {
        if (this._proxy && (this._proxy.Brightness ?? -1) >= 0)
            return Math.max(0, this._proxy.Brightness) / 100;
        return this._ctlLevel ?? 0;
    }

    setLevel(fraction) {
        const pct = Math.round(Math.max(0.01, Math.min(1, fraction)) * 100);
        if (this._proxy && (this._proxy.Brightness ?? -1) >= 0) {
            Gio.DBus.session.call(NAME, PATH,
                'org.freedesktop.DBus.Properties', 'Set',
                new GLib.Variant('(ssv)',
                    [IFACE, 'Brightness', GLib.Variant.new_int32(pct)]),
                null, Gio.DBusCallFlags.NONE, -1, null,
                (src, res) => {
                    try {
                        src.call_finish(res);
                    } catch (e) {
                        logError(e, 'lintel: set Brightness (dbus)');
                    }
                });
            return;
        }
        if (this._ctl) {
            try {
                GLib.spawn_command_line_async(
                    `brightnessctl -c backlight set ${pct}%`);
                this._ctlLevel = pct / 100;
            } catch (e) {
                logError(e, 'lintel: brightnessctl set');
            }
        }
    }

    /** Re-read the brightnessctl value (no change signal from the CLI). */
    refresh() {
        if (this._proxy)
            return;
        const v = this._ctlGet();
        if (v != null && v !== this._ctlLevel) {
            this._ctlLevel = v;
            this.emit('changed');
        } else if (v != null) {
            this._ctlLevel = v;
        }
    }

    _ctlGet() {
        if (!this._ctl)
            return null;
        try {
            const [ok, out] = GLib.spawn_command_line_sync(
                'brightnessctl -m -c backlight');
            if (!ok || !out)
                return null;
            const text = new TextDecoder().decode(out).trim();
            const line = text.split('\n').filter(l => l.length).pop();
            if (!line)
                return null;
            const pct = parseInt(line.split(',')[3], 10); // "95%" → 95
            return Number.isFinite(pct) ? pct / 100 : null;
        } catch (_e) {
            return null;
        }
    }

    destroy() {
        if (this._propsId && this._proxy)
            this._proxy.disconnect(this._propsId);
        this._proxy = null;
    }
});
