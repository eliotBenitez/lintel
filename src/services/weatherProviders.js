// SPDX-License-Identifier: GPL-2.0-or-later
//
// Keyless weather back ends for the Notification Center widget, and city search.
//
// Why these two: Yandex, Google and Gismeteo all require an API key tied to an
// account (Google and Yandex also billing), which an extension cannot ship.
// Open-Meteo (hourly, WMO codes, its own geocoder) and wttr.in (three-hourly,
// localised descriptions) both answer anonymous requests.
//
// Shell-free on purpose: prefs.js imports this module for city search.
//
// A forecast is normalised to
//   {
//     timezone,       GLib.TimeZone of the location, for hour labels
//     locationName,   the service's own name for the place, may be ''
//     current: {temperature, kind, isDay, description},
//     hourly:  [{unix, temperature, kind, isDay}], ascending
//   }
// with temperatures as numbers in the requested unit and `kind` one of the keys
// of DESCRIPTIONS.en.

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {_} from '../i18n.js';

const USER_AGENT = 'Lintel GNOME Shell extension (lintel@topbar)';
const TIMEOUT_SECONDS = 20;
const FORECAST_HOURS = 12;

// WMO 4677 codes, as Open-Meteo reports them.
const WMO_KINDS = [
    ['clear', [0]],
    ['mostly-clear', [1]],
    ['partly-cloudy', [2]],
    ['overcast', [3]],
    ['fog', [45, 48]],
    ['drizzle', [51, 53, 55]],
    ['freezing-rain', [56, 57, 66, 67]],
    ['rain', [61, 63]],
    ['heavy-rain', [65, 82]],
    ['showers', [80, 81]],
    ['snow', [71, 73, 77, 85]],
    ['heavy-snow', [75, 86]],
    ['thunderstorm', [95, 96, 99]],
];

// World Weather Online codes, as wttr.in reports them.
const WWO_KINDS = [
    ['clear', [113]],
    ['partly-cloudy', [116]],
    ['overcast', [119, 122]],
    ['fog', [143, 248, 260]],
    ['drizzle', [263, 266]],
    ['showers', [176, 353]],
    ['rain', [293, 296, 299, 302]],
    ['heavy-rain', [305, 308, 356, 359]],
    ['freezing-rain', [185, 281, 284, 311, 314]],
    ['sleet', [182, 317, 320, 350, 362, 365, 374, 377]],
    ['snow', [179, 227, 323, 326, 329, 332, 368]],
    ['heavy-snow', [230, 335, 338, 371]],
    ['thunderstorm', [200, 386, 389, 392, 395]],
];

const _codeMap = table => new Map(
    table.flatMap(([kind, codes]) => codes.map(code => [code, kind])));
const WMO = _codeMap(WMO_KINDS);
const WWO = _codeMap(WWO_KINDS);

const DESCRIPTIONS = {
    'clear': _('Clear'),
    'mostly-clear': _('Mostly Clear'),
    'partly-cloudy': _('Partly Cloudy'),
    'overcast': _('Cloudy'),
    'fog': _('Fog'),
    'drizzle': _('Drizzle'),
    'showers': _('Showers'),
    'rain': _('Rain'),
    'heavy-rain': _('Heavy Rain'),
    'freezing-rain': _('Freezing Rain'),
    'sleet': _('Sleet'),
    'snow': _('Snow'),
    'heavy-snow': _('Heavy Snow'),
    'thunderstorm': _('Thunderstorm'),
};

const ICONS = {
    'clear': ['weather-clear-symbolic', 'weather-clear-night-symbolic'],
    'mostly-clear': ['weather-few-clouds-symbolic', 'weather-few-clouds-night-symbolic'],
    'partly-cloudy': ['weather-few-clouds-symbolic', 'weather-few-clouds-night-symbolic'],
    'overcast': ['weather-overcast-symbolic'],
    'fog': ['weather-fog-symbolic'],
    'drizzle': ['weather-showers-scattered-symbolic'],
    'showers': ['weather-showers-scattered-symbolic'],
    'rain': ['weather-showers-symbolic'],
    'heavy-rain': ['weather-showers-symbolic'],
    'freezing-rain': ['weather-showers-symbolic'],
    'sleet': ['weather-snow-symbolic'],
    'snow': ['weather-snow-symbolic'],
    'heavy-snow': ['weather-snow-symbolic'],
    'thunderstorm': ['weather-storm-symbolic'],
};

export function iconFor(kind, isDay) {
    const [day, night] = ICONS[kind] ?? ICONS.overcast;
    return !isDay && night ? night : day;
}

function _describe(kind, _language) {
    return DESCRIPTIONS[kind] ?? '';
}

/** Two-letter language of the session locale, e.g. 'ru'; 'en' for C/POSIX. */
export function preferredLanguage() {
    for (const name of GLib.get_language_names()) {
        const code = name.split(/[_.@]/)[0];
        if (/^[a-z]{2,3}$/.test(code))
            return code;
    }
    return 'en';
}

export function newSession() {
    return new Soup.Session({
        user_agent: USER_AGENT,
        timeout: TIMEOUT_SECONDS,
    });
}

function _fetchJson(session, url, cancellable) {
    const message = Soup.Message.new('GET', url);
    if (!message)
        return Promise.reject(new Error(`Invalid URL ${url}`));

    return new Promise((resolve, reject) => {
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable,
            (source, result) => {
                try {
                    const bytes = source.send_and_read_finish(result);
                    const status = message.get_status();
                    if (status !== Soup.Status.OK) {
                        throw new Error(
                            `HTTP ${status} from ${message.get_uri().get_host()}`);
                    }
                    resolve(JSON.parse(new TextDecoder().decode(bytes.toArray())));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function _escape(text) {
    return GLib.Uri.escape_string(text, null, false);
}

function _coordinates(location) {
    return [location.latitude.toFixed(4), location.longitude.toFixed(4)];
}

function _requireNumber(value, what) {
    if (!Number.isFinite(value))
        throw new Error(`The weather service returned no ${what}`);
    return value;
}

async function _fetchOpenMeteo(session, location, unit, language, cancellable) {
    const [latitude, longitude] = _coordinates(location);
    const params = [
        `latitude=${latitude}`,
        `longitude=${longitude}`,
        'current=temperature_2m,weather_code,is_day',
        'hourly=temperature_2m,weather_code,is_day',
        `forecast_hours=${FORECAST_HOURS}`,
        'timezone=auto',
        'timeformat=unixtime',
    ];
    if (unit === 'fahrenheit')
        params.push('temperature_unit=fahrenheit');

    const data = await _fetchJson(session,
        `https://api.open-meteo.com/v1/forecast?${params.join('&')}`, cancellable);
    const current = data.current ?? {};
    const hourly = data.hourly ?? {};
    const kind = WMO.get(current.weather_code) ?? 'overcast';

    return {
        timezone: GLib.TimeZone.new_offset(data.utc_offset_seconds ?? 0),
        locationName: '',
        current: {
            temperature: _requireNumber(current.temperature_2m, 'temperature'),
            kind,
            isDay: current.is_day !== 0,
            description: _describe(kind, language),
        },
        hourly: (hourly.time ?? []).map((unix, i) => ({
            unix,
            temperature: hourly.temperature_2m?.[i],
            kind: WMO.get(hourly.weather_code?.[i]) ?? 'overcast',
            isDay: hourly.is_day?.[i] !== 0,
        })).filter(entry => Number.isFinite(entry.temperature)),
    };
}

// wttr.in prints sunrise and sunset as "05:55 AM"; minutes past midnight.
function _clockMinutes(text) {
    const match = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(text ?? '');
    if (!match)
        return null;
    const hour = Number(match[1]) % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0);
    return hour * 60 + Number(match[2]);
}

function _isDay(minutes, astronomy) {
    const sunrise = _clockMinutes(astronomy?.sunrise);
    const sunset = _clockMinutes(astronomy?.sunset);
    // Polar day and night report no times; call it day rather than guess.
    if (sunrise === null || sunset === null)
        return true;
    return minutes >= sunrise && minutes < sunset;
}

function _timezone(identifier) {
    return (identifier && GLib.TimeZone.new_identifier(identifier)) ||
        GLib.TimeZone.new_local();
}

async function _fetchWttr(session, location, unit, language, cancellable) {
    const place = _coordinates(location).join(',');
    const data = await _fetchJson(session,
        `https://wttr.in/${place}?format=j1&lang=${_escape(language)}`, cancellable);

    // wttr.in reports hours in the location's local time without saying which
    // zone that is, so the zone comes from the stored city (local for GeoClue).
    const timezone = _timezone(location.timezone);
    const fahrenheit = unit === 'fahrenheit';
    const hourly = [];
    for (const day of data.weather ?? []) {
        const [year, month, date] = (day.date ?? '').split('-').map(Number);
        for (const entry of day.hourly ?? []) {
            const hhmm = Number(entry.time);
            const datetime = GLib.DateTime.new(timezone, year, month, date,
                Math.floor(hhmm / 100), hhmm % 100, 0);
            const temperature = Number(fahrenheit ? entry.tempF : entry.tempC);
            if (!datetime || !Number.isFinite(temperature))
                continue;
            hourly.push({
                unix: datetime.to_unix(),
                temperature,
                kind: WWO.get(Number(entry.weatherCode)) ?? 'overcast',
                isDay: _isDay(Math.floor(hhmm / 100) * 60 + hhmm % 100,
                    day.astronomy?.[0]),
            });
        }
    }

    const current = data.current_condition?.[0];
    if (!current)
        throw new Error('The weather service returned no current conditions');
    const kind = WWO.get(Number(current.weatherCode)) ?? 'overcast';
    const now = GLib.DateTime.new_now(timezone);
    const description = current[`lang_${language}`]?.[0]?.value?.trim() ||
        _describe(kind, language) ||
        current.weatherDesc?.[0]?.value?.trim() || '';

    return {
        timezone,
        locationName: data.nearest_area?.[0]?.areaName?.[0]?.value ?? '',
        current: {
            temperature: _requireNumber(
                Number(fahrenheit ? current.temp_F : current.temp_C), 'temperature'),
            kind,
            isDay: _isDay(now.get_hour() * 60 + now.get_minute(),
                data.weather?.[0]?.astronomy?.[0]),
            description,
        },
        hourly: hourly.sort((a, b) => a.unix - b.unix),
    };
}

const PROVIDERS = {
    'open-meteo': _fetchOpenMeteo,
    'wttr': _fetchWttr,
};

/**
 * @param {Soup.Session} session
 * @param {string} provider 'open-meteo' or 'wttr'
 * @param {{latitude: number, longitude: number, timezone: string}} location
 * @param {string} unit 'celsius' or 'fahrenheit'
 * @param {string} language two-letter code for descriptions
 * @param {Gio.Cancellable|null} cancellable
 */
export function fetchForecast(session, provider, location, unit, language,
    cancellable = null) {
    const fetch = PROVIDERS[provider] ?? PROVIDERS['open-meteo'];
    return fetch(session, location, unit, language, cancellable);
}

/**
 * Cities matching `query`, named in `language`, from Open-Meteo's geocoder.
 *
 * @returns {Promise<Array<{name, detail, latitude, longitude, timezone}>>}
 */
export async function searchCities(session, query, language, cancellable = null) {
    const name = query.trim();
    if (name.length < 2)
        return [];
    const data = await _fetchJson(session,
        'https://geocoding-api.open-meteo.com/v1/search' +
        `?name=${_escape(name)}&count=8&language=${_escape(language)}&format=json`,
        cancellable);

    return (data.results ?? []).map(result => ({
        name: result.name ?? '',
        detail: [result.admin1, result.country]
            .filter((part, i, parts) =>
                part && part !== result.name && parts.indexOf(part) === i)
            .join(', '),
        latitude: result.latitude,
        longitude: result.longitude,
        timezone: result.timezone ?? '',
    })).filter(city => city.name &&
        Number.isFinite(city.latitude) && Number.isFinite(city.longitude));
}
