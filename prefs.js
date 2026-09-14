// SPDX-License-Identifier: GPL-2.0-or-later
//
// Preferences UI for every gsettings key. Structural keys (widgets, clock
// position, Activities) are re-applied live by PanelController; appearance/clock
// keys are watched live by ThemeManager/LintelClock — so every control here takes
// effect immediately, no re-enable needed.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {_} from './src/i18n.js';
import {sanitizeFontFamily, sanitizeFontWeight} from './src/cssValues.js';
import {
    newSession,
    preferredLanguage,
    searchCities,
} from './src/services/weatherProviders.js';

const CITY_SEARCH_DELAY_MS = 400;

function addSwitch(group, settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    group.add(row);
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function addEntry(group, settings, key, title, subtitle = '') {
    const row = new Adw.EntryRow({title});
    if (subtitle)
        row.set_tooltip_text(subtitle);
    group.add(row);
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// Mark an entry red while its text would be ignored by the panel.
function addValidatedEntry(group, settings, key, title, subtitle, sanitize) {
    const row = addEntry(group, settings, key, title, subtitle);
    const sync = () => {
        const text = row.text.trim();
        if (text && !sanitize(text))
            row.add_css_class('error');
        else
            row.remove_css_class('error');
    };
    row.connect('notify::text', sync);
    sync();
    return row;
}

// A value is "icon-like" (an icon-theme name or a file path) rather than an
// emoji/symbol glyph. Kept in sync with LintelSystemMenu._isIconLike so the picker
// and the widget agree on how a value is rendered.
function isIconLike(v) {
    if (!v)
        return false;
    if (v.startsWith('/') || v.startsWith('~') || v.startsWith('file:'))
        return true;
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v);
}

// Quick-pick glyphs. The emoji chooser covers every emoji; these add the useful
// non-emoji symbols (command, gear, star…) that the chooser does not list.
const PRESET_GLYPHS = ['', '', '', '⌘', '★', '⚙', '◉', ''];

/**
 * A logo picker: a live preview, an emoji chooser, quick-pick symbol buttons and
 * a reset-to-default button. Writes the chosen glyph straight into `key`. Custom
 * icon-theme names / file paths are still supported via the advanced entry.
 */
function addGlyphPicker(group, settings, key, title, subtitle = '') {
    const row = new Adw.ActionRow({title, subtitle});

    const preview = new Gtk.Label({
        valign: Gtk.Align.CENTER,
        width_chars: 2,
        css_classes: ['title-2'],
    });

    const emojiButton = new Gtk.MenuButton({
        icon_name: 'face-smile-symbolic',
        tooltip_text: _('Pick an emoji'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    const chooser = new Gtk.EmojiChooser();
    emojiButton.set_popover(chooser);
    chooser.connect('emoji-picked',
        (_c, text) => settings.set_string(key, text));

    const clearButton = new Gtk.Button({
        icon_name: 'edit-clear-symbolic',
        tooltip_text: _('Use the distro / GNOME logo'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    clearButton.connect('clicked', () => settings.set_string(key, ''));

    const suffix = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        valign: Gtk.Align.CENTER,
    });
    [preview, emojiButton, clearButton].forEach(w => suffix.append(w));
    row.add_suffix(suffix);
    group.add(row);

    // Quick-pick symbol strip.
    const presetRow = new Adw.ActionRow({title: _('Quick symbols')});
    const presetBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 4,
        valign: Gtk.Align.CENTER,
    });
    for (const glyph of PRESET_GLYPHS) {
        const button = new Gtk.Button({
            label: glyph,
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        button.connect('clicked', () => settings.set_string(key, glyph));
        presetBox.append(button);
    }
    presetRow.add_suffix(presetBox);
    group.add(presetRow);

    const sync = () => {
        const v = settings.get_string(key);
        preview.label = v && !isIconLike(v) ? v : '';
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    return row;
}

function addSpin(group, settings, key, opts) {
    const {title, subtitle = '', lower, upper, step = 1, digits = 0} = opts;
    const isDouble = digits > 0;
    const adjustment = new Gtk.Adjustment({
        lower, upper,
        step_increment: step,
        page_increment: step * 10,
    });
    const row = new Adw.SpinRow({title, subtitle, digits, adjustment});
    group.add(row);

    const read = () => isDouble ? settings.get_double(key) : settings.get_int(key);
    const write = v => isDouble
        ? settings.set_double(key, v)
        : settings.set_int(key, Math.round(v));

    adjustment.set_value(read());
    adjustment.connect('value-changed', () => {
        const v = adjustment.get_value();
        if (v !== read())
            write(v);
    });
    settings.connect(`changed::${key}`, () => {
        const v = read();
        if (v !== adjustment.get_value())
            adjustment.set_value(v);
    });
    return row;
}

function addCombo(group, settings, key, title, options, subtitle = '') {
    const model = new Gtk.StringList();
    options.forEach(o => model.append(o.label));
    const row = new Adw.ComboRow({title, subtitle, model});
    group.add(row);

    const nicks = options.map(o => o.nick);
    const sync = () => {
        const i = nicks.indexOf(settings.get_string(key));
        if (i >= 0 && i !== row.selected)
            row.selected = i;
    };
    sync();
    row.connect('notify::selected', () => {
        const nick = nicks[row.selected];
        if (nick && nick !== settings.get_string(key))
            settings.set_string(key, nick);
    });
    settings.connect(`changed::${key}`, sync);
    return row;
}

export default class LintelPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.search_enabled = true;

        this._buildLayoutPage(window, settings);
        this._buildClockPage(window, settings);
        this._buildWeatherPage(window, settings);
        this._buildAppearancePage(window, settings);
    }

    _buildLayoutPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Layout'),
            // `view-columns-symbolic` does not exist in Adwaita, so GTK fell
            // back to the missing-image glyph. This one ships in Adwaita and
            // is literally the top-bar icon.
            icon_name: 'focus-top-bar-symbolic',
        });

        const layout = new Adw.PreferencesGroup({title: _('Panel')});
        addSwitch(layout, settings, 'hide-activities',
            _('Hide Activities'), _('Hide the workspace / Activities indicator'));
        addSwitch(layout, settings, 'clock-on-right',
            _('Clock on the right'), _('Move the clock to the far right, macOS-style'));
        addSwitch(layout, settings, 'fullscreen-reveal',
            _('Reveal in full screen'),
            _('Push the pointer against the top edge to show the panel temporarily'));
        page.add(layout);

        const notifications = new Adw.PreferencesGroup({
            title: _('Notification Center'),
            description: _('Widgets are added, removed, reordered and resized from Edit Widgets inside Notification Center.'),
        });
        addSwitch(notifications, settings, 'notification-center-enabled',
            _('Tahoe Notification Center'),
            _('Open notifications and widgets when the clock or Super+V is pressed'));
        page.add(notifications);

        const system = new Adw.PreferencesGroup({title: _('System menu')});
        addSwitch(system, settings, 'show-system-menu',
            _('Show system menu'), _('The left-hand Apple-style logo menu'));
        addGlyphPicker(system, settings, 'system-menu-icon',
            _('Logo icon'), _('Emoji or symbol; empty = your distribution’s logo'));
        addEntry(system, settings, 'system-menu-icon',
            _('Custom icon name / path'),
            _('Advanced: an icon-theme name (e.g. start-here-symbolic) or file path'));
        page.add(system);

        const app = new Adw.PreferencesGroup({title: _('Active application')});
        addSwitch(app, settings, 'show-active-app',
            _('Show app name'), _('Bold name of the focused application'));
        addEntry(app, settings, 'empty-app-label',
            _('Label when idle'), _('Shown when nothing is focused; empty = hide'));
        page.add(app);

        const cc = new Adw.PreferencesGroup({title: _('Control Center')});
        addCombo(cc, settings, 'control-center-mode', _('Mode'), [
            {nick: 'custom', label: _('Custom popup (replaces Quick Settings)')},
            {nick: 'native', label: _('Open native Quick Settings')},
        ], _('Custom adds three independent menu-bar items and hides native Quick Settings'));
        page.add(cc);

        window.add(page);
    }

    _buildClockPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Clock'),
            icon_name: 'preferences-system-time-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('Clock format'),
            description: _('12-hour / 24-hour follows the system setting.'),
        });
        // Ordered like macOS's own Clock Options list.
        addCombo(group, settings, 'clock-date-mode', _('Show date'), [
            {nick: 'when-space-allows', label: _('When space allows')},
            {nick: 'always', label: _('Always')},
            {nick: 'never', label: _('Never')},
        ], _('When space allows: the date is dropped once the bar runs out of room'));
        addSwitch(group, settings, 'clock-show-weekday', _('Show the day of the week'));
        addSwitch(group, settings, 'clock-show-ampm', _('Show AM/PM'),
            _('Only applies while the system uses a 12-hour clock'));
        addSwitch(group, settings, 'clock-show-seconds', _('Show seconds'));
        page.add(group);

        window.add(page);
    }

    _buildWeatherPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Weather'),
            icon_name: 'weather-few-clouds-symbolic',
        });

        const source = new Adw.PreferencesGroup({
            title: _('Weather widget'),
            description: _('Both services are free and need no account. The location’s coordinates are sent to the one selected.'),
        });
        addCombo(source, settings, 'weather-provider', _('Service'), [
            {nick: 'open-meteo', label: 'Open-Meteo'},
            {nick: 'wttr', label: 'wttr.in'},
        ], _('Open-Meteo forecasts every hour, wttr.in every three hours'));
        addCombo(source, settings, 'weather-units', _('Temperature'), [
            {nick: 'auto', label: _('Follow region')},
            {nick: 'celsius', label: _('Celsius')},
            {nick: 'fahrenheit', label: _('Fahrenheit')},
        ]);
        page.add(source);

        const place = new Adw.PreferencesGroup({title: _('Location')});
        addCombo(place, settings, 'weather-location-mode', _('Location'), [
            {nick: 'auto', label: _('Current location')},
            {nick: 'manual', label: _('Chosen city')},
        ]);

        let privacy = null;
        try {
            privacy = new Gio.Settings({schema_id: 'org.gnome.system.location'});
        } catch (_e) {
            privacy = null;
        }
        const servicesRow = new Adw.ActionRow({title: _('Location Services')});
        const servicesButton = new Gtk.Button({
            label: _('Open Settings'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        servicesButton.connect('clicked', () => {
            try {
                Gio.Subprocess.new(['gnome-control-center', 'privacy'],
                    Gio.SubprocessFlags.NONE);
            } catch (e) {
                logError(e, 'lintel: opening Location settings');
            }
        });
        servicesRow.add_suffix(servicesButton);
        place.add(servicesRow);

        const cityRow = new Adw.ActionRow({title: _('City')});
        place.add(cityRow);

        const search = new Adw.EntryRow({title: _('Search for a city')});
        place.add(search);

        const syncLocation = () => {
            const auto = settings.get_string('weather-location-mode') === 'auto';
            const enabled = privacy?.get_boolean('enabled') ?? false;
            servicesRow.visible = auto;
            servicesRow.subtitle = enabled
                ? _('On — the city below is used only if locating fails')
                : _('Off — the city below is used instead');
            const [name] = settings.get_value('weather-location').deep_unpack();
            cityRow.subtitle = name || _('None chosen');
        };
        syncLocation();
        settings.connect('changed::weather-location-mode', syncLocation);
        settings.connect('changed::weather-location', syncLocation);
        privacy?.connect('changed::enabled', syncLocation);

        // Results are plain rows appended under the search entry.
        const session = newSession();
        const language = preferredLanguage();
        const resultRows = [];
        let cancellable = null;
        let debounceId = 0;

        const clearResults = () => {
            for (const row of resultRows.splice(0))
                place.remove(row);
        };
        const addResultRow = row => {
            resultRows.push(row);
            place.add(row);
        };
        const runSearch = async query => {
            cancellable?.cancel();
            const own = new Gio.Cancellable();
            cancellable = own;
            try {
                const cities = await searchCities(session, query, language, own);
                if (own.is_cancelled())
                    return;
                clearResults();
                if (!cities.length) {
                    addResultRow(new Adw.ActionRow({
                        title: _('No cities found'),
                        css_classes: ['dim-label'],
                    }));
                    return;
                }
                for (const city of cities) {
                    const row = new Adw.ActionRow({
                        title: city.name,
                        subtitle: city.detail,
                        activatable: true,
                    });
                    row.connect('activated', () => {
                        settings.set_value('weather-location', new GLib.Variant(
                            '(sdds)',
                            [city.name, city.latitude, city.longitude, city.timezone]));
                        settings.set_string('weather-location-mode', 'manual');
                        search.text = '';
                    });
                    addResultRow(row);
                }
            } catch (e) {
                if (own.is_cancelled())
                    return;
                clearResults();
                addResultRow(new Adw.ActionRow({
                    title: _('Search failed'),
                    subtitle: e.message,
                    css_classes: ['dim-label'],
                }));
            }
        };

        search.connect('changed', () => {
            if (debounceId)
                GLib.source_remove(debounceId);
            debounceId = 0;
            const query = search.text.trim();
            if (query.length < 2) {
                cancellable?.cancel();
                clearResults();
                return;
            }
            debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                CITY_SEARCH_DELAY_MS, () => {
                    debounceId = 0;
                    runSearch(query);
                    return GLib.SOURCE_REMOVE;
                });
        });
        window.connect('close-request', () => {
            if (debounceId)
                GLib.source_remove(debounceId);
            debounceId = 0;
            cancellable?.cancel();
            session.abort();
            return false;
        });

        page.add(place);
        window.add(page);
    }

    _buildAppearancePage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });

        const style = new Adw.PreferencesGroup({title: _('Style')});
        addCombo(style, settings, 'appearance', _('Background'), [
            {nick: 'tahoe-transparent', label: _('Transparent (Tahoe)')},
            {nick: 'translucent', label: _('Translucent')},
            {nick: 'solid', label: _('Solid')},
            {nick: 'follow-gnome', label: _('Follow GNOME theme')},
        ]);
        addCombo(style, settings, 'text-mode', _('Text colour'), [
            {nick: 'auto', label: _('Automatic (background-aware)')},
            {nick: 'light', label: _('Light')},
            {nick: 'dark', label: _('Dark')},
        ]);
        addCombo(style, settings, 'overview-mode', _('In the Overview'), [
            {nick: 'transparent', label: _('Transparent')},
            {nick: 'keep', label: _('Keep Lintel bar')},
            {nick: 'native', label: _('Native GNOME')},
        ]);
        addSwitch(style, settings, 'show-menu-background',
            _('Background on open'), _('Rounded wash while a button is open'));
        page.add(style);

        const metrics = new Adw.PreferencesGroup({title: _('Metrics')});
        addSpin(metrics, settings, 'panel-height',
            {title: _('Panel height'), subtitle: _('0 = theme default'),
                lower: 0, upper: 128});
        addSpin(metrics, settings, 'h-padding',
            {title: _('Button padding'), subtitle: _('Default 10; -1 = inherit'),
                lower: -1, upper: 64});
        addSpin(metrics, settings, 'item-spacing',
            {title: _('Item spacing'), subtitle: _('Default 0; -1 = inherit'),
                lower: -1, upper: 64});
        addSpin(metrics, settings, 'corner-radius',
            {title: _('Corner radius'), subtitle: _('High = pill'),
                lower: 0, upper: 9999});
        addSpin(metrics, settings, 'transition-ms',
            {title: _('Transition (ms)'), lower: 0, upper: 1000, step: 10});
        page.add(metrics);

        const font = new Adw.PreferencesGroup({title: _('Font')});
        addValidatedEntry(font, settings, 'font-family',
            _('Family'), _('One font family name; empty = Cantarell'),
            sanitizeFontFamily);
        addValidatedEntry(font, settings, 'font-weight',
            _('Weight'), _('e.g. normal, bold, 600; empty = inherit'),
            sanitizeFontWeight);
        addSpin(font, settings, 'font-size-pt',
            {title: _('Size (pt)'), subtitle: _('0 = inherit; 10.5pt = macOS’s 14px'),
                lower: 0, upper: 48, step: 0.5, digits: 1});
        page.add(font);

        const washes = new Adw.PreferencesGroup({title: _('Hover / press')});
        addSpin(washes, settings, 'hover-opacity',
            {title: _('Hover opacity'), lower: 0, upper: 1, step: 0.01, digits: 2});
        addSpin(washes, settings, 'active-opacity',
            {title: _('Active opacity'), lower: 0, upper: 1, step: 0.01, digits: 2});
        page.add(washes);

        window.add(page);
    }
}
