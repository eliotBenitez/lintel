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
        this._control = new Gvc.MixerControl({name: 'Lintel'});
        this._stateId = this._control.connect(
            'state-changed', () => this._onState());
        this._defaultId = this._control.connect(
            'default-sink-changed', () => this._bindSink());
        this._control.open();
    }

    _onState() {
        if (this._control.get_state() === Gvc.MixerControlState.READY)
            this._bindSink();
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
        if (this._stateId)
            this._control.disconnect(this._stateId);
        if (this._defaultId)
            this._control.disconnect(this._defaultId);
        try {
            this._control.close();
        } catch (_e) {
            // ignore
        }
        this._control = null;
    }
});
