// SPDX-License-Identifier: GPL-2.0-or-later
//
// GeoLocator — the user's approximate position from GeoClue, for weather.
//
// Uses the Shell's own GeoClue identity and accuracy ('org.gnome.Shell', CITY),
// which geoclue.conf allows as a system component. The Shell's location agent
// still enforces Settings → Privacy → Location: with it off, GeoClue refuses at
// once with AccessDenied ("Geolocation disabled for UID …"), reported here as
// state 'disabled'. There is deliberately no IP-geolocation fallback — turning
// Location off must mean no position leaves the machine.
//
// Geoclue.Simple.new is called with an explicit callback instead of through
// Gio._promisify, which would patch the Geoclue class the Shell's own weather
// client has already promisified.

import Geoclue from 'gi://Geoclue';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import GWeather from 'gi://GWeather';

const DESKTOP_ID = 'org.gnome.Shell';
const DISTANCE_THRESHOLD_M = 1000;

function _stopClient(simple) {
    try {
        simple?.get_client()?.call_stop(null, null);
    } catch (_e) {
        // The client may already be gone with the service.
    }
}

function _nearestCityName(latitude, longitude) {
    try {
        const city = GWeather.Location.get_world()
            ?.find_nearest_city(latitude, longitude);
        return city?.get_city_name() || city?.get_name() || '';
    } catch (_e) {
        return '';
    }
}

export const GeoLocator = GObject.registerClass({
    Signals: {'changed': {}},
}, class GeoLocator extends GObject.Object {
    _init() {
        super._init();
        this._state = 'idle';
        this._location = null;
        this._simple = null;
        this._simpleId = 0;
        this._cancellable = null;
        this._destroyed = false;

        this._privacy = null;
        this._privacyId = 0;
        try {
            this._privacy = new Gio.Settings({schema_id: 'org.gnome.system.location'});
            this._privacyId = this._privacy.connect('changed::enabled', () => {
                this._stop();
                this._location = null;
                this.start();
            });
        } catch (_e) {
            this._privacy = null;
        }
    }

    /** 'idle', 'locating', 'ready', 'disabled' or 'error'. */
    get state() {
        return this._state;
    }

    /** {name, latitude, longitude, timezone} once state is 'ready'. */
    get location() {
        return this._location;
    }

    start() {
        if (this._destroyed || this._simple || this._cancellable)
            return;
        if (this._privacy && !this._privacy.get_boolean('enabled')) {
            this._setState('disabled');
            return;
        }

        this._setState('locating');
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        Geoclue.Simple.new(DESKTOP_ID, Geoclue.AccuracyLevel.CITY, cancellable,
            (_source, result) => {
                let simple;
                try {
                    simple = Geoclue.Simple.new_finish(result);
                } catch (e) {
                    if (cancellable.is_cancelled() || this._destroyed)
                        return;
                    this._cancellable = null;
                    const denied = Gio.DBusError.get_remote_error(e) ===
                        'org.freedesktop.DBus.Error.AccessDenied';
                    if (!denied)
                        console.warn(`lintel: GeoClue: ${e.message}`);
                    this._setState(denied ? 'disabled' : 'error');
                    return;
                }

                if (cancellable.is_cancelled() || this._destroyed) {
                    _stopClient(simple);
                    return;
                }
                this._cancellable = null;
                this._simple = simple;
                try {
                    simple.get_client().distance_threshold = DISTANCE_THRESHOLD_M;
                } catch (_e) {
                    // Only a tuning knob.
                }
                this._simpleId = simple.connect('notify::location', () => this._sync());
                this._sync();
            });
    }

    _sync() {
        const geo = this._simple?.get_location();
        if (!geo || !Number.isFinite(geo.latitude) || !Number.isFinite(geo.longitude))
            return;
        this._location = {
            name: _nearestCityName(geo.latitude, geo.longitude),
            latitude: geo.latitude,
            longitude: geo.longitude,
            // The user is where the session is: forecast hours use local time.
            timezone: '',
        };
        this._setState('ready');
    }

    _setState(state) {
        this._state = state;
        this.emit('changed');
    }

    _stop() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._simple) {
            if (this._simpleId)
                this._simple.disconnect(this._simpleId);
            this._simpleId = 0;
            _stopClient(this._simple);
            this._simple = null;
        }
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._stop();
        if (this._privacyId && this._privacy)
            this._privacy.disconnect(this._privacyId);
        this._privacyId = 0;
        this._privacy?.run_dispose();
        this._privacy = null;
        this._location = null;
    }
});
