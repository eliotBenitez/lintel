// SPDX-License-Identifier: GPL-2.0-or-later
//
// Reusable macOS-Control-Center controls. The popup deliberately uses a small
// set of actors with predictable geometry instead of GNOME Quick Settings
// widgets: their layout changes between Shell releases, while these controls
// need to keep the compact Tahoe composition on GNOME 50 and 51.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import {_} from '../i18n.js';

/** A horizontal network/focus capsule with a circular state icon. */
export const CCTile = GObject.registerClass(
class CCTile extends St.Button {
    _init(iconName, title, styleClass = '') {
        const classes = ['lintel-cc-tile', styleClass]
            .filter(Boolean).join(' ');
        super._init({
            style_class: classes,
            accessible_name: title,
            can_focus: true,
            x_expand: true,
            toggle_mode: true,
        });

        const box = new St.BoxLayout({
            style_class: 'lintel-cc-tile-box',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        this._icon = new St.Icon({
            icon_name: iconName,
            style_class: 'lintel-cc-tile-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        // macOS Tahoe: icon on the left, title/status left-aligned right beside
        // it (not centred in the capsule).
        const labels = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new St.Label({
            text: title,
            style_class: 'lintel-cc-tile-title',
            x_align: Clutter.ActorAlign.START,
        });
        this._status = new St.Label({
            style_class: 'lintel-cc-tile-status',
            x_align: Clutter.ActorAlign.START,
        });
        labels.add_child(this._title);
        labels.add_child(this._status);
        box.add_child(this._icon);
        box.add_child(labels);
        this.set_child(box);
    }

    setTitle(text) {
        this._title.text = text;
        this.accessible_name = text;
    }

    setActive(active, statusText = '') {
        this.checked = active;
        if (active)
            this._icon.add_style_pseudo_class('checked');
        else
            this._icon.remove_style_pseudo_class('checked');
        this._status.text = statusText;
    }

    setIcon(name) {
        this._icon.icon_name = name;
    }

    /**
     * Third-party Quick Settings tiles carry a GIcon (often a themed icon from
     * the extension's own directory), not an icon name, so take it as-is.
     */
    setGicon(gicon) {
        if (gicon)
            this._icon.gicon = gicon;
    }
});

/** A compact square Tahoe module used for icon-only actions and toggles. */
export const CCActionButton = GObject.registerClass(
class CCActionButton extends St.Button {
    _init(iconName, accessibleName, toggleMode = false, styleClass = '') {
        const classes = ['lintel-cc-action', styleClass]
            .filter(Boolean).join(' ');
        super._init({
            style_class: classes,
            accessible_name: accessibleName,
            can_focus: true,
            toggle_mode: toggleMode,
            x_expand: true,
        });

        this._icon = new St.Icon({
            icon_name: iconName,
            style_class: 'lintel-cc-action-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.set_child(this._icon);
    }

    setActive(active) {
        this.checked = active;
    }

    setIcon(name) {
        this._icon.icon_name = name;
    }
});

/** The large Now Playing module from the right side of Control Center. */
export const CCMediaCard = GObject.registerClass({
    Signals: {
        previous: {},
        'play-pause': {},
        next: {},
    },
},
class CCMediaCard extends St.BoxLayout {
    _init(styleClass = 'lintel-cc-media') {
        super._init({
            vertical: true,
            style_class: styleClass,
            accessible_name: _('Now Playing'),
            x_expand: true,
        });

        const header = new St.BoxLayout({
            style_class: 'lintel-cc-media-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._artwork = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'lintel-cc-media-artwork',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._artwork);

        const metadata = new St.BoxLayout({
            vertical: true,
            style_class: 'lintel-cc-media-metadata',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new St.Label({
            text: _('Not Playing'),
            style_class: 'lintel-cc-media-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        this._artist = new St.Label({
            style_class: 'lintel-cc-media-artist',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._artist.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        metadata.add_child(this._title);
        metadata.add_child(this._artist);
        header.add_child(metadata);
        this.add_child(header);

        const controls = new St.BoxLayout({
            style_class: 'lintel-cc-media-controls',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        const actions = [
            ['media-skip-backward-symbolic', _('Previous'), 'previous'],
            ['media-playback-start-symbolic', _('Play'), 'play-pause'],
            ['media-skip-forward-symbolic', _('Next'), 'next'],
        ];
        for (const [name, label, signal] of actions) {
            const icon = new St.Icon({
                icon_name: name,
                style_class: 'lintel-cc-media-control',
            });
            if (signal === 'play-pause')
                this._playIcon = icon;
            const button = new St.Button({
                style_class: signal === 'play-pause'
                    ? 'lintel-cc-media-button lintel-cc-media-play'
                    : 'lintel-cc-media-button',
                accessible_name: label,
                can_focus: true,
                x_expand: true,
                child: icon,
            });
            button.connect('clicked', () => this.emit(signal));
            controls.add_child(button);
        }
        this.add_child(controls);
    }

    setTrack(title, artist, artUrl, playing) {
        this._title.text = title || _('Not Playing');
        this._artist.text = artist || '';
        this._artist.visible = this._artist.text.length > 0;
        this._playIcon.icon_name = playing
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        if (artUrl) {
            try {
                this._artwork.gicon = new Gio.FileIcon({
                    file: Gio.File.new_for_uri(artUrl),
                });
                return;
            } catch (_e) {
                // Fall through to the neutral media glyph.
            }
        }
        this._artwork.gicon = null;
        this._artwork.icon_name = 'audio-x-generic-symbolic';
    }
});

/**
 * A labelled Tahoe slider card. The leading glyph can be a real button (volume
 * uses it for mute), while the optional trailing glyph is the maximum-value
 * indicator. Output selection is intentionally not faked without a backend.
 */
export const CCSlider = GObject.registerClass({
    Signals: {
        'moved': {param_types: [GObject.TYPE_DOUBLE]},
        'icon-clicked': {},
    },
}, class CCSlider extends St.BoxLayout {
    _init(title, iconName, trailingIconName = '', iconClickable = false) {
        super._init({
            vertical: true,
            style_class: 'lintel-cc-slider',
            accessible_name: title,
            x_expand: true,
        });

        this._block = false;
        this._iconClickable = iconClickable;
        this.add_child(new St.Label({
            text: title,
            style_class: 'lintel-cc-slider-title',
        }));

        const row = new St.BoxLayout({
            style_class: 'lintel-cc-slider-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._icon = new St.Icon({
            icon_name: iconName,
            style_class: 'lintel-cc-slider-icon',
        });
        this._iconButton = new St.Button({
            style_class: 'lintel-cc-slider-icon-button',
            accessible_name: iconClickable ? _('Toggle %s').format(title) : title,
            can_focus: iconClickable,
            reactive: iconClickable,
            child: this._icon,
        });
        this._iconButton.connect('clicked', () => this.emit('icon-clicked'));
        row.add_child(this._iconButton);

        this._slider = new Slider.Slider(0);
        this._slider.add_style_class_name('lintel-cc-track');
        this._slider.accessible_name = _('%s level').format(title);
        this._slider.x_expand = true;
        this._slider.connect('notify::value', () => {
            if (!this._block)
                this.emit('moved', this._slider.value);
        });
        row.add_child(this._slider);

        if (trailingIconName) {
            row.add_child(new St.Icon({
                icon_name: trailingIconName,
                style_class: 'lintel-cc-slider-trailing-icon',
            }));
        }
        this.add_child(row);
    }

    setValue(fraction) {
        this._block = true;
        this._slider.value = Math.max(0, Math.min(1, fraction));
        this._block = false;
    }

    setIcon(name) {
        this._icon.icon_name = name;
    }

    setAvailable(available) {
        this._slider.reactive = available;
        this._iconButton.reactive = available && this._iconClickable;
        this._iconButton.can_focus = available && this._iconClickable;
        this.opacity = available ? 255 : 150;
    }
});
