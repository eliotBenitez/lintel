// ThemeManager — Stage 8 (Tahoe appearance).
//
// Discrete appearance modes plus continuous tunables (height, padding, spacing,
// font, hover/active opacity, text colour) can't live in a static stylesheet, so
// we GENERATE CSS from settings and load it over the shell theme via
// St.Theme.load_stylesheet — the standard dynamic-theming pattern. Everything is
// scoped under `.lintel` / `#panel.lintel` (the class PanelController adds),
// so it only affects our panel and vanishes when the sheet is unloaded on
// disable.
//
// Overview safety: forcing a background on #panel would make the panel opaque in
// the Overview (where GNOME wants it transparent). We instead toggle a
// `lintel-overview-transparent` class on the panel across Overview show/hide
// (per the `overview-mode` setting) which zeroes the background there.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FILE_NAME = 'lintel-dynamic.css';
const OVERVIEW_CLASS = 'lintel-overview-transparent';
const CONTRAST_SAMPLE_FRACTIONS = [0.08, 0.20, 0.34, 0.50, 0.66, 0.80, 0.92];
const DARK_TEXT_THRESHOLD = 0.18;
const CONTRAST_HYSTERESIS = 0.035;

const clamp01 = v => Math.max(0, Math.min(1, v));

export class ThemeManager {
    constructor(extension) {
        this._extension = extension;
        this._enabled = false;
        this._settings = null;
        this._settingsId = 0;
        this._desktop = null;
        this._desktopId = 0;
        this._background = null;
        this._backgroundId = 0;
        this._fullscreenId = 0;
        this._focusWindowId = 0;
        this._monitorsId = 0;
        this._contrastId = 0;
        this._contrastSerial = 0;
        this._autoTextIsDark = null;
        this._themeContext = null;
        this._themeChangedId = 0;
        this._overviewShowingId = 0;
        this._overviewHidingId = 0;
        this._file = null;
        this._loaded = false;
        this._applying = false;
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;

        try {
            this._settings = this._extension?.getSettings?.() ?? null;
        } catch (_e) {
            this._settings = null;
        }
        if (this._settings) {
            this._settingsId = this._settings.connect('changed', () => {
                this._rebuild();
                this.requestContrastUpdate();
            });
        }

        this._desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._desktopId = this._desktop.connect(
            'changed::color-scheme', () => {
                this._rebuild();
                this.requestContrastUpdate();
            });

        this._background = new Gio.Settings({
            schema_id: 'org.gnome.desktop.background',
        });
        this._backgroundId = this._background.connect(
            'changed', () => this.requestContrastUpdate(1100));

        this._fullscreenId = global.display.connect(
            'in-fullscreen-changed', () => this.requestContrastUpdate(250));
        this._focusWindowId = global.display.connect(
            'notify::focus-window', () => this.requestContrastUpdate(250));
        this._monitorsId = Main.layoutManager.connect(
            'monitors-changed', () => this.requestContrastUpdate(250));

        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        // Re-apply our sheet if the shell theme is reloaded/replaced.
        this._themeChangedId = this._themeContext.connect('changed', () => {
            if (!this._applying)
                this._reload();
        });

        this._overviewShowingId = Main.overview.connect('showing', () => {
            this._setOverview(true);
            this.requestContrastUpdate(300);
        });
        this._overviewHidingId = Main.overview.connect('hiding', () => {
            this._setOverview(false);
            this.requestContrastUpdate(300);
        });

        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'lintel']);
        GLib.mkdir_with_parents(dir, 0o755);
        this._file = Gio.File.new_for_path(GLib.build_filenamev([dir, FILE_NAME]));

        this._rebuild();
        this._setOverview(Main.overview.visible);
        this.requestContrastUpdate(250);
    }

    // ---- Generation ---------------------------------------------------------

    _rebuild() {
        const css = this._generate();
        try {
            const bytes = new TextEncoder().encode(css);
            this._file.replace_contents(
                bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            logError(e, 'lintel: writing dynamic stylesheet');
            return;
        }
        this._reload();
    }

    _reload() {
        const theme = this._themeContext?.get_theme();
        if (!theme || !this._file)
            return;
        this._applying = true;
        try {
            if (this._loaded)
                theme.unload_stylesheet(this._file);
            theme.load_stylesheet(this._file);
            this._loaded = true;
        } catch (e) {
            logError(e, 'lintel: loading dynamic stylesheet');
        } finally {
            this._applying = false;
        }
    }

    // ---- Tahoe adaptive contrast ------------------------------------------

    /** Re-sample the pixels actually visible behind a transparent panel. */
    requestContrastUpdate(delay = 180) {
        if (!this._enabled)
            return;
        // Invalidate an in-flight read immediately; the replacement sample may
        // intentionally be delayed until a wallpaper/fullscreen transition ends.
        this._contrastSerial++;
        if (this._contrastId) {
            GLib.Source.remove(this._contrastId);
            this._contrastId = 0;
        }
        if (!this._usesAdaptiveContrast())
            return;

        this._contrastId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, Math.max(0, delay), () => {
                this._contrastId = 0;
                this._sampleContrast().catch(e =>
                    logError(e, 'lintel: sampling panel contrast'));
                return GLib.SOURCE_REMOVE;
            });
    }

    _settingString(key, fallback) {
        try {
            return this._settings ? this._settings.get_string(key) : fallback;
        } catch (_e) {
            return fallback;
        }
    }

    _panelIsTransparentNow() {
        if (this._settingString('appearance', 'tahoe-transparent') ===
            'tahoe-transparent')
            return true;
        if (!Main.overview.visible)
            return false;
        return this._settingString('overview-mode', 'transparent') !== 'keep';
    }

    _usesAdaptiveContrast() {
        return this._settingString('text-mode', 'auto') === 'auto' &&
            this._panelIsTransparentNow();
    }

    async _sampleContrast() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!this._enabled || !monitor || !this._usesAdaptiveContrast())
            return;

        const serial = ++this._contrastSerial;
        // The first couple of rows are free of centred panel glyphs/text, so
        // they expose the real wallpaper (or fullscreen content) even while the
        // transparent panel is visible. Multiple horizontal samples make the
        // choice stable on split-tone and photographic backgrounds.
        const y = Math.round(monitor.y + 1);
        const samples = [];
        for (const fraction of CONTRAST_SAMPLE_FRACTIONS) {
            if (!this._enabled || serial !== this._contrastSerial)
                return;
            const x = Math.round(monitor.x +
                Math.max(1, monitor.width - 2) * fraction);
            try {
                const [color] = await new Shell.Screenshot().pick_color(x, y);
                if (color)
                    samples.push(this._relativeLuminance(color));
            } catch (_e) {
                // A monitor transition can invalidate a coordinate mid-sample.
            }
        }

        if (!this._enabled || serial !== this._contrastSerial || !samples.length)
            return;
        samples.sort((a, b) => a - b);
        const luminance = samples[Math.floor(samples.length / 2)];

        let darkText;
        if (this._autoTextIsDark === null)
            darkText = luminance >= DARK_TEXT_THRESHOLD;
        else if (this._autoTextIsDark)
            darkText = luminance >= DARK_TEXT_THRESHOLD - CONTRAST_HYSTERESIS;
        else
            darkText = luminance > DARK_TEXT_THRESHOLD + CONTRAST_HYSTERESIS;

        if (darkText === this._autoTextIsDark)
            return;
        this._autoTextIsDark = darkText;
        this._rebuild();
    }

    _relativeLuminance(color) {
        const linear = channel => {
            const value = channel / 255;
            return value <= 0.04045
                ? value / 12.92
                : ((value + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * linear(color.red) +
            0.7152 * linear(color.green) +
            0.0722 * linear(color.blue);
    }

    _generate() {
        const s = this._settings;
        const gi = (k, d) => {
            try { return s ? s.get_int(k) : d; } catch (_e) { return d; }
        };
        const gd = (k, d) => {
            try { return s ? s.get_double(k) : d; } catch (_e) { return d; }
        };
        const gs = (k, d) => {
            try { return s ? s.get_string(k) : d; } catch (_e) { return d; }
        };
        const gb = (k, d) => {
            try { return s ? s.get_boolean(k) : d; } catch (_e) { return d; }
        };

        const appearance = gs('appearance', 'tahoe-transparent');
        const textMode = gs('text-mode', 'auto');
        const isDark = this._isDark();

        let fg = isDark ? '255, 255, 255' : '34, 34, 38';
        if (textMode === 'auto' && this._panelIsTransparentNow() &&
            this._autoTextIsDark !== null)
            fg = this._autoTextIsDark ? '34, 34, 38' : '255, 255, 255';
        else if (textMode === 'light')
            fg = '255, 255, 255';
        else if (textMode === 'dark')
            fg = '34, 34, 38';

        const lines = [];
        const panel = [];

        if (appearance === 'tahoe-transparent')
            panel.push('background-color: transparent;');
        else if (appearance === 'translucent')
            panel.push(`background-color: ${isDark ? 'rgba(20, 20, 20, 0.30)' : 'rgba(245, 245, 245, 0.30)'};`);
        else if (appearance === 'solid')
            panel.push(`background-color: ${isDark ? '#000000' : '#FAFAFB'};`);
        // follow-gnome: emit no background line.

        panel.push(`color: rgb(${fg});`);

        // Tahoe's bar is a fixed 24px. Shell themes routinely set the panel
        // height with !important (MacTahoe uses 40px), so an explicit height
        // has to be marked important or the theme silently wins.
        const h = gi('panel-height', 24);
        if (h > 0)
            panel.push(`height: ${h}px !important;`);

        const fam = gs('font-family', '');
        // St's CSS parser accepts a single Pango family here, not a browser-style
        // comma-separated fallback list. Pango falls back to the system sans
        // font if a user-requested family is unavailable.
        panel.push(`font-family: "${fam || 'Cantarell'}";`);
        const fs = gd('font-size-pt', 10.5);
        if (fs > 0)
            panel.push(`font-size: ${fs}pt;`);
        const fw = gs('font-weight', 'normal');
        if (fw)
            panel.push(`font-weight: ${fw};`);

        lines.push(`#panel.lintel { ${panel.join(' ')} }`);

        // Both GNOME and third-party themes set the weight on the button as
        // well as on #panel, so the panel-level declaration alone leaves every
        // menu title bold. In Tahoe only the app title is emphasised.
        const buttonText = [];
        if (fs > 0)
            buttonText.push(`font-size: ${fs}pt;`);
        if (fw)
            buttonText.push(`font-weight: ${fw};`);
        if (buttonText.length) {
            lines.push(`#panel.lintel .panel-button { ${buttonText.join(' ')} }`);
            lines.push('#panel.lintel .panel-button .lintel-active-app ' +
                '{ font-weight: 600; }');
        }

        // Readability over the wallpaper in fully-transparent mode.
        if (appearance === 'tahoe-transparent') {
            const shadow = fg === '255, 255, 255'
                ? 'rgba(0, 0, 0, 0.28)'
                : 'rgba(255, 255, 255, 0.20)';
            lines.push(`#panel.lintel { text-shadow: 0 1px 2px ${shadow}; }`);
            lines.push(`#panel.lintel StIcon { icon-shadow: 0 1px 2px ${shadow}; }`);
        }

        // Overview: zero the background when our class is present.
        lines.push(`#panel.lintel.${OVERVIEW_CLASS} { background-color: transparent; }`);

        // Buttons: Tahoe hover/press treatment (Stage 9).
        //
        // Normal state is EXPLICITLY transparent with a set transition so the
        // wash fades in/out (St only animates a property that has a from-value).
        // The pill radius is applied on every state, not just hover, so the shape
        // is stable while the colour animates.
        const pad = gi('h-padding', 10);
        const spacing = gi('item-spacing', 0);
        const radius = Math.max(0, gi('corner-radius', 99));
        const ms = Math.max(0, gi('transition-ms', 120));

        const base = [
            'background-color: transparent;',
            `border-radius: ${radius}px;`,
            `transition-duration: ${ms}ms;`,
        ];
        if (pad >= 0) {
            const minimumPad = Math.min(pad, 5);
            base.push(`-natural-hpadding: ${pad}px; ` +
                `-minimum-hpadding: ${minimumPad}px;`);
        }
        if (spacing >= 0)
            base.push(`margin-left: ${spacing}px; margin-right: ${spacing}px;`);
        lines.push(`#panel.lintel .panel-button { ${base.join(' ')} }`);

        const hov = clamp01(gd('hover-opacity', 0.12));
        const act = clamp01(gd('active-opacity', 0.20));
        lines.push(`#panel.lintel .panel-button:hover { background-color: rgba(${fg}, ${hov}); }`);
        if (gb('show-menu-background', true)) {
            lines.push(`#panel.lintel .panel-button:active, #panel.lintel .panel-button:checked, #panel.lintel .panel-button:focus { background-color: rgba(${fg}, ${act}); }`);
            // Hovering an already-open button reads a touch stronger.
            lines.push(`#panel.lintel .panel-button:checked:hover, #panel.lintel .panel-button:active:hover { background-color: rgba(${fg}, ${clamp01(act + 0.04)}); }`);
        } else {
            lines.push('#panel.lintel .panel-button:active, #panel.lintel .panel-button:checked { background-color: transparent; }');
        }

        return lines.join('\n');
    }

    _isDark() {
        try {
            return this._desktop.get_string('color-scheme') === 'prefer-dark';
        } catch (_e) {
            return false;
        }
    }

    // ---- Overview -----------------------------------------------------------

    _setOverview(showing) {
        const panel = Main.panel;
        if (!panel)
            return;
        let mode = 'transparent';
        try {
            mode = this._settings ? this._settings.get_string('overview-mode') : 'transparent';
        } catch (_e) {
            mode = 'transparent';
        }
        const transparent = showing && mode !== 'keep';
        if (transparent)
            panel.add_style_class_name(OVERVIEW_CLASS);
        else
            panel.remove_style_class_name(OVERVIEW_CLASS);
    }

    // ---- Teardown -----------------------------------------------------------

    destroy() {
        this._enabled = false;
        this._contrastSerial++;

        if (this._contrastId) {
            GLib.Source.remove(this._contrastId);
            this._contrastId = 0;
        }

        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        if (this._desktopId && this._desktop) {
            this._desktop.disconnect(this._desktopId);
            this._desktopId = 0;
        }
        if (this._backgroundId && this._background) {
            this._background.disconnect(this._backgroundId);
            this._backgroundId = 0;
        }
        if (this._fullscreenId) {
            global.display.disconnect(this._fullscreenId);
            this._fullscreenId = 0;
        }
        if (this._focusWindowId) {
            global.display.disconnect(this._focusWindowId);
            this._focusWindowId = 0;
        }
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        if (this._themeChangedId && this._themeContext) {
            this._themeContext.disconnect(this._themeChangedId);
            this._themeChangedId = 0;
        }
        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = 0;
        }
        if (this._overviewHidingId) {
            Main.overview.disconnect(this._overviewHidingId);
            this._overviewHidingId = 0;
        }

        Main.panel?.remove_style_class_name(OVERVIEW_CLASS);

        const theme = this._themeContext?.get_theme();
        if (this._loaded && theme && this._file) {
            this._applying = true;
            try {
                theme.unload_stylesheet(this._file);
            } catch (_e) {
                // ignore
            } finally {
                this._applying = false;
            }
        }
        this._loaded = false;

        try {
            this._file?.delete(null);
        } catch (_e) {
            // best-effort cleanup
        }

        this._themeContext = null;
        this._desktop = null;
        this._background = null;
        this._settings = null;
        this._file = null;
        this._extension = null;
    }
}
