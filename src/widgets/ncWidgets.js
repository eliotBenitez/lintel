// SPDX-License-Identifier: GPL-2.0-or-later
//
// Notification Center widgets, composed per Tahoe widget size.
//
// Geometry is measured off docs/audits/tahoe-reference/26-Tahoe-Notification-
// Center.png (see docs/MACOS_REFERENCE.md): a 345px column; small widgets are
// 165px squares that pair two to a row across a 15px gutter; medium widgets are
// 345 x 165 and large ones 345 x 345. The sizes themselves live in
// stylesheet.css — this module only decides what each size shows.
//
// Every widget cleans up from its actor's `destroy` signal, because Clutter can
// destroy descendants from C without invoking a JavaScript destroy() override.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {_} from '../i18n.js';
import {
    calculatorText,
    formatDuration,
    perSecond,
    settingsText,
    shellContextText,
    shellText,
} from '../compat/borrowedStrings.js';
import {BatteryService} from '../services/battery.js';
import {MediaService} from '../services/media.js';
import {ScreenTimeService} from '../services/screenTime.js';
import {HISTORY_LENGTH, SystemStatsService} from '../services/systemStats.js';
import {UpNextService, formatEventTime} from '../services/upNext.js';
import {WeatherService, localeTemperatureUnit} from '../services/weather.js';
import {CCMediaCard} from './ccTile.js';

const LOW_BATTERY_PERCENT = 20;
const MINUTE_MS = 60 * 1000;

// How many event rows each Up Next size can hold. On large a day heading costs
// half a row, so the budget is counted in half rows.
const UP_NEXT_ROWS = Object.freeze({small: 2, medium: 3, large: 12});

// What the weather widget says while it has no forecast, by service status.
const WEATHER_PLACEHOLDERS = Object.freeze({
    'loading': ['content-loading-symbolic', _('Updating…')],
    'locating': ['find-location-symbolic', _('Finding your location…')],
    'no-location': ['find-location-symbolic', _('Choose a city in Lintel settings')],
    'location-disabled': ['location-services-disabled-symbolic',
        _('Location Services are off. Choose a city in settings')],
    'location-error': ['location-services-disabled-symbolic',
        _('Location unavailable. Choose a city in settings')],
    'error': ['weather-severe-alert-symbolic', _('Weather is unavailable right now')],
});

function _activateApp(id) {
    const app = Shell.AppSystem.get_default().lookup_app(id);
    if (!app)
        return false;
    app.activate();
    return true;
}

function _activateCalendar() {
    if (_activateApp('org.gnome.Calendar.desktop'))
        return;
    const app = Gio.AppInfo.get_default_for_type('text/calendar', false);
    app?.launch([], global.create_app_launch_context(0, -1));
}

function _firstCharacter(text) {
    return Array.from(text || '')[0] ?? '';
}

function _capitalize(text) {
    const characters = Array.from(text || '');
    if (!characters.length)
        return '';
    return `${characters[0].toLocaleUpperCase()}${characters.slice(1).join('')}`;
}

function _label(text, styleClass, params = {}) {
    return new St.Label({
        text: text ?? '',
        style_class: styleClass,
        x_align: Clutter.ActorAlign.START,
        ...params,
    });
}

function _vbox(styleClass, params = {}) {
    return new St.BoxLayout({
        style_class: styleClass,
        orientation: Clutter.Orientation.VERTICAL,
        ...params,
    });
}

function _spacer() {
    return new St.Widget({x_expand: true, y_expand: true});
}

// Cairo paints in colours the stylesheet owns, so light/dark stay in CSS.
function _themeColor(node, name) {
    const [found, color] = node.lookup_color(name, true);
    return found ? color : node.get_foreground_color();
}

function _setSource(cr, color, alpha = 1) {
    cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255,
        (color.alpha / 255) * alpha);
}

function _roundedRect(cr, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    cr.newSubPath();
    cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

function _wrap(label) {
    label.clutter_text.line_wrap = true;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

// Re-run `callback` every minute, but only while `actor` is on screen.
function _tickWhileMapped(actor, callback) {
    let timerId = 0;
    const sync = () => {
        if (actor.mapped && !timerId) {
            timerId = GLib.timeout_add(GLib.PRIORITY_LOW, MINUTE_MS, () => {
                callback();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!actor.mapped && timerId) {
            GLib.Source.remove(timerId);
            timerId = 0;
        }
    };
    actor.connect('notify::mapped', sync);
    actor.connect('destroy', () => {
        if (timerId)
            GLib.Source.remove(timerId);
        timerId = 0;
    });
    sync();
}

const WidgetCard = GObject.registerClass(
class WidgetCard extends St.Button {
    _init(kind, size, onActivated) {
        super._init({
            style_class: `lintel-nc-widget-card lintel-nc-widget-${size} ` +
                `lintel-nc-${kind}-widget`,
            can_focus: true,
            x_expand: true,
            clip_to_allocation: true,
        });
        this._size = size;
        this._onActivated = onActivated;
        this._disposed = false;
        this.connect('destroy', () => this._dispose());
    }

    setContent(child) {
        this.child?.destroy();
        this.child = child;
    }

    refresh() {
    }

    vfunc_clicked() {
        this._onActivated?.();
        this._launch();
    }

    _launch() {
    }

    _dispose() {
        if (this._disposed)
            return;
        this._disposed = true;
        this._onDispose();
        this._onActivated = null;
    }

    _onDispose() {
    }
});

export const CalendarWidget = GObject.registerClass(
class CalendarWidget extends WidgetCard {
    _init(size, onActivated) {
        super._init('calendar', size, onActivated);
        this.refresh();
    }

    refresh() {
        const now = GLib.DateTime.new_now_local();
        const month = now.format('%OB') || now.format('%B') || '';

        if (this._size === 'medium') {
            // Tahoe's medium calendar: the day on the left, the month beside it.
            const box = new St.BoxLayout({
                style_class: 'lintel-nc-calendar-split',
                x_expand: true,
                y_expand: true,
            });
            const summary = _vbox('lintel-nc-calendar-summary', {
                x_expand: true,
            });
            summary.add_child(_label((now.format('%A') ?? '').toLocaleUpperCase(),
                'lintel-nc-calendar-month'));
            summary.add_child(_label(`${now.get_day_of_month()}`,
                'lintel-nc-calendar-big-day'));
            summary.add_child(_spacer());
            summary.add_child(_label(`${_capitalize(month)} ${now.get_year()}`,
                'lintel-nc-widget-subtitle'));
            box.add_child(summary);
            box.add_child(this._monthGrid(now));
            this.setContent(box);
            return;
        }

        const box = _vbox(null, {x_expand: true, y_expand: true});
        const header = new St.BoxLayout({x_expand: true});
        header.add_child(_label(month.toLocaleUpperCase(),
            'lintel-nc-calendar-month', {x_expand: true}));
        if (this._size === 'large') {
            header.add_child(_label(`${now.get_year()}`,
                'lintel-nc-calendar-year'));
        }
        box.add_child(header);
        box.add_child(this._monthGrid(now));
        this.setContent(box);
    }

    _monthGrid(now) {
        const layout = new Clutter.GridLayout({
            orientation: Clutter.Orientation.VERTICAL,
            column_homogeneous: true,
            row_homogeneous: true,
        });
        const grid = new St.Widget({
            style_class: 'lintel-nc-calendar-grid',
            layout_manager: layout,
            x_expand: this._size !== 'medium',
            y_align: Clutter.ActorAlign.START,
        });

        const weekStart = Shell.util_get_week_start();
        const baseSunday = GLib.DateTime.new_local(2023, 1, 1, 12, 0, 0);
        const isWeekend = dayIndex => dayIndex === 0 || dayIndex === 6;

        for (let col = 0; col < 7; col++) {
            const dayIndex = (weekStart + col) % 7;
            const weekday = baseSunday.add_days(dayIndex).format('%a') ?? '';
            const label = _label(_firstCharacter(weekday).toLocaleUpperCase(),
                'lintel-nc-calendar-weekday', {
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
            if (isWeekend(dayIndex))
                label.add_style_class_name('lintel-nc-calendar-weekend');
            layout.attach(this._cell(label), col, 0, 1, 1);
        }

        const today = now.get_day_of_month();
        const first = GLib.DateTime.new_local(
            now.get_year(), now.get_month(), 1, 12, 0, 0);
        // get_day_of_week(): 1 = Monday ... 7 = Sunday; week start: 0 = Sunday.
        const offset = (7 + first.get_day_of_week() % 7 - weekStart) % 7;
        const days = first.add_months(1).add_days(-1).get_day_of_month();

        for (let cell = offset; cell < offset + days; cell++) {
            const day = cell - offset + 1;
            const label = _label(`${day}`, 'lintel-nc-calendar-day-number', {
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            // The label is centred inside a square disc, so today's red circle
            // is round and its number optically centred at every size.
            const disc = new St.Bin({
                style_class: 'lintel-nc-calendar-day',
                child: label,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            if (day === today)
                disc.add_style_class_name('lintel-nc-calendar-today');
            else if (isWeekend((weekStart + cell) % 7))
                label.add_style_class_name('lintel-nc-calendar-weekend');
            layout.attach(this._cell(disc), cell % 7, Math.floor(cell / 7) + 1, 1, 1);
        }
        return grid;
    }

    _cell(child) {
        return new St.Bin({
            style_class: 'lintel-nc-calendar-cell',
            child,
            x_expand: true,
        });
    }

    _launch() {
        _activateCalendar();
    }
});

export const WeatherWidget = GObject.registerClass(
class WeatherWidget extends WidgetCard {
    _init(size, onActivated, {settings = null, openPreferences = null} = {}) {
        super._init('weather', size, onActivated);
        this._sky = '';
        this._openPreferences = openPreferences;
        this._service = new WeatherService(settings);
        this._serviceId = this._service.connect('changed', () => this._sync());
        this._sync();
    }

    refresh() {
        this._service?.refresh();
    }

    // With a forecast, open a weather app as Tahoe does; without one, the fix
    // is a city or a service choice, which lives in preferences.
    _launch() {
        if (this._service?.valid && _activateApp('org.gnome.Weather.desktop'))
            return;
        this._openPreferences?.();
    }

    _setSky(sky) {
        if (this._sky === sky)
            return;
        if (this._sky)
            this.remove_style_class_name(`lintel-nc-weather-${this._sky}`);
        this._sky = sky;
        if (sky)
            this.add_style_class_name(`lintel-nc-weather-${sky}`);
    }

    _icon(name, sunny, styleClass, xAlign = Clutter.ActorAlign.START) {
        const icon = new St.Icon({
            icon_name: name,
            style_class: styleClass,
            x_align: xAlign,
        });
        if (sunny)
            icon.add_style_class_name('lintel-nc-weather-sunny');
        return icon;
    }

    _sync() {
        const service = this._service;
        if (!service)
            return;

        if (!service.valid) {
            this._setSky('');
            this.setContent(this._placeholder(service));
            return;
        }

        this._setSky(service.sky);
        const sunny = service.sky === 'clear';
        const box = _vbox(null, {x_expand: true, y_expand: true});
        const top = new St.BoxLayout({x_expand: true});
        const left = _vbox(null, {x_expand: true});
        left.add_child(_label(service.locationName || _('Weather'),
            'lintel-nc-weather-location'));
        left.add_child(_label(service.temperature,
            'lintel-nc-weather-temperature'));
        top.add_child(left);
        box.add_child(top);

        if (this._size === 'small') {
            box.add_child(_spacer());
            box.add_child(this._icon(service.iconName, sunny,
                'lintel-nc-weather-icon'));
            box.add_child(_label(service.conditions,
                'lintel-nc-weather-conditions'));
        } else {
            const right = _vbox(null, {y_expand: true});
            right.add_child(this._icon(service.iconName, sunny,
                'lintel-nc-weather-icon', Clutter.ActorAlign.END));
            right.add_child(_spacer());
            right.add_child(_label(service.conditions,
                'lintel-nc-weather-conditions', {
                    x_align: Clutter.ActorAlign.END,
                }));
            top.add_child(right);
            box.add_child(_spacer());
            box.add_child(this._forecastRow(service.forecasts));
        }
        this.setContent(box);
    }

    _placeholder(service) {
        const box = _vbox('lintel-nc-weather-placeholder', {
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const [iconName, text] = WEATHER_PLACEHOLDERS[service.status] ??
            WEATHER_PLACEHOLDERS.error;
        box.add_child(new St.Icon({
            icon_name: iconName,
            fallback_icon_name: 'weather-few-clouds-symbolic',
            style_class: 'lintel-nc-weather-placeholder-icon',
            x_align: Clutter.ActorAlign.START,
        }));
        box.add_child(_label(service.locationName || _('Weather'),
            'lintel-nc-widget-title'));
        const subtitle = _label(text, 'lintel-nc-widget-subtitle');
        // A small widget is 165px wide; the hint must wrap, not ellipsize.
        subtitle.clutter_text.line_wrap = true;
        subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(subtitle);
        return box;
    }

    _forecastRow(forecasts) {
        const row = new St.BoxLayout({
            style_class: 'lintel-nc-weather-forecasts',
            x_expand: true,
        });
        for (const forecast of forecasts) {
            const item = _vbox('lintel-nc-forecast', {x_expand: true});
            item.add_child(_label(forecast.time, 'lintel-nc-forecast-time', {
                x_align: Clutter.ActorAlign.CENTER,
            }));
            item.add_child(this._icon(forecast.iconName, forecast.sunny,
                'lintel-nc-forecast-icon', Clutter.ActorAlign.CENTER));
            item.add_child(_label(forecast.temperature,
                'lintel-nc-forecast-temperature', {
                    x_align: Clutter.ActorAlign.CENTER,
                }));
            row.add_child(item);
        }
        return row;
    }

    _onDispose() {
        if (this._serviceId && this._service)
            this._service.disconnect(this._serviceId);
        this._serviceId = 0;
        this._service?.destroy();
        this._service = null;
    }
});

// Tahoe's ring gauge, shared by Batteries and System. Its size and colours
// (-lintel-ring-fill, -low, -track) come from the stylesheet.
const RingGauge = GObject.registerClass(
class RingGauge extends St.Widget {
    _init(styleClass, center = null) {
        super._init({
            style_class: `lintel-nc-ring ${styleClass}`,
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._level = 0;
        this._alert = false;

        this._area = new St.DrawingArea({x_expand: true, y_expand: true});
        this._area.connect('repaint', area => this._repaint(area));
        this.add_child(this._area);
        if (center) {
            center.x_align = Clutter.ActorAlign.CENTER;
            center.y_align = Clutter.ActorAlign.CENTER;
            this.add_child(center);
        }
    }

    /**
     * @param {number} fraction filled part, 0..1
     * @param {boolean} alert draw the fill in the -lintel-ring-low colour
     */
    setLevel(fraction, alert = false) {
        const level = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
        if (level === this._level && alert === this._alert)
            return;
        this._level = level;
        this._alert = alert;
        this._area.queue_repaint();
    }

    _repaint(area) {
        const cr = area.get_context();
        try {
            const [width, height] = area.get_surface_size();
            const size = Math.min(width, height);
            if (!size)
                return;
            const node = this.get_theme_node();
            const lineWidth = Math.max(2, size * 0.085);
            const radius = (size - lineWidth) / 2;
            const start = -Math.PI / 2;

            cr.setLineWidth(lineWidth);
            cr.setLineCap(Cairo.LineCap.ROUND);
            _setSource(cr, _themeColor(node, '-lintel-ring-track'));
            cr.arc(width / 2, height / 2, radius, 0, 2 * Math.PI);
            cr.stroke();

            if (this._level > 0) {
                _setSource(cr, _themeColor(node, this._alert
                    ? '-lintel-ring-low'
                    : '-lintel-ring-fill'));
                cr.arc(width / 2, height / 2, radius,
                    start, start + 2 * Math.PI * this._level);
                cr.stroke();
            }
        } catch (e) {
            logError(e, 'lintel: painting ring gauge');
        } finally {
            cr.$dispose();
        }
    }
});

export const BatteryWidget = GObject.registerClass(
class BatteryWidget extends WidgetCard {
    _init(size, onActivated) {
        super._init('battery', size, onActivated);
        this._ring = new RingGauge('lintel-nc-battery-ring', new St.Icon({
            icon_name: 'computer-laptop-symbolic',
            fallback_icon_name: 'computer-symbolic',
            style_class: 'lintel-nc-battery-device',
        }));
        this._percentage = _label('', 'lintel-nc-battery-percentage');
        this._status = _label('', 'lintel-nc-widget-subtitle');

        if (size === 'small') {
            const box = _vbox(null, {x_expand: true, y_expand: true});
            this._ring.x_align = Clutter.ActorAlign.START;
            box.add_child(this._ring);
            box.add_child(_spacer());
            box.add_child(this._percentage);
            box.add_child(this._status);
            this.setContent(box);
        } else {
            const box = new St.BoxLayout({
                style_class: 'lintel-nc-battery-row',
                x_expand: true,
                y_expand: true,
            });
            box.add_child(this._ring);
            const labels = _vbox(null, {
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            labels.add_child(_label(_('Battery'), 'lintel-nc-widget-title'));
            labels.add_child(this._percentage);
            labels.add_child(this._status);
            box.add_child(labels);
            this.setContent(box);
        }

        this._service = new BatteryService();
        this._serviceId = this._service.connect('changed', () => this._sync());
        this._sync();
    }

    refresh() {
        this._sync();
    }

    _launch() {
        Gio.AppInfo.launch_default_for_uri(
            'gnome-control-center://power',
            global.create_app_launch_context(0, -1));
    }

    _sync() {
        const service = this._service;
        if (!service)
            return;
        this.visible = service.available;
        if (!this.visible)
            return;
        this._ring.setLevel(service.percentage / 100,
            !service.charging && service.percentage <= LOW_BATTERY_PERCENT);
        this._percentage.text = `${service.percentage}%`;
        this._status.text = this._size === 'small'
            ? service.statusText
            : service.timeText || service.statusText;
    }

    _onDispose() {
        if (this._serviceId && this._service)
            this._service.disconnect(this._serviceId);
        this._serviceId = 0;
        this._service?.destroy();
        this._service = null;
    }
});

export const MediaWidget = GObject.registerClass(
class MediaWidget extends St.BoxLayout {
    _init(size) {
        super._init({
            style_class: `lintel-nc-widget-card lintel-nc-widget-${size} ` +
                'lintel-nc-media-widget',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._destroyed = false;
        this._service = new MediaService();
        this._card = new CCMediaCard('lintel-nc-media-content');
        this._card.y_expand = true;
        this._card.connect('previous', () => this._service?.previous());
        this._card.connect('play-pause', () => this._service?.playPause());
        this._card.connect('next', () => this._service?.next());
        this.add_child(this._card);
        this._serviceId = this._service.connect('changed', () => this._sync());
        this.connect('destroy', () => this._dispose());
        this._sync();
    }

    refresh() {
        this._sync();
    }

    _sync() {
        if (!this._service)
            return;
        this.visible = this._service.available;
        if (this.visible) {
            this._card.setTrack(
                this._service.title,
                this._service.artist,
                this._service.artUrl,
                this._service.playing);
        }
    }

    _dispose() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (this._serviceId && this._service)
            this._service.disconnect(this._serviceId);
        this._serviceId = 0;
        this._service?.destroy();
        this._service = null;
        this._card = null;
    }
});

export const ClockWidget = GObject.registerClass(
class ClockWidget extends WidgetCard {
    _init(size, onActivated) {
        super._init('clock', size, onActivated);
        this._timerId = 0;
        this._face = new St.DrawingArea({
            style_class: 'lintel-nc-clock-face',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._face.connect('repaint', area => this._repaintFace(area));
        this._time = _label('', 'lintel-nc-clock-time');
        this._date = _label('', 'lintel-nc-widget-subtitle');

        if (size === 'small') {
            const box = _vbox(null, {x_expand: true, y_expand: true});
            this._face.y_expand = true;
            box.add_child(this._face);
            this.setContent(box);
        } else if (size === 'medium') {
            const box = new St.BoxLayout({
                style_class: 'lintel-nc-clock-row',
                x_expand: true,
                y_expand: true,
            });
            box.add_child(this._face);
            const labels = _vbox(null, {
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            labels.add_child(this._time);
            labels.add_child(this._date);
            box.add_child(labels);
            this.setContent(box);
        } else {
            const box = _vbox(null, {x_expand: true, y_expand: true});
            this._face.y_expand = true;
            this._time.x_align = Clutter.ActorAlign.CENTER;
            this._date.x_align = Clutter.ActorAlign.CENTER;
            box.add_child(this._face);
            box.add_child(this._time);
            box.add_child(this._date);
            this.setContent(box);
        }

        // Tick every second, but only while the column is on screen.
        this.connect('notify::mapped', () => this._syncTimer());
        this.refresh();
    }

    refresh() {
        const now = GLib.DateTime.new_now_local();
        this._time.text = now.format('%H:%M') ?? '';
        this._date.text = _capitalize(now.format('%A, %-d %B') ?? '');
        this._face.queue_repaint();
    }

    _launch() {
        _activateApp('org.gnome.clocks.desktop');
    }

    _syncTimer() {
        if (this.mapped && !this._timerId) {
            this.refresh();
            this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this.refresh();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!this.mapped && this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
    }

    _repaintFace(area) {
        const cr = area.get_context();
        try {
            const [width, height] = area.get_surface_size();
            const size = Math.min(width, height);
            if (!size)
                return;
            const node = area.get_theme_node();
            const radius = size / 2;
            cr.translate(width / 2, height / 2);

            _setSource(cr, _themeColor(node, '-lintel-clock-face'));
            cr.arc(0, 0, radius, 0, 2 * Math.PI);
            cr.fill();

            cr.setLineCap(Cairo.LineCap.ROUND);
            const tick = _themeColor(node, '-lintel-clock-tick');
            for (let i = 0; i < 60; i++) {
                const hour = i % 5 === 0;
                const angle = i * Math.PI / 30;
                const outer = radius * 0.88;
                const inner = radius * (hour ? 0.74 : 0.82);
                cr.setLineWidth(size * (hour ? 0.022 : 0.008));
                _setSource(cr, tick, hour ? 1 : 0.5);
                cr.moveTo(Math.sin(angle) * inner, -Math.cos(angle) * inner);
                cr.lineTo(Math.sin(angle) * outer, -Math.cos(angle) * outer);
                cr.stroke();
            }

            const now = GLib.DateTime.new_now_local();
            const seconds = Math.floor(now.get_seconds());
            const minutes = now.get_minute() + seconds / 60;
            const hours = now.get_hour() % 12 + minutes / 60;
            const hand = _themeColor(node, '-lintel-clock-hand');
            const second = _themeColor(node, '-lintel-clock-second');

            this._hand(cr, hand, hours * Math.PI / 6, radius * 0.48, size * 0.045);
            this._hand(cr, hand, minutes * Math.PI / 30, radius * 0.72, size * 0.03);
            this._hand(cr, second, seconds * Math.PI / 30, radius * 0.80,
                size * 0.012, radius * 0.16);

            _setSource(cr, hand);
            cr.arc(0, 0, size * 0.035, 0, 2 * Math.PI);
            cr.fill();
            _setSource(cr, second);
            cr.arc(0, 0, size * 0.018, 0, 2 * Math.PI);
            cr.fill();
        } catch (e) {
            logError(e, 'lintel: painting clock face');
        } finally {
            cr.$dispose();
        }
    }

    _hand(cr, color, angle, length, width, tail = 0) {
        _setSource(cr, color);
        cr.setLineWidth(width);
        cr.moveTo(-Math.sin(angle) * tail, Math.cos(angle) * tail);
        cr.lineTo(Math.sin(angle) * length, -Math.cos(angle) * length);
        cr.stroke();
    }

    _onDispose() {
        if (this._timerId)
            GLib.Source.remove(this._timerId);
        this._timerId = 0;
    }
});

// Big red weekday over the day number, shared with the Calendar widget's look.
function _dayHeader(now) {
    const header = _vbox('lintel-nc-upnext-header');
    header.add_child(_label((now.format('%A') ?? '').toLocaleUpperCase(),
        'lintel-nc-calendar-month'));
    header.add_child(_label(`${now.get_day_of_month()}`,
        'lintel-nc-calendar-big-day'));
    return header;
}

function _dayName(day, format) {
    if (day.offset === 0)
        return shellText('Today');
    if (day.offset === 1)
        return shellText('Tomorrow');
    return _capitalize(GLib.DateTime.new_from_unix_local(
        Math.floor(day.date.getTime() / 1000)).format(format) ?? '');
}

export const UpNextWidget = GObject.registerClass(
class UpNextWidget extends WidgetCard {
    _init(size, onActivated) {
        super._init('upnext', size, onActivated);
        this._service = new UpNextService();
        this._serviceId = this._service.connect('changed', () => this._sync());
        // Past events drop off, and the header rolls over at midnight.
        _tickWhileMapped(this, () => this.refresh());
        this._sync();
    }

    refresh() {
        this._service?.refresh();
        this._sync();
    }

    _launch() {
        _activateCalendar();
    }

    _sync() {
        const service = this._service;
        if (!service)
            return;
        const now = GLib.DateTime.new_now_local();
        const list = this._eventList(service.agenda);

        if (this._size === 'medium') {
            const box = new St.BoxLayout({
                style_class: 'lintel-nc-upnext-split',
                x_expand: true,
                y_expand: true,
            });
            box.add_child(_dayHeader(now));
            box.add_child(list);
            this.setContent(box);
            return;
        }

        const box = _vbox('lintel-nc-upnext-stack', {
            x_expand: true,
            y_expand: true,
        });
        box.add_child(_dayHeader(now));
        box.add_child(list);
        this.setContent(box);
    }

    _eventList(agenda) {
        const list = _vbox('lintel-nc-upnext-list', {
            x_expand: true,
            y_expand: true,
        });
        if (!agenda.length) {
            list.add_child(_wrap(_label(shellText('No Events'),
                'lintel-nc-upnext-empty')));
            return list;
        }

        const grouped = this._size === 'large';
        let budget = UP_NEXT_ROWS[this._size] ?? UP_NEXT_ROWS.medium;
        for (const day of agenda) {
            if (grouped) {
                // A heading with no room for a single event under it is noise.
                if (budget < 3)
                    break;
                list.add_child(_label(_dayName(day, '%A, %-d %B'),
                    'lintel-nc-upnext-section'));
                budget -= 1;
            }
            for (const event of day.events) {
                const cost = grouped ? 2 : 1;
                if (budget < cost)
                    return list;
                list.add_child(this._eventRow(event, day, !grouped));
                budget -= cost;
            }
        }
        return list;
    }

    _eventRow(event, day, withDay) {
        const row = new St.BoxLayout({
            style_class: 'lintel-nc-event',
            x_expand: true,
        });
        row.add_child(new St.Widget({
            style_class: 'lintel-nc-event-bar',
            y_expand: true,
        }));
        const text = _vbox('lintel-nc-event-text', {x_expand: true});
        text.add_child(_label(event.summary, 'lintel-nc-event-title'));
        const when = this._when(event);
        text.add_child(_label(withDay && day.offset > 0
            ? `${_dayName(day, '%a')}, ${when}`
            : when, 'lintel-nc-event-time'));
        row.add_child(text);
        return row;
    }

    _when(event) {
        if (event.allDay)
            return shellContextText('event list time', 'All Day');
        if (event.start.getTime() === event.end.getTime())
            return formatEventTime(event.start);
        // An event that crosses midnight shows only the edge that falls inside
        // the day, as "… – 11:00" or "22:00 – …".
        const start = event.startsBefore ? '…' : formatEventTime(event.start);
        const end = event.endsAfter ? '…' : formatEventTime(event.end);
        return `${start} – ${end}`;
    }

    _onDispose() {
        if (this._serviceId && this._service)
            this._service.disconnect(this._serviceId);
        this._serviceId = 0;
        this._service?.destroy();
        this._service = null;
    }
});

const BarChart = GObject.registerClass(
class BarChart extends St.DrawingArea {
    _init(styleClass) {
        super._init({
            style_class: `lintel-nc-bar-chart ${styleClass}`,
            x_expand: true,
        });
        this._values = [];
        this._highlight = -1;
        this._reference = null;
        this._scaleMax = 0;
        this.connect('repaint', () => this._repaint());
    }

    /**
     * @param {number[]} values
     * @param {object} options
     * @param {number} options.highlight index drawn in the highlight colour
     * @param {number|null} options.reference value marked by a dashed line
     * @param {number} options.scaleMax lower bound for the top of the scale
     */
    setData(values, {highlight = -1, reference = null, scaleMax = 0} = {}) {
        this._values = values;
        this._highlight = highlight;
        this._reference = reference;
        this._scaleMax = scaleMax;
        this.queue_repaint();
    }

    _repaint() {
        const cr = this.get_context();
        try {
            const [width, height] = this.get_surface_size();
            const count = this._values.length;
            if (!count || !width || !height)
                return;

            const node = this.get_theme_node();
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
            const max = Math.max(this._scaleMax, this._reference ?? 0,
                ...this._values, 1);
            // Bars are centred in equal cells, so a homogeneous label row
            // underneath lines up with them exactly.
            const cell = width / count;
            const barWidth = Math.max(scale, cell * 0.62);
            const radius = Math.min(barWidth / 2, 3 * scale);
            const minHeight = 2 * scale;

            _setSource(cr, _themeColor(node, '-lintel-bar-baseline'));
            cr.rectangle(0, height - scale, width, scale);
            cr.fill();

            const fill = _themeColor(node, '-lintel-bar-fill');
            const highlight = _themeColor(node, '-lintel-bar-highlight');
            this._values.forEach((value, i) => {
                if (!(value > 0))
                    return;
                const barHeight = Math.max(minHeight, height * value / max);
                _setSource(cr, i === this._highlight ? highlight : fill);
                _roundedRect(cr, i * cell + (cell - barWidth) / 2,
                    height - barHeight, barWidth, barHeight, radius);
                cr.fill();
            });

            if (this._reference !== null && this._reference > 0) {
                const y = Math.round(height - height * this._reference / max) + 0.5;
                _setSource(cr, _themeColor(node, '-lintel-bar-reference'));
                cr.setLineWidth(scale);
                cr.setDash([3 * scale, 3 * scale], 0);
                cr.moveTo(0, y);
                cr.lineTo(width, y);
                cr.stroke();
            }
        } catch (e) {
            logError(e, 'lintel: painting bar chart');
        } finally {
            cr.$dispose();
        }
    }
});

const LimitMeter = GObject.registerClass(
class LimitMeter extends St.DrawingArea {
    _init() {
        super._init({style_class: 'lintel-nc-limit-meter', x_expand: true});
        this._fraction = 0;
        this.connect('repaint', () => this._repaint());
    }

    setFraction(fraction) {
        this._fraction = Math.max(0, fraction);
        this.queue_repaint();
    }

    _repaint() {
        const cr = this.get_context();
        try {
            const [width, height] = this.get_surface_size();
            if (!width || !height)
                return;
            const node = this.get_theme_node();
            _setSource(cr, _themeColor(node, '-lintel-meter-track'));
            _roundedRect(cr, 0, 0, width, height, height / 2);
            cr.fill();
            const over = this._fraction >= 1;
            _setSource(cr, _themeColor(node, over
                ? '-lintel-meter-over'
                : '-lintel-meter-fill'));
            _roundedRect(cr, 0, 0, Math.max(height, width * Math.min(1, this._fraction)),
                height, height / 2);
            cr.fill();
        } catch (e) {
            logError(e, 'lintel: painting limit meter');
        } finally {
            cr.$dispose();
        }
    }
});

function _axis(texts, align = Clutter.ActorAlign.CENTER) {
    const row = new St.BoxLayout({
        style_class: 'lintel-nc-chart-axis',
        x_expand: true,
    });
    row.layout_manager.homogeneous = true;
    for (const text of texts) {
        row.add_child(_label(text, 'lintel-nc-chart-axis-label', {
            x_expand: true,
            x_align: align,
        }));
    }
    return row;
}

export const ScreenTimeWidget = GObject.registerClass(
class ScreenTimeWidget extends WidgetCard {
    _init(size, onActivated) {
        super._init('screentime', size, onActivated);
        this._service = new ScreenTimeService();
        this._serviceId = this._service.connect('changed', () => this._sync());
        // The current session keeps adding time while the column is open.
        _tickWhileMapped(this, () => this.refresh());
        this._sync();
    }

    refresh() {
        this._service?.refresh();
    }

    _launch() {
        try {
            Gio.Subprocess.new(['gnome-control-center', 'wellbeing'],
                Gio.SubprocessFlags.NONE);
        } catch (e) {
            logError(e, 'lintel: opening Wellbeing settings');
        }
    }

    _sync() {
        const service = this._service;
        if (!service)
            return;

        const title = _label(settingsText('Screen Time'),
            'lintel-nc-screentime-title');
        const summary = service.status === 'ok' ? service.summary : null;
        if (!summary) {
            const box = _vbox(null, {x_expand: true, y_expand: true});
            box.add_child(title);
            box.add_child(_spacer());
            if (service.status === 'disabled') {
                box.add_child(_wrap(_label(
                    settingsText('Screen Time Recording Disabled'),
                    'lintel-nc-screentime-message')));
            } else {
                box.add_child(_label('—', 'lintel-nc-screentime-total'));
            }
            this.setContent(box);
            return;
        }

        const total = _label(formatDuration(summary.today),
            'lintel-nc-screentime-total');
        const limit = service.dailyLimit;
        const meter = limit ? new LimitMeter() : null;
        meter?.setFraction(summary.today / limit);

        if (this._size === 'small') {
            const box = _vbox('lintel-nc-screentime-stack', {
                x_expand: true,
                y_expand: true,
            });
            box.add_child(title);
            box.add_child(total);
            if (meter)
                box.add_child(meter);
            box.add_child(_spacer());
            box.add_child(this._weekChart(summary, false));
            this.setContent(box);
            return;
        }

        if (this._size === 'medium') {
            const box = new St.BoxLayout({
                style_class: 'lintel-nc-screentime-split',
                x_expand: true,
                y_expand: true,
            });
            const left = _vbox('lintel-nc-screentime-summary', {y_expand: true});
            left.add_child(title);
            left.add_child(total);
            left.add_child(_spacer());
            if (meter)
                left.add_child(meter);
            box.add_child(left);
            box.add_child(this._weekChart(summary, true));
            this.setContent(box);
            return;
        }

        const box = _vbox('lintel-nc-screentime-stack', {
            x_expand: true,
            y_expand: true,
        });
        box.add_child(title);
        box.add_child(total);
        if (meter)
            box.add_child(meter);
        box.add_child(_spacer());
        box.add_child(this._hourChart(summary));
        box.add_child(this._weekChart(summary, true));
        this.setContent(box);
    }

    _weekChart(summary, withAxis) {
        const box = _vbox('lintel-nc-chart', {x_expand: true, y_expand: withAxis});
        const chart = new BarChart('lintel-nc-week-chart');
        chart.y_expand = withAxis && this._size === 'medium';
        chart.setData(summary.week.map(day => day.known ? day.seconds : 0), {
            highlight: summary.week.length - 1,
            reference: summary.average,
        });
        box.add_child(chart);
        if (withAxis) {
            box.add_child(_axis(summary.week.map(day => _firstCharacter(
                GLib.DateTime.new_from_unix_local(day.start).format('%a') ?? '')
                .toLocaleUpperCase())));
        }
        return box;
    }

    _hourChart(summary) {
        const box = _vbox('lintel-nc-chart', {x_expand: true});
        const chart = new BarChart('lintel-nc-hour-chart');
        chart.setData(summary.hours.map(hour => hour.seconds), {
            // Scale to a full hour, so a busy hour reads as a full bar.
            scaleMax: 60 * 60,
        });
        box.add_child(chart);
        const format = this._service.uses12h ? '%-l %p' : '%H';
        const labels = [0, 6, 12, 18].map(h => GLib.DateTime.new_from_unix_local(
            summary.hours[h].start).format(format) ?? '');
        box.add_child(_axis(labels, Clutter.ActorAlign.START));
        return box;
    }

    _onDispose() {
        if (this._serviceId && this._service)
            this._service.disconnect(this._serviceId);
        this._serviceId = 0;
        this._service?.destroy();
        this._service = null;
    }
});

const ALERT_FRACTION = 0.9;
const HOT_CELSIUS = 90;
const TEMPERATURE_SCALE_CELSIUS = 100;
// The top of an idle network chart, so a few KB/s of chatter stays near the floor.
const NETWORK_SCALE_FLOOR = 64 * 1024;
const SYSTEM_MONITORS = Object.freeze([
    'io.missioncenter.MissionCenter.desktop',
    'net.nokyan.Resources.desktop',
    'org.gnome.SystemMonitor.desktop',
]);

function _percent(fraction) {
    return `${Math.round(fraction * 100)}%`;
}

function _usage(pair) {
    return pair && pair.total > 0 ? pair.used / pair.total : null;
}

function _temperatureText(celsius) {
    const value = localeTemperatureUnit() === 'fahrenheit'
        ? celsius * 9 / 5 + 32
        : celsius;
    return `${Math.round(value)}°`;
}

function _ratesText(network) {
    if (!network)
        return '';
    const rate = bytes => perSecond(GLib.format_size(Math.round(bytes)));
    return `↓ ${rate(network.rx)}   ↑ ${rate(network.tx)}`;
}

const Sparkline = GObject.registerClass(
class Sparkline extends St.DrawingArea {
    _init(styleClass) {
        super._init({
            style_class: `lintel-nc-sparkline ${styleClass}`,
            x_expand: true,
        });
        this._series = [];
        this._max = 1;
        this.connect('repaint', () => this._repaint());
    }

    /**
     * @param {Array<number[]>} series samples, oldest first; the first series
     *   is drawn filled, any others as plain lines
     * @param {number} max the value at the top edge
     */
    setData(series, max) {
        this._series = series;
        this._max = Math.max(max, Number.EPSILON);
        this.queue_repaint();
    }

    _repaint() {
        const cr = this.get_context();
        try {
            const [width, height] = this.get_surface_size();
            if (!width || !height)
                return;
            const node = this.get_theme_node();
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
            const lineWidth = 1.5 * scale;

            _setSource(cr, _themeColor(node, '-lintel-spark-baseline'));
            cr.rectangle(0, height - scale, width, scale);
            cr.fill();

            // History scrolls in from the right; slots not sampled yet stay empty.
            const step = width / (HISTORY_LENGTH - 1);
            const y = value => height - lineWidth / 2 -
                Math.min(1, Math.max(0, value / this._max)) * (height - lineWidth);
            cr.setLineWidth(lineWidth);
            cr.setLineJoin(Cairo.LineJoin.ROUND);

            this._series.forEach((values, index) => {
                if (values.length < 2)
                    return;
                const color = _themeColor(node, index === 0
                    ? '-lintel-spark-primary'
                    : '-lintel-spark-secondary');
                const left = width - (values.length - 1) * step;
                cr.moveTo(left, y(values[0]));
                values.forEach((value, i) => cr.lineTo(left + i * step, y(value)));
                _setSource(cr, color);
                if (index > 0) {
                    cr.stroke();
                    return;
                }
                cr.strokePreserve();
                cr.lineTo(width, height);
                cr.lineTo(left, height);
                cr.closePath();
                _setSource(cr, color, 0.22);
                cr.fill();
            });
        } catch (e) {
            logError(e, 'lintel: painting sparkline');
        } finally {
            cr.$dispose();
        }
    }
});

export const SystemWidget = GObject.registerClass(
class SystemWidget extends WidgetCard {
    _init(size, onActivated) {
        super._init('system', size, onActivated);
        this._rates = null;
        this._cpuChart = null;
        this._networkChart = null;
        this._cpu = this._gauge('cpu', settingsText('Processor'));
        this._memory = this._gauge('memory', settingsText('Memory'), true);
        this._storage = this._gauge('storage', settingsText('Storage'), true);
        this._temperature = this._gauge('temperature', calculatorText('Temperature'));

        if (size === 'small')
            this.setContent(this._smallLayout());
        else if (size === 'medium')
            this.setContent(this._mediumLayout());
        else
            this.setContent(this._largeLayout());

        this._service = new SystemStatsService();
        this._serviceId = this._service.connect('changed', () => this._sync());
        // Sample only while a System widget is actually on screen.
        this.connect('notify::mapped', () => this._service?.setActive(this.mapped));
        this._service.setActive(this.mapped);
        this._sync();
    }

    refresh() {
        this._sync();
    }

    _launch() {
        for (const id of SYSTEM_MONITORS) {
            if (_activateApp(id))
                return;
        }
    }

    _gauge(kind, caption, withDetail = false) {
        const value = _label('—', 'lintel-nc-ring-value');
        const ring = new RingGauge(
            `lintel-nc-system-ring lintel-nc-ring-${kind}`, value);
        ring.x_align = Clutter.ActorAlign.CENTER;

        const box = _vbox('lintel-nc-gauge', {
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        box.add_child(ring);
        box.add_child(_label(caption, 'lintel-nc-gauge-caption', {
            x_align: Clutter.ActorAlign.CENTER,
        }));
        let detail = null;
        if (withDetail && this._size === 'large') {
            detail = _label('', 'lintel-nc-gauge-detail', {
                x_align: Clutter.ActorAlign.CENTER,
            });
            box.add_child(detail);
        }
        return {box, ring, value, detail};
    }

    _gauges() {
        return [this._cpu, this._memory, this._storage, this._temperature];
    }

    _header(withRates) {
        const header = new St.BoxLayout({
            style_class: 'lintel-nc-system-header',
            x_expand: true,
        });
        header.add_child(_label(settingsText('System'), 'lintel-nc-system-title', {
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        if (withRates) {
            this._rates = _label('', 'lintel-nc-system-rates', {
                y_align: Clutter.ActorAlign.CENTER,
            });
            header.add_child(this._rates);
        }
        return header;
    }

    _gaugeRow() {
        const row = new St.BoxLayout({
            style_class: 'lintel-nc-system-row',
            x_expand: true,
        });
        row.layout_manager.homogeneous = true;
        for (const gauge of this._gauges())
            row.add_child(gauge.box);
        return row;
    }

    // A 2 x 2 grid of gauges; the small square has no room for a title.
    _smallLayout() {
        const layout = new Clutter.GridLayout({
            column_homogeneous: true,
            row_homogeneous: true,
            column_spacing: 6,
            row_spacing: 8,
        });
        const grid = new St.Widget({
            layout_manager: layout,
            x_expand: true,
            y_expand: true,
        });
        this._gauges().forEach((gauge, i) =>
            layout.attach(gauge.box, i % 2, Math.floor(i / 2), 1, 1));
        return grid;
    }

    _mediumLayout() {
        const box = _vbox('lintel-nc-system-stack', {
            x_expand: true,
            y_expand: true,
        });
        box.add_child(this._header(true));
        box.add_child(_spacer());
        box.add_child(this._gaugeRow());
        return box;
    }

    _chart(caption, styleClass) {
        const section = _vbox('lintel-nc-system-chart', {x_expand: true});
        const header = new St.BoxLayout({x_expand: true});
        header.add_child(_label(caption, 'lintel-nc-gauge-caption', {
            x_expand: true,
        }));
        const value = _label('', 'lintel-nc-system-rates');
        header.add_child(value);
        section.add_child(header);
        const chart = new Sparkline(styleClass);
        section.add_child(chart);
        return {section, value, chart};
    }

    _largeLayout() {
        const box = _vbox('lintel-nc-system-stack', {
            x_expand: true,
            y_expand: true,
        });
        box.add_child(this._header(false));
        box.add_child(this._gaugeRow());
        box.add_child(_spacer());
        this._cpuChart = this._chart(settingsText('Processor'),
            'lintel-nc-sparkline-cpu');
        this._networkChart = this._chart(settingsText('Network'),
            'lintel-nc-sparkline-network');
        this._rates = this._networkChart.value;
        box.add_child(this._cpuChart.section);
        box.add_child(this._networkChart.section);
        return box;
    }

    _showUsage(gauge, fraction, detail = '') {
        const known = fraction !== null;
        gauge.ring.setLevel(known ? fraction : 0, known && fraction >= ALERT_FRACTION);
        gauge.value.text = known ? _percent(fraction) : '—';
        if (gauge.detail)
            gauge.detail.text = detail;
    }

    _sync() {
        const service = this._service;
        if (!service)
            return;

        const {cpu, memory, storage, temperature, network} = service;
        this._showUsage(this._cpu, cpu);
        this._showUsage(this._memory, _usage(memory),
            memory ? GLib.format_size(memory.used) : '');
        this._showUsage(this._storage, _usage(storage),
            storage ? GLib.format_size(storage.used) : '');

        // No known sensor: leave the gauge out rather than show a blank one.
        this._temperature.box.visible = temperature !== null;
        if (temperature !== null) {
            this._temperature.ring.setLevel(temperature / TEMPERATURE_SCALE_CELSIUS,
                temperature >= HOT_CELSIUS);
            this._temperature.value.text = _temperatureText(temperature);
        }

        if (this._rates)
            this._rates.text = _ratesText(network);
        if (this._cpuChart) {
            this._cpuChart.value.text = cpu === null ? '' : _percent(cpu);
            this._cpuChart.chart.setData([service.cpuHistory], 1);
        }
        if (this._networkChart) {
            const rx = service.rxHistory;
            const tx = service.txHistory;
            this._networkChart.chart.setData([rx, tx],
                Math.max(NETWORK_SCALE_FLOOR, ...rx, ...tx));
        }
    }

    _onDispose() {
        if (this._serviceId && this._service)
            this._service.disconnect(this._serviceId);
        this._serviceId = 0;
        this._service?.destroy();
        this._service = null;
    }
});
