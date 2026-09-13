// SPDX-License-Identifier: GPL-2.0-or-later
//
// Minimal MPRIS player bridge for the Control Center Now Playing card.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {_} from '../i18n.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const PLAYER_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PLAYER_XML = `
<node><interface name="${PLAYER_IFACE}">
  <method name="Previous"/>
  <method name="PlayPause"/>
  <method name="Next"/>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="Metadata" type="a{sv}" access="read"/>
</interface></node>`;

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PLAYER_XML);

export const MediaService = GObject.registerClass({
    Signals: {'changed': {}},
}, class MediaService extends GObject.Object {
    _init() {
        super._init();
        this._destroyed = false;
        this._proxy = null;
        this._proxyId = 0;
        this._playerName = '';
        this._watchId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _iface, _signal, parameters) => {
                const [name] = parameters.deep_unpack();
                if (name.startsWith(MPRIS_PREFIX))
                    this._discover();
            });
        this._discover();
    }

    _discover() {
        Gio.DBus.session.call(
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            'ListNames',
            null,
            new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (connection, result) => {
                if (this._destroyed)
                    return;
                try {
                    const [names] = connection.call_finish(result).deep_unpack();
                    const playerName = names.find(name =>
                        name.startsWith(MPRIS_PREFIX)) ?? '';
                    if (playerName === this._playerName)
                        return;
                    this._bind(playerName);
                } catch (e) {
                    logError(e, 'lintel: discover MPRIS player');
                }
            });
    }

    _bind(playerName) {
        if (this._proxyId && this._proxy)
            this._proxy.disconnect(this._proxyId);
        this._proxyId = 0;
        this._proxy = null;
        this._playerName = playerName;

        if (!playerName) {
            this.emit('changed');
            return;
        }

        new PlayerProxy(Gio.DBus.session, playerName, PLAYER_PATH,
            (proxy, error) => {
                if (this._destroyed || playerName !== this._playerName)
                    return;
                if (error) {
                    this._bind('');
                    return;
                }
                this._proxy = proxy;
                this._proxyId = proxy.connect(
                    'g-properties-changed', () => this.emit('changed'));
                this.emit('changed');
            });
    }

    get available() {
        return this._proxy != null;
    }

    get playing() {
        return this._proxy?.PlaybackStatus === 'Playing';
    }

    get title() {
        return _metadataValue(this._proxy?.Metadata, 'xesam:title') ||
            _('Not Playing');
    }

    get artist() {
        const value = _metadataValue(this._proxy?.Metadata, 'xesam:artist');
        return Array.isArray(value) ? value.join(', ') : value || '';
    }

    get artUrl() {
        return _metadataValue(this._proxy?.Metadata, 'mpris:artUrl') || '';
    }

    previous() {
        this._proxy?.PreviousRemote(_finishCall);
    }

    playPause() {
        this._proxy?.PlayPauseRemote(_finishCall);
    }

    next() {
        this._proxy?.NextRemote(_finishCall);
    }

    destroy() {
        this._destroyed = true;
        if (this._proxyId && this._proxy)
            this._proxy.disconnect(this._proxyId);
        if (this._watchId)
            Gio.DBus.session.signal_unsubscribe(this._watchId);
        this._proxyId = 0;
        this._watchId = 0;
        this._proxy = null;
        this._playerName = '';
    }
});

function _metadataValue(metadata, key) {
    let value = metadata?.[key];
    while (value instanceof GLib.Variant)
        value = value.deep_unpack();
    return value;
}

function _finishCall(_result, error) {
    if (error)
        logError(error, 'lintel: MPRIS command');
}
