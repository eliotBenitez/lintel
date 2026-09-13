// LintelSystemMenu — Stage 3, Tahoe visual pass.
//
// The macOS Apple-menu analogue on the far left: a logo button whose popup holds
// About / Settings / App Center, Recent Items, Force Quit, and the power/session
// actions (Sleep / Restart / Shut Down / Lock / Log Out).  The popup uses its
// own tightly-scoped actor classes: GNOME's stock popup metrics are almost twice
// as tall as the compact menu in the macOS reference and must not leak in here.
//
// Principles:
//   • Power/session items reuse GNOME's own SystemActions (misc/systemActions.js)
//     — it handles availability ("can-*") and the confirmation dialogs, exactly
//     like Quick Settings. We never re-implement logind/session D-Bus by hand.
//   • Native program launchers are shown only when installed; App Center uses
//     the desktop's appstream:// handler so distro-specific stores still work.
//   • The logo is user-configurable and defaults to the neutral distributor icon
//     `start-here-symbolic` — never a bundled Apple asset.
//   • Full teardown: destroy() disconnects every signal we made, then the
//     PanelMenu.Button base tears down the actor + menu, and Panel.addToStatusArea
//     removes us from statusArea automatically on that destroy.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import {_} from '../i18n.js';

const FALLBACK_LOGO = 'start-here-symbolic';

// os-release LOGO= is "the name of an icon as defined by freedesktop.org Icon
// Theme Specification", and it is optional. So the logo has to be looked up the
// way the spec says — hicolor at whatever size the distribution installed, plus
// /usr/share/pixmaps — and not assumed to live at one fixed path.
//
// Looking it up by NAME through the active icon theme would be wrong here: a
// themed name is whatever the theme decides, and Apple-styled themes map
// `start-here-symbolic` to an Apple glyph, which is what users saw by default.
// Reading the file out of hicolor keeps the distributor's own artwork whatever
// theme is set.
const LOGO_HICOLOR_ROOTS = [
    '/usr/share/icons/hicolor',
    '/usr/local/share/icons/hicolor',
];
// Not spec-compliant, but real: CachyOS drops its logo straight into
// /usr/share/icons, and several distributions use /usr/share/pixmaps.
const LOGO_FLAT_DIRS = [
    '/usr/share/pixmaps',
    '/usr/share/icons',
];
const LOGO_EXTS = ['.svg', '.png'];

function findLogoIn(dir, names) {
    for (const name of names) {
        for (const ext of LOGO_EXTS) {
            const path = GLib.build_filenamev([dir, `${name}${ext}`]);
            if (GLib.file_test(path, GLib.FileTest.EXISTS))
                return path;
        }
    }
    return null;
}

/** Scalable first, then the largest raster size the theme directory offers. */
function findLogoInHicolor(root, names) {
    let children;
    try {
        children = Gio.File.new_for_path(root).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch (_e) {
        return null;   // root absent on this system
    }

    let best = null;
    let bestPixels = -1;
    try {
        let info;
        while ((info = children.next_file(null)) !== null) {
            const size = info.get_name();
            const hit = findLogoIn(
                GLib.build_filenamev([root, size, 'apps']), names);
            if (!hit)
                continue;
            if (size === 'scalable')
                return hit;
            const pixels = Number.parseInt(size, 10);
            if (Number.isFinite(pixels) && pixels > bestPixels) {
                bestPixels = pixels;
                best = hit;
            }
        }
    } finally {
        children.close(null);
    }
    return best;
}

/**
 * The distributor's own logo as a file path.
 *
 * @returns {?string} path to the logo, or null when none is installed
 */
function distributorLogoPath() {
    const info = key => {
        try {
            return GLib.get_os_info(key);
        } catch (_e) {
            return null;
        }
    };

    const names = [];
    const logo = info('LOGO');
    if (logo) {
        names.push(logo);
    } else {
        // LOGO is optional. Best-effort guesses from the distribution id; a
        // miss just falls through to the themed fallback.
        const id = info('ID');
        if (id)
            names.push(`${id}-logo`, id);
    }
    if (!names.length)
        return null;

    for (const root of LOGO_HICOLOR_ROOTS) {
        const hit = findLogoInHicolor(root, names);
        if (hit)
            return hit;
    }
    for (const dir of LOGO_FLAT_DIRS) {
        const hit = findLogoIn(dir, names);
        if (hit)
            return hit;
    }
    return null;
}

/**
 * Paint a logo file as a flat silhouette in the panel's foreground colour.
 *
 * Distributor logos are full-colour artwork — CachyOS ships 74 shapes and
 * gradients — and next to a bar of monochrome glyphs a colour logo is the one
 * thing that does not belong. St only recolours icons a theme marks symbolic,
 * and no distribution ships a symbolic variant, so we collapse the artwork
 * ourselves: take its ALPHA as a Cairo mask and fill with the theme foreground.
 * Whatever the logo is made of, the result is one flat shape the colour of the
 * text beside it, and it follows light/dark and the adaptive contrast pass.
 *
 * @param {string} path logo file to silhouette
 * @returns {St.DrawingArea} the actor to mount
 */
function newLogoSilhouette(path) {
    const area = new St.DrawingArea({
        style_class: 'system-status-icon lintel-system-logo-silhouette',
        reactive: false,
    });

    area.connect('repaint', a => {
        const cr = a.get_context();
        try {
            const [width, height] = a.get_surface_size();
            if (!width || !height)
                return;
            // St.DrawingArea hands us DEVICE pixels, so rasterise the source at
            // the same scale to keep the silhouette's edge crisp.
            const scale =
                St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
            const surface = St.TextureCache.get_default()
                .load_file_to_cairo_surface(
                    Gio.File.new_for_path(path), scale, 1.0);
            if (!surface)
                return;
            const sw = surface.getWidth();
            const sh = surface.getHeight();
            if (!sw || !sh)
                return;

            const fit = Math.min(width / sw, height / sh);
            cr.save();
            cr.translate((width - sw * fit) / 2, (height - sh * fit) / 2);
            cr.scale(fit, fit);
            cr.setSourceColor(a.get_theme_node().get_foreground_color());
            cr.maskSurface(surface, 0, 0);
            cr.restore();
        } catch (e) {
            logError(e, 'lintel: painting distributor logo');
        } finally {
            cr.$dispose();
        }
    });

    return area;
}

export const LintelSystemMenu = GObject.registerClass(
class LintelSystemMenu extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, _('Lintel System Menu'), false);

        this._extension = extension;
        this._systemActions = SystemActions.getDefault();
        this._openStateId = 0;
        this._saNotifyIds = [];
        this._forceQuitItem = null;

        this.add_child(this._buildLogo());
        this._styleMenu();
        this._buildMenu();

        this._openStateId = this.menu.connect(
            'open-state-changed', (_menu, open) => {
                if (open)
                    this._onOpen();
            });
    }

    // ---- Logo ---------------------------------------------------------------

    _buildLogo() {
        const value = this._logoSetting();

        // An emoji / symbol glyph renders as text, not an icon.
        if (value && !this._isIconLike(value)) {
            return new St.Label({
                text: value,
                style_class: 'lintel-system-logo-glyph',
                y_align: Clutter.ActorAlign.CENTER,
            });
        }

        // No user choice: the distributor's own logo, silhouetted so it sits
        // in a monochrome bar. A logo the user picked by hand is shown as they
        // chose it.
        if (!value) {
            const distro = distributorLogoPath();
            if (distro)
                return newLogoSilhouette(distro);
        }

        // The logo reads slightly larger than a status glyph in the reference
        // bar, so it carries its own size class (see stylesheet.css).
        const icon = new St.Icon({
            style_class: 'system-status-icon lintel-system-logo-icon',
        });
        if (value && (value.startsWith('/') || value.startsWith('~') ||
                      value.startsWith('file:'))) {
            const path = value.startsWith('~')
                ? GLib.build_filenamev([GLib.get_home_dir(), value.slice(1)])
                : value;
            icon.gicon = Gio.icon_new_for_string(path);
        } else {
            icon.icon_name = value || FALLBACK_LOGO;
        }
        return icon;
    }

    // An icon-theme name or a file path (vs. an emoji/symbol glyph). Kept in
    // sync with prefs.js isIconLike().
    _isIconLike(v) {
        if (!v)
            return false;
        if (v.startsWith('/') || v.startsWith('~') || v.startsWith('file:'))
            return true;
        return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v);
    }

    _logoSetting() {
        // Defensive: settings only work if the schema is compiled/installed.
        try {
            const settings = this._extension?.getSettings?.();
            const v = settings?.get_string('system-menu-icon') ?? '';
            return v.length ? v : '';
        } catch (_e) {
            return '';
        }
    }

    // ---- Menu ---------------------------------------------------------------

    _styleMenu() {
        this.menu.actor.add_style_class_name('lintel-system-menu');
        this.menu.box.add_style_class_name('lintel-system-menu-content');

        // Tahoe's menu is a single continuous translucent material; the CSS
        // tint carries it alone. There is no backdrop blur: PopupMenu sits on a
        // BoxPointer, which sets OffscreenRedirect.ALWAYS, so a BACKGROUND-mode
        // Shell.BlurEffect has nothing behind it in that framebuffer to sample.
        // One used to be attached here and never did anything — docs/DESIGN_QA.md,
        // Pass 8.
    }

    _buildMenu() {
        // The visible labels and group boundaries follow the Tahoe system menu.
        // Actions still resolve to their GNOME equivalents.
        const aboutItem = this._addProgramItem(_('About This System'),
            'computer-symbolic',
            'gnome-control-center', ['system', 'about']);
        if (aboutItem) {
            const separator = new PopupMenu.PopupSeparatorMenuItem();
            separator.add_style_class_name(
                'lintel-system-menu-about-separator');
            this.menu.addMenuItem(separator);
        }
        this._addProgramItem(_('System Settings…'),
            'preferences-system-symbolic',
            'gnome-control-center');
        this._addUriItem(_('App Center…'),
            this._menuIcon('app-store', 'software-store-symbolic'),
            'appstream:///');

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // A submenu affordance is part of the original menu.  GNOME does not
        // expose macOS' application/document/server history model, so its first
        // entry opens the desktop's native Recent location.
        const recent = new PopupMenu.PopupSubMenuMenuItem(_('Recent Items'), true);
        recent.add_style_class_name('lintel-system-menu-item');
        recent.icon.icon_name = 'document-open-recent-symbolic';
        recent.label.x_expand = true;
        recent.menu.addMenuItem(this._createItem(
            _('Open Recent Items…'), 'folder-recent-symbolic', () => {
                this._launchUri('recent:///');
            }));
        this.menu.addMenuItem(recent);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Force Quit the focused window (sensitivity refreshed on open).
        this._forceQuitItem = this._addItem(_('Force Quit…'),
            'process-stop-symbolic',
            () => this._forceQuitFocused());

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Power / session — via GNOME's SystemActions.
        this._addActionItem(_('Sleep'), 'weather-clear-night-symbolic',
            'canSuspend', 'can-suspend',
            () => this._systemActions.activateSuspend());
        this._addActionItem(_('Restart…'), 'view-refresh-symbolic',
            'canRestart', 'can-restart',
            () => this._systemActions.activateRestart());
        this._addActionItem(_('Shut Down…'), 'system-shutdown-symbolic',
            'canPowerOff', 'can-power-off',
            () => this._systemActions.activatePowerOff());

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addActionItem(_('Lock Screen'), 'system-lock-screen-symbolic',
            'canLockScreen', 'can-lock-screen',
            () => this._systemActions.activateLockScreen());
        this._addActionItem(_('Log Out %s…').format(this._displayName()),
            'avatar-default-symbolic',
            'canLogout', 'can-logout',
            () => this._systemActions.activateLogout());
    }

    _menuIcon(name, fallback) {
        const file = this._extension?.dir
            ?.get_child('icons')
            ?.get_child('systemMenu')
            ?.get_child(`${name}-symbolic.svg`);
        if (file?.query_exists(null))
            return new Gio.FileIcon({file});
        return Gio.icon_new_for_string(fallback);
    }

    _addProgramItem(label, iconName, program, args = []) {
        if (!GLib.find_program_in_path(program))
            return;
        return this._addItem(label, iconName, () => {
            try {
                Util.spawn([program, ...args]);
            } catch (e) {
                logError(e, `LintelSystemMenu: failed to launch ${program}`);
            }
        });
    }

    _addUriItem(label, iconName, uri) {
        return this._addItem(label, iconName, () => this._launchUri(uri));
    }

    _launchUri(uri) {
        try {
            Gio.AppInfo.launch_default_for_uri(uri, null);
        } catch (e) {
            logError(e, `LintelSystemMenu: failed to open ${uri}`);
        }
    }

    _createItem(label, iconName, activate) {
        const item = new PopupMenu.PopupImageMenuItem(label, iconName, {
            style_class: 'lintel-system-menu-item',
        });
        item.label.x_expand = true;

        item.connect('activate', activate);
        return item;
    }

    _addItem(label, iconName, activate) {
        const item = this._createItem(label, iconName, activate);
        this.menu.addMenuItem(item);
        return item;
    }

    _addActionItem(label, iconName, canGetter, canProp, activate) {
        const item = this._addItem(label, iconName, () => {
            try {
                activate();
            } catch (e) {
                logError(e, `LintelSystemMenu: action failed (${label})`);
            }
        });
        const sa = this._systemActions;

        const sync = () => (item.sensitive = !!sa[canGetter]);
        sync();
        const id = sa.connect(`notify::${canProp}`, sync);
        this._saNotifyIds.push(id);
        return item;
    }

    _displayName() {
        const realName = GLib.get_real_name();
        if (realName && realName !== 'Unknown')
            return realName;
        return GLib.get_user_name();
    }

    _forceQuitFocused() {
        const win = global.display.get_focus_window();
        if (win)
            win.kill();
    }

    _onOpen() {
        if (!this._forceQuitItem)
            return;
        const win = global.display.get_focus_window();
        this._forceQuitItem.sensitive = win != null;
    }

    // ---- Teardown -----------------------------------------------------------

    destroy() {
        if (this._openStateId) {
            this.menu.disconnect(this._openStateId);
            this._openStateId = 0;
        }
        for (const id of this._saNotifyIds)
            this._systemActions.disconnect(id);
        this._saNotifyIds = [];
        this._forceQuitItem = null;
        this._extension = null;

        super.destroy();
    }
});
