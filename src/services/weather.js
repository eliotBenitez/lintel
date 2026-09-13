// SPDX-License-Identifier: GPL-2.0-or-later
//
// WeatherService — the Notification Center weather model.
//
// Forecasts come from a keyless web service (weatherProviders.js) for either the
// city chosen in preferences or the user's position from GeoClue
// (geolocation.js). Automatic mode falls back to the chosen city when Location
// Services are off or fail.
//
// One WeatherStore serves every weather widget alive at a time and is destroyed
// with the last one, so disable() leaves no HTTP session, timer or GeoClue
// client behind. Editing the widget layout rebuilds every widget and so drops
// the store; the last forecast is kept in a plain module-level cache, so a
// rebuild repaints at once instead of refetching.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GWeather from 'gi://GWeather';

import {GeoLocator} from './geolocation.js';
import {
    fetchForecast,
    iconFor,
    newSession,
    preferredLanguage,
} from './weatherProviders.js';

const FORECAST_COUNT = 6;
const REFRESH_INTERVAL_S = 30 * 60;
const STALE_AFTER_S = 10 * 60;
const RETRY_AFTER_S = 60;
const MAX_AGE_S = 3 * 60 * 60;
const CLEAR_KINDS = new Set(['clear', 'mostly-clear', 'partly-cloudy']);
const SUNNY_KINDS = new Set(['clear', 'mostly-clear']);
const SETTINGS_KEYS = [
    'weather-provider',
    'weather-units',
    'weather-location-mode',
    'weather-location',
];

let _cache = null;
let _lastAutoLocation = null;
let _store = null;
let _storeUsers = 0;

function _now() {
    return Math.floor(Date.now() / 1000);
}

/** 'celsius' or 'fahrenheit', as the session's region measures temperature. */
export function localeTemperatureUnit() {
    try {
        const unit = GWeather.TemperatureUnit.to_real(GWeather.TemperatureUnit.DEFAULT);
        return unit === GWeather.TemperatureUnit.FAHRENHEIT ? 'fahrenheit' : 'celsius';
    } catch (_e) {
        return 'celsius';
    }
}

// Tahoe prints a bare "83°"; the unit is a preference, not part of the reading.
function _formatTemperature(value) {
    return Number.isFinite(value) ? `${Math.round(value)}°` : '—';
}

const WeatherStore = GObject.registerClass({
    Signals: {'changed': {}},
}, class WeatherStore extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._settingsIds = [];
        this._destroyed = false;
        this._session = newSession();
        this._language = preferredLanguage();
        this._locator = null;
        this._locatorId = 0;
        this._cancellable = null;
        this._pendingKey = '';
        this._failedKey = '';
        this._failedAt = 0;
        this._config = null;
        this._location = null;
        this._entry = null;
        this._status = 'loading';

        try {
            this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        } catch (_e) {
            this._interface = null;
        }

        for (const key of SETTINGS_KEYS) {
            try {
                this._settingsIds.push(settings.connect(
                    `changed::${key}`, () => this._reconfigure()));
            } catch (_e) {
                // No settings, or a stale compiled schema: defaults apply.
            }
        }
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW,
            REFRESH_INTERVAL_S, () => {
                this.update();
                return GLib.SOURCE_CONTINUE;
            });
        this._reconfigure();
    }

    get status() {
        return this._status;
    }

    get data() {
        const entry = this._entry;
        return entry && _now() - entry.fetchedAt < MAX_AGE_S ? entry.data : null;
    }

    get locationName() {
        return this._location?.name || this.data?.locationName || '';
    }

    get hourFormat() {
        try {
            return this._interface?.get_string('clock-format') === '12h'
                ? '%-l %p'
                : '%H:%M';
        } catch (_e) {
            return '%H:%M';
        }
    }

    _readConfig() {
        const settings = this._settings;
        const read = (key, fallback) => {
            try {
                return settings.get_string(key) || fallback;
            } catch (_e) {
                return fallback;
            }
        };

        let city = null;
        try {
            const [name, latitude, longitude, timezone] =
                settings.get_value('weather-location').deep_unpack();
            if (name && Number.isFinite(latitude) && Number.isFinite(longitude))
                city = {name, latitude, longitude, timezone};
        } catch (_e) {
            city = null;
        }

        const units = read('weather-units', 'auto');
        return {
            provider: read('weather-provider', 'open-meteo'),
            unit: units === 'auto' ? localeTemperatureUnit() : units,
            auto: read('weather-location-mode', 'auto') === 'auto',
            city,
        };
    }

    _reconfigure() {
        if (this._destroyed)
            return;
        this._config = this._readConfig();
        if (this._config.auto && !this._locator) {
            this._locator = new GeoLocator();
            this._locatorId = this._locator.connect('changed', () => this.update());
            this._locator.start();
        } else if (!this._config.auto && this._locator) {
            this._destroyLocator();
        }
        this.update();
    }

    _resolveLocation() {
        const {auto, city} = this._config;
        if (!auto)
            return city ? {location: city} : {status: 'no-location'};

        const state = this._locator?.state;
        if (state === 'ready' && this._locator.location) {
            _lastAutoLocation = this._locator.location;
            return {location: _lastAutoLocation};
        }
        if (state === 'disabled' || state === 'error') {
            if (city)
                return {location: city};
            return {status: state === 'disabled' ? 'location-disabled' : 'location-error'};
        }
        // Still locating: keep the previous position rather than blanking.
        return _lastAutoLocation ? {location: _lastAutoLocation} : {status: 'locating'};
    }

    /** Fetch when the place, service or unit changed, or the data is stale. */
    update() {
        if (this._destroyed || !this._config)
            return;

        const {location, status} = this._resolveLocation();
        this._location = location ?? null;
        if (!location) {
            this._cancel();
            this._entry = null;
            this._setStatus(status);
            return;
        }

        const {provider, unit} = this._config;
        const key = [
            provider,
            unit,
            location.latitude.toFixed(3),
            location.longitude.toFixed(3),
        ].join('|');
        if (this._entry?.key !== key)
            this._entry = _cache?.key === key ? _cache : null;
        if (this._pendingKey === key)
            return;

        const now = _now();
        if (this._entry && now - this._entry.fetchedAt < STALE_AFTER_S) {
            this._setStatus('ok');
            return;
        }
        if (this._failedKey === key && now - this._failedAt < RETRY_AFTER_S) {
            this._setStatus(this.data ? 'ok' : 'error');
            return;
        }
        this._fetch(key, location);
    }

    async _fetch(key, location) {
        this._cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._pendingKey = key;
        const {provider, unit} = this._config;
        if (!this.data)
            this._setStatus('loading');

        try {
            const data = await fetchForecast(this._session, provider, location,
                unit, this._language, cancellable);
            if (cancellable.is_cancelled())
                return;
            _cache = {key, data, fetchedAt: _now()};
            this._entry = _cache;
            this._failedKey = '';
            this._setStatus('ok');
        } catch (e) {
            if (cancellable.is_cancelled())
                return;
            console.warn(`lintel: weather from ${provider} failed: ${e.message}`);
            this._failedKey = key;
            this._failedAt = _now();
            // A forecast for this place that is merely old still beats nothing.
            this._setStatus(this.data ? 'ok' : 'error');
        } finally {
            if (this._cancellable === cancellable) {
                this._cancellable = null;
                this._pendingKey = '';
            }
        }
    }

    _setStatus(status) {
        this._status = status;
        this.emit('changed');
    }

    _cancel() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._pendingKey = '';
    }

    _destroyLocator() {
        if (this._locatorId && this._locator)
            this._locator.disconnect(this._locatorId);
        this._locatorId = 0;
        this._locator?.destroy();
        this._locator = null;
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._cancel();
        if (this._timerId)
            GLib.Source.remove(this._timerId);
        this._timerId = 0;
        for (const id of this._settingsIds)
            this._settings?.disconnect(id);
        this._settingsIds = [];
        this._destroyLocator();
        this._session?.abort();
        this._session = null;
        this._interface?.run_dispose();
        this._interface = null;
        this._settings = null;
        this._config = null;
        this._entry = null;
    }
});

export const WeatherService = GObject.registerClass({
    Signals: {'changed': {}},
}, class WeatherService extends GObject.Object {
    _init(settings = null) {
        super._init();
        if (!_store)
            _store = new WeatherStore(settings);
        _storeUsers++;
        this._store = _store;
        this._storeId = this._store.connect('changed', () => this.emit('changed'));
    }

    /**
     * 'ok', 'loading', 'locating', 'no-location', 'location-disabled',
     * 'location-error' or 'error'.
     */
    get status() {
        return this._store?.status ?? 'error';
    }

    get valid() {
        return Boolean(this._store?.data);
    }

    get locationName() {
        return this._store?.locationName ?? '';
    }

    get temperature() {
        return _formatTemperature(this._store?.data?.current.temperature);
    }

    get conditions() {
        return this._store?.data?.current.description ?? '';
    }

    get iconName() {
        const current = this._store?.data?.current;
        return current
            ? iconFor(current.kind, current.isDay)
            : 'weather-severe-alert-symbolic';
    }

    /** Coarse sky for the widget's backdrop: 'night', 'clear', 'cloudy' or ''. */
    get sky() {
        const current = this._store?.data?.current;
        if (!current)
            return '';
        if (!current.isDay)
            return 'night';
        return CLEAR_KINDS.has(current.kind) ? 'clear' : 'cloudy';
    }

    /** The next six forecast slots, labelled in the location's time zone. */
    get forecasts() {
        const data = this._store?.data;
        if (!data)
            return [];
        const now = _now();
        const format = this._store.hourFormat;
        return data.hourly
            .filter(entry => entry.unix > now)
            .slice(0, FORECAST_COUNT)
            .map(entry => ({
                time: GLib.DateTime.new_from_unix_utc(entry.unix)
                    ?.to_timezone(data.timezone)?.format(format)?.trim() ?? '',
                temperature: _formatTemperature(entry.temperature),
                iconName: iconFor(entry.kind, entry.isDay),
                sunny: entry.isDay && SUNNY_KINDS.has(entry.kind),
            }));
    }

    refresh() {
        this._store?.update();
    }

    destroy() {
        if (!this._store)
            return;
        this._store.disconnect(this._storeId);
        this._storeId = 0;
        this._store = null;
        _storeUsers--;
        if (_storeUsers <= 0) {
            _storeUsers = 0;
            _store?.destroy();
            _store = null;
        }
    }
});
