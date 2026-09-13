// SPDX-License-Identifier: GPL-2.0-or-later
//
// UpNextService — the next week of calendar events for the Up Next widget.
//
// Events come from the Shell's calendar server through compat/calendarEvents.js;
// see that module for why the requested range is shaped the way it is.

import GObject from 'gi://GObject';

import {
    acquireEventSource,
    formatEventTime,
    releaseEventSource,
    requestEventRange,
} from '../compat/calendarEvents.js';
import {HORIZON_DAYS, buildAgenda} from './agenda.js';

export {formatEventTime};

export const UpNextService = GObject.registerClass({
    Signals: {'changed': {}},
}, class UpNextService extends GObject.Object {
    _init() {
        super._init();
        this._source = acquireEventSource();
        this._sourceIds = [
            this._source.connect('changed', () => this.emit('changed')),
            this._source.connect('notify::has-calendars', () => this.emit('changed')),
        ];
        this.refresh();
    }

    get hasCalendars() {
        return this._source?.hasCalendars ?? false;
    }

    get agenda() {
        const source = this._source;
        if (!source)
            return [];
        return buildAgenda((begin, end) => source.getEvents(begin, end), new Date());
    }

    /** Re-anchor the range on today; a no-op unless the day has moved on. */
    refresh() {
        if (this._source)
            requestEventRange(this._source, new Date(), HORIZON_DAYS);
    }

    destroy() {
        if (!this._source)
            return;
        for (const id of this._sourceIds)
            this._source.disconnect(id);
        this._sourceIds = [];
        releaseEventSource(this._source);
        this._source = null;
    }
});
