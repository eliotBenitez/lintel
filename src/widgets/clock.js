// LintelClock — Stage 7.
//
// Re-formats the panel clock to a macOS-style string while leaving the native
// dateMenu (calendar + notifications) completely intact — we only change the
// visible text.
//
// Why we hijack the label instead of reformatting in place (verified against
// gnome-50 dateMenu.js): the panel clock `dateMenu._clockDisplay` is bound to a
// GnomeDesktop.WallClock via `bind_property('clock', ..., SYNC_CREATE)`, and the
// returned binding is never stored, so it can't be cleanly unbound. WallClock
// also has no custom-format API. So we HIDE `_clockDisplay` (the binding keeps
// updating it harmlessly, off-screen) and insert our own St.Label into the same
// `clock-display-box`, driven by our own 1 Hz timer and GLib.DateTime.format.
// On disable we remove our label and un-hide the native one — fully reversible.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PanelAdapter} from '../compat/panelAdapter.js';

const OUR_KEYS = [
    'clock-show-weekday',
    'clock-date-mode',
    'clock-show-ampm',
    'clock-show-seconds',
];

// macOS puts a NARROW no-break space before AM/PM, not a word space. Measured
// off the reference bar: the gap before "PM" is 2.4pt where a word space in the
// same string is 3.6pt.
const NARROW_NBSP = '\u202f';

/**
 * Whether this locale writes the day before the month.
 *
 * macOS renders the menu bar date through the locale's own format; a hard-coded
 * "%b %-d" is US ordering and reads wrong nearly everywhere else (ru_RU showed
 * "Чт сен 10" instead of "Чт 10 сен"). GLib exposes no format skeletons, so ask
 * the locale directly: format a date whose day and month differ and see which
 * number %x puts first.
 */
function localeDayFirst() {
    try {
        const probe = GLib.DateTime.new_local(2000, 1, 2, 12, 0, 0);
        const text = probe.format('%x');
        const day = text.search(/\b0?2\b/);
        const month = text.search(/\b0?1\b/);
        if (day < 0 || month < 0)
            return false;
        return day < month;
    } catch (_e) {
        return false;
    }
}

export class LintelClock {
    constructor(extension) {
        this._extension = extension;
        this._label = null;
        this._nativeLabel = null;
        this._timerId = 0;
        this._settings = null;
        this._settingsIds = [];
        this._desktop = null;
        this._desktopId = 0;
        this._format = '%H:%M';
        // Same string minus the date, used only by the when-space-allows mode.
        this._datelessFormat = '%H:%M';
        this._dateMode = 'when-space-allows';
        this._dayFirst = localeDayFirst();
    }

    get active() {
        return this._label != null;
    }

    enable() {
        if (this._label)
            return;

        const dateMenu = PanelAdapter.dateMenu;
        const native = dateMenu?._clockDisplay;
        const box = native?.get_parent();
        if (!native || !box)
            return; // dateMenu internals changed — degrade gracefully.

        this._nativeLabel = native;
        this._label = new St.Label({
            style_class: 'clock lintel-clock',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const idx = box.get_children().indexOf(native);
        box.insert_child_at_index(this._label, idx);
        native.hide();

        // Our own toggles (weekday/date/seconds), read defensively.
        try {
            this._settings = this._extension?.getSettings?.() ?? null;
        } catch (_e) {
            this._settings = null;
        }
        for (const key of OUR_KEYS) {
            if (!this._settings)
                break;
            this._settingsIds.push(
                this._settings.connect(`changed::${key}`, () => this._rebuild()));
        }

        // System 12h/24h preference.
        this._desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._desktopId = this._desktop.connect(
            'changed::clock-format', () => this._rebuild());

        this._rebuild();
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 1, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _rebuild() {
        this._dateMode = this._dateModeSetting();
        this._format = this._buildFormat(this._dateMode !== 'never');
        this._datelessFormat = this._dateMode === 'when-space-allows'
            ? this._buildFormat(false) : null;
        this._tick();
    }

    _dateModeSetting() {
        try {
            return this._settings
                ? this._settings.get_string('clock-date-mode')
                : 'when-space-allows';
        } catch (_e) {
            return 'when-space-allows';
        }
    }

    _buildFormat(withDate) {
        const bool = (key, fallback) => {
            try {
                return this._settings ? this._settings.get_boolean(key) : fallback;
            } catch (_e) {
                return fallback;
            }
        };
        const weekday = bool('clock-show-weekday', true);
        const date = withDate;
        const seconds = bool('clock-show-seconds', false);
        const ampm = bool('clock-show-ampm', true);

        let is24 = true;
        try {
            is24 = this._desktop.get_string('clock-format') !== '12h';
        } catch (_e) {
            is24 = true;
        }

        const left = [];
        if (weekday)
            left.push('%a');
        if (date)
            left.push(this._dayFirst ? '%-d %b' : '%b %-d');

        let time = is24 ? '%H:%M' : '%-I:%M';
        if (seconds)
            time = is24 ? '%H:%M:%S' : '%-I:%M:%S';
        if (!is24 && ampm)
            time += `${NARROW_NBSP}%p`;

        // Date and time are separated by a double space in the reference bar
        // (7.2pt against a 3.6pt word space), not by a comma or a single space.
        const prefix = left.join(' ');
        return prefix ? `${prefix}  ${time}` : time;
    }

    _tick() {
        if (!this._label)
            return;
        const now = GLib.DateTime.new_now_local();
        this._label.text = now.format(this._format) ??
            now.format('%H:%M') ?? '';

        // "When space allows": macOS drops the date once the menu bar gets
        // crowded, keeping the weekday and the time. Re-checked on every tick
        // rather than on an allocation signal, so it also follows items that
        // other extensions add or remove while we run.
        if (!this._datelessFormat || !this._panelOverflows())
            return;
        this._label.text = now.format(this._datelessFormat) ??
            now.format('%H:%M') ?? '';
    }

    /**
     * Whether the panel's three boxes, as currently laid out, want more width
     * than the monitor has. Measured AFTER the full string is already in the
     * label, so the comparison includes the date we are deciding about — the
     * dateless string is strictly narrower, so dropping it cannot re-overflow
     * and the choice cannot oscillate.
     */
    _panelOverflows() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;
        let natural = 0;
        for (const box of PanelAdapter.boxes) {
            try {
                natural += box.get_preferred_width(-1)[1];
            } catch (_e) {
                return false;   // mid-teardown: keep what we have
            }
        }
        return natural > monitor.width;
    }

    destroy() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        for (const id of this._settingsIds)
            this._settings?.disconnect(id);
        this._settingsIds = [];
        if (this._desktopId && this._desktop) {
            this._desktop.disconnect(this._desktopId);
            this._desktopId = 0;
        }
        this._desktop = null;
        this._settings = null;

        if (this._label) {
            this._label.destroy();
            this._label = null;
        }
        if (this._nativeLabel) {
            try {
                this._nativeLabel.show();
            } catch (_e) {
                // Actor may be gone; harmless.
            }
            this._nativeLabel = null;
        }
        this._extension = null;
    }
}
