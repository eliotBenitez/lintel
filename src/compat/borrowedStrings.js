// SPDX-License-Identifier: GPL-2.0-or-later
//
// Strings borrowed from GNOME's own translations.
//
// Notification Center widgets show the same words GNOME already shows for the
// same data: "Today", "All Day" and "No Events" in the date menu, "Screen Time"
// and its "5h 12m" durations in Settings → Wellbeing. Looking them up in those
// packages' gettext domains gives every locale GNOME supports for free, and
// keeps the widgets worded exactly like the native surfaces.
//
// The msgids are those packages' internals, verified against gnome-shell 50.4,
// gnome-control-center 50 and gnome-calculator 50 (the one core app that names
// "Temperature"; without it installed the word stays English). A msgid that
// disappears falls back to its English text, never to a blank.

import Gettext from 'gettext';

const SHELL_DOMAIN = 'gnome-shell';
const SETTINGS_DOMAIN = 'gnome-control-center-2.0';
const CALCULATOR_DOMAIN = 'gnome-calculator';

export function shellText(msgid) {
    return Gettext.dgettext(SHELL_DOMAIN, msgid);
}

export function shellContextText(context, msgid) {
    return Gettext.dpgettext(SHELL_DOMAIN, context, msgid);
}

export function settingsText(msgid) {
    return Gettext.dgettext(SETTINGS_DOMAIN, msgid);
}

export function calculatorText(msgid) {
    return Gettext.dgettext(CALCULATOR_DOMAIN, msgid);
}

/**
 * `text` per second: "1,2 МБ/с". GNOME has no bytes-per-second string, but
 * Settings' "%d Mb/s" link speed ends in the locale's per-second suffix.
 *
 * @param {string} text an amount, such as GLib.format_size() returns
 * @returns {string}
 */
export function perSecond(text) {
    const format = settingsText('%d Mb/s');
    const slash = format.lastIndexOf('/');
    return `${text}${slash >= 0 ? format.slice(slash) : '/s'}`;
}

function _fill(format, ...values) {
    return values.reduce((text, value) => text.replace('%u', `${value}`), format);
}

/**
 * Wellbeing's compact duration: "5h 12m", "5h" or "12m" ("5 ч 12 мин" in ru).
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
    const totalMinutes = Math.max(0, Math.floor(seconds / 60));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours && minutes)
        return _fill(settingsText('%uh %um'), hours, minutes);
    if (hours)
        return _fill(settingsText('%uh'), hours);
    return _fill(settingsText('%um'), minutes);
}
