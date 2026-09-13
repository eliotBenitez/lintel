// SPDX-License-Identifier: GPL-2.0-or-later
//
// Calendar events, from the Shell's own event source.
//
// Calendar.DBusEventSource is the date menu's client of
// org.gnome.Shell.CalendarServer, which serves Evolution Data Server calendars
// (local, Online Accounts, subscriptions). That server keeps ONE time range for
// all of its clients and broadcasts the events inside it, so a second client
// asking for a different range moves the date menu's range too — and the date
// menu only re-requests when its own range changes, so after disable it would
// keep whatever we asked for last.
//
// requestEventRange() therefore always asks for a superset of the range the
// date menu requests for the current month, extended to the Up Next horizon.
// Verified against GNOME Shell 50.4, js/ui/calendar.js Calendar._rebuildCalendar:
// the grid starts at the week containing the 1st (one week earlier when the
// month starts on the week start day) and runs 42 days.
//
// The source is shared and reference counted: widgets are rebuilt every time the
// layout is edited, and each fresh source makes the server reload every calendar.

import Shell from 'gi://Shell';

import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';
import {formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';

// The date menu's 42-day grid plus the padding week it may put in front.
const GRID_SUPERSET_DAYS = 49;

let _source = null;
let _users = 0;

function _addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** @returns {Calendar.DBusEventSource} the shared event source */
export function acquireEventSource() {
    if (!_source)
        _source = new Calendar.DBusEventSource();
    _users++;
    return _source;
}

export function releaseEventSource(source) {
    if (!source || source !== _source || _users === 0)
        return;
    _users--;
    if (_users === 0) {
        _source.destroy();
        _source = null;
    }
}

/**
 * Ask for the current month's grid and at least `horizonDays` from today.
 * The source ignores a request for the range it already has.
 */
export function requestEventRange(source, now, horizonDays) {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const daysToWeekStart = (7 + first.getDay() - Shell.util_get_week_start()) % 7;
    const begin = _addDays(first, -(daysToWeekStart + 7));
    const gridEnd = _addDays(begin, GRID_SUPERSET_DAYS);
    const horizonEnd = _addDays(now, horizonDays);
    source.requestRange(begin, horizonEnd > gridEnd ? horizonEnd : gridEnd);
}

/** The Shell's event time: "14:30", or "2:30 PM" with a 12-hour clock. */
export function formatEventTime(date) {
    return formatTime(date, {timeOnly: true});
}
