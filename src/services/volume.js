// SPDX-License-Identifier: GPL-2.0-or-later
//
// VolumeService — output volume via Gvc (libgvc), the same mixer GNOME's own
// volume control uses. Gvc's typelib is only on the search path inside the Shell
// process, so this cannot be exercised standalone; it is guarded throughout.

import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';

export const VolumeService = GObject.registerClass({
    Signals: {'changed': {}},
}, class VolumeService extends GObject.Object {
    _init() {
        super._init();
        this._sink = null;
        this._sinkIds = [];
        this._source = null;
        this._sourceIds = [];
        this._control = new Gvc.MixerControl({name: 'Lintel'});
        this._stateId = this._control.connect(
            'state-changed', () => this._onState());
        this._defaultId = this._control.connect(
            'default-sink-changed', () => this._bindSink());
        this._defaultSourceId = this._control.connect(
            'default-source-changed', () => this._bindSource());
        this._control.open();
    }

    _onState() {
        if (this._control.get_state() === Gvc.MixerControlState.READY) {
            this._bindSink();
            this._bindSource();
        }
    }

    // ---- Input (microphone) -------------------------------------------------

    _bindSource() {
        this._unbindSource();
        this._source = this._control.get_default_source();
        if (this._source) {
            for (const property of ['volume', 'is-muted']) {
                this._sourceIds.push(this._source.connect(`notify::${property}`,
                    () => this.emit('changed')));
            }
        }
        this.emit('changed');
    }

    _unbindSource() {
        if (this._source) {
            for (const id of this._sourceIds)
                this._source.disconnect(id);
        }
        this._sourceIds = [];
        this._source = null;
    }

    get inputAvailable() {
        return this._source != null;
    }

    get inputLevel() {
        if (!this._source)
            return 0;
        const max = this._control.get_vol_max_norm();
        return max > 0 ? this._source.volume / max : 0;
    }

    setInputLevel(fraction) {
        if (!this._source)
            return;
        const max = this._control.get_vol_max_norm();
        this._source.volume = Math.round(Math.max(0, Math.min(1, fraction)) * max);
        this._source.push_volume();
    }

    toggleInputMute() {
        if (this._source)
            this._source.change_is_muted(!this._source.is_muted);
    }

    get inputIconName() {
        const level = this.inputLevel;
        if (!this._source || this._source.is_muted || level <= 0.01)
            return 'microphone-sensitivity-muted-symbolic';
        if (level < 0.34)
            return 'microphone-sensitivity-low-symbolic';
        if (level < 0.67)
            return 'microphone-sensitivity-medium-symbolic';
        return 'microphone-sensitivity-high-symbolic';
    }

    _bindSink() {
        this._unbindSink();
        this._sink = this._control.get_default_sink();
        if (this._sink) {
            this._sinkIds.push(this._sink.connect(
                'notify::volume', () => this.emit('changed')));
            this._sinkIds.push(this._sink.connect(
                'notify::is-muted', () => this.emit('changed')));
        }
        this.emit('changed');
    }

    _unbindSink() {
        if (this._sink) {
            for (const id of this._sinkIds)
                this._sink.disconnect(id);
        }
        this._sinkIds = [];
        this._sink = null;
    }

    get available() {
        return this._sink != null;
    }

    get muted() {
        return this._sink?.is_muted ?? false;
    }

    get level() {
        if (!this._sink)
            return 0;
        const max = this._control.get_vol_max_norm();
        return max > 0 ? this._sink.volume / max : 0;
    }

    setLevel(fraction) {
        if (!this._sink)
            return;
        const max = this._control.get_vol_max_norm();
        const clamped = Math.max(0, Math.min(1, fraction));
        this._sink.volume = Math.round(clamped * max);
        this._sink.push_volume();
    }

    toggleMute() {
        if (this._sink)
            this._sink.change_is_muted(!this._sink.is_muted);
    }

    get iconName() {
        if (!this._sink || this._sink.is_muted)
            return 'audio-volume-muted-symbolic';
        const l = this.level;
        if (l <= 0.01)
            return 'audio-volume-muted-symbolic';
        if (l < 0.34)
            return 'audio-volume-low-symbolic';
        if (l < 0.67)
            return 'audio-volume-medium-symbolic';
        return 'audio-volume-high-symbolic';
    }

    destroy() {
        this._unbindSink();
        this._unbindSource();
        if (this._stateId)
            this._control.disconnect(this._stateId);
        if (this._defaultId)
            this._control.disconnect(this._defaultId);
        if (this._defaultSourceId)
            this._control.disconnect(this._defaultSourceId);
        try {
            this._control.close();
        } catch (_e) {
            // ignore
        }
        this._control = null;
    }
});
