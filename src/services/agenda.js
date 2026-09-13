// SPDX-License-Identifier: GPL-2.0-or-later
//
// buildAgenda — calendar events for the coming days, grouped by day.
//
// Kept free of Shell and GI imports so it can be exercised from plain gjs.

export const HORIZON_DAYS = 7;

function _startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function _addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function _isOver(event, now) {
    // A zero-length event (a reminder) is over once its moment has passed.
    if (event.end.getTime() === event.date.getTime())
        return event.date < now;
    return event.end <= now;
}

/**
 * @param {function(Date, Date): Array<{id, summary, date: Date, end: Date}>} getEvents
 *   events overlapping [begin, end), as Calendar.DBusEventSource.getEvents()
 * @param {Date} now
 * @param {number} days how many days, starting today
 * @returns {Array<{date: Date, offset: number, events: Array}>} only days with
 *   events; each event appears once, on the first day it is still ahead
 */
export function buildAgenda(getEvents, now, days = HORIZON_DAYS) {
    const agenda = [];
    const seen = new Set();
    const today = _startOfDay(now);

    for (let offset = 0; offset < days; offset++) {
        const dayStart = _addDays(today, offset);
        const dayEnd = _addDays(today, offset + 1);
        const events = [];

        for (const event of getEvents(dayStart, dayEnd)) {
            if (seen.has(event.id) || _isOver(event, now))
                continue;
            seen.add(event.id);
            events.push({
                id: event.id,
                summary: event.summary ?? '',
                start: event.date,
                end: event.end,
                allDay: event.date <= dayStart && event.end >= dayEnd,
                startsBefore: event.date < dayStart,
                endsAfter: event.end > dayEnd,
            });
        }

        events.sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start));
        if (events.length)
            agenda.push({date: dayStart, offset, events});
    }
    return agenda;
}
