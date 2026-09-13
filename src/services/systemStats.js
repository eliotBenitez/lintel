// SPDX-License-Identifier: GPL-2.0-or-later
//
// SystemStatsService — processor, memory, storage, temperature and network
// figures for the System widget, read straight from the kernel.
//
// /proc and /sys are the whole back end: no libgtop dependency, nothing a
// minimal install lacks. Those files are generated from kernel memory and never
// wait on a disk, so they are read synchronously on the main loop; the one real
// filesystem query (space in the home directory) is asynchronous.
//
// Sampling runs only while at least one System widget is on screen, that is,
// while Notification Center is open, so a closed column costs nothing. One
// store serves every System widget and is dropped with the last one, like the
// weather store.
//
// Everything above SystemStatsStore is free of Shell imports and exported, so
// it can be checked from plain gjs against the live /proc.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

export const SAMPLE_INTERVAL_MS = 2000;
export const HISTORY_LENGTH = 60;
const FIRST_SAMPLE_DELAY_MS = 500;
const STORAGE_REFRESH_US = 30 * GLib.USEC_PER_SEC;
const KIB = 1024;

// CPU temperature sensors in order of preference: hwmon driver name, and the
// channel labels that carry the package or die temperature (null: channel 1).
const CPU_SENSORS = [
    ['k10temp', ['Tdie', 'Tctl']],
    ['zenpower', ['Tdie', 'Tctl']],
    ['coretemp', ['Package id 0']],
    ['cpu_thermal', null],
    ['soc_thermal', null],
    ['acpitz', null],
];
const MAX_SENSOR_CHANNELS = 16;

function _read(path) {
    const [, bytes] = GLib.file_get_contents(path);
    return new TextDecoder().decode(bytes);
}

function _exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

/** Aggregate CPU time from /proc/stat, as {busy, total} jiffies. */
export function parseCpuTimes(text) {
    const line = text.split('\n').find(candidate => candidate.startsWith('cpu '));
    if (!line)
        throw new Error('No aggregate cpu line in /proc/stat');
    // user nice system idle iowait irq softirq steal. Guest time is already
    // part of user and nice, so the trailing guest columns are not added.
    const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] =
        line.trim().split(/\s+/).slice(1).map(Number);
    const idleAll = idle + iowait;
    const total = user + nice + system + idleAll + irq + softirq + steal;
    return {busy: total - idleAll, total};
}

/** {total, available} in bytes from /proc/meminfo. */
export function parseMeminfo(text) {
    const values = {};
    for (const line of text.split('\n')) {
        const match = /^(\w+):\s+(\d+)\s+kB/.exec(line);
        if (match)
            values[match[1]] = Number(match[2]) * KIB;
    }
    if (!values.MemTotal || values.MemAvailable === undefined)
        throw new Error('MemTotal or MemAvailable missing from /proc/meminfo');
    return {total: values.MemTotal, available: values.MemAvailable};
}

/** Received and sent byte counters, summed over the interfaces `include` accepts. */
export function parseNetDev(text, include) {
    let rx = 0;
    let tx = 0;
    for (const line of text.split('\n').slice(2)) {
        const colon = line.indexOf(':');
        if (colon < 0)
            continue;
        if (!include(line.slice(0, colon).trim()))
            continue;
        const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
        rx += fields[0];
        tx += fields[8];
    }
    return {rx, tx};
}

/**
 * Only interfaces backed by hardware count. A VPN tunnel, a bridge or a
 * container's veth carries traffic that also crosses the physical link, so
 * adding them would count the same bytes twice.
 */
export function isPhysicalInterface(name) {
    return _exists(`/sys/class/net/${name}/device`);
}

/** Path of the CPU temperature input in millidegrees Celsius, or null. */
export function findCpuTemperatureInput() {
    const drivers = new Map();
    try {
        const enumerator = Gio.File.new_for_path('/sys/class/hwmon')
            .enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null))) {
            const path = `/sys/class/hwmon/${info.get_name()}`;
            try {
                const driver = _read(`${path}/name`).trim();
                if (!drivers.has(driver))
                    drivers.set(driver, path);
            } catch (_e) {
                // A device without a name file is not a sensor we know.
            }
        }
        enumerator.close(null);
    } catch (_e) {
        return null;
    }

    for (const [driver, labels] of CPU_SENSORS) {
        const path = drivers.get(driver);
        if (!path)
            continue;
        for (const wanted of labels ?? []) {
            for (let channel = 1; channel <= MAX_SENSOR_CHANNELS; channel++) {
                const label = `${path}/temp${channel}_label`;
                if (_exists(label) && _read(label).trim() === wanted)
                    return `${path}/temp${channel}_input`;
            }
        }
        if (_exists(`${path}/temp1_input`))
            return `${path}/temp1_input`;
    }
    return null;
}

function _push(history, value) {
    history.push(value);
    if (history.length > HISTORY_LENGTH)
        history.splice(0, history.length - HISTORY_LENGTH);
}

const SystemStatsStore = GObject.registerClass({
    Signals: {'changed': {}},
}, class SystemStatsStore extends GObject.Object {
    _init() {
        super._init();
        this._active = new Set();
        this._timerId = 0;
        this._lastSampleAt = 0;
        this._interfaces = new Map();
        this._temperatureInput = undefined;
        this._storageCancellable = null;
        this._storageAt = 0;
        this.memory = null;
        this.storage = null;
        this.temperature = null;
        this._clearHistory();
    }

    _clearHistory() {
        this._cpuTimes = null;
        this._netCounters = null;
        this.cpu = null;
        this.network = null;
        this.cpuHistory = [];
        this.rxHistory = [];
        this.txHistory = [];
    }

    setActive(consumer, active) {
        if (active)
            this._active.add(consumer);
        else
            this._active.delete(consumer);

        if (this._active.size && !this._timerId)
            this._start();
        else if (!this._active.size && this._timerId)
            this._stop();
    }

    _start() {
        // A pause in sampling would draw as a flat stretch that never happened.
        const pause = GLib.get_monotonic_time() - this._lastSampleAt;
        if (pause > 3 * SAMPLE_INTERVAL_MS * 1000)
            this._clearHistory();

        this._sample();
        // Rates need two samples: take the second one soon, then settle.
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            FIRST_SAMPLE_DELAY_MS, () => {
                this._sample();
                this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                    SAMPLE_INTERVAL_MS, () => {
                        this._sample();
                        return GLib.SOURCE_CONTINUE;
                    });
                return GLib.SOURCE_REMOVE;
            });
    }

    _stop() {
        if (this._timerId)
            GLib.Source.remove(this._timerId);
        this._timerId = 0;
        this._storageCancellable?.cancel();
        this._storageCancellable = null;
    }

    _isPhysical(name) {
        if (!this._interfaces.has(name))
            this._interfaces.set(name, isPhysicalInterface(name));
        return this._interfaces.get(name);
    }

    _sample() {
        const now = GLib.get_monotonic_time();
        this._lastSampleAt = now;

        try {
            const times = parseCpuTimes(_read('/proc/stat'));
            const previous = this._cpuTimes;
            this._cpuTimes = times;
            if (previous && times.total > previous.total) {
                this.cpu = Math.min(1, Math.max(0,
                    (times.busy - previous.busy) / (times.total - previous.total)));
                _push(this.cpuHistory, this.cpu);
            }
        } catch (e) {
            console.warn(`lintel: reading CPU time: ${e.message}`);
            this.cpu = null;
        }

        try {
            const {total, available} = parseMeminfo(_read('/proc/meminfo'));
            this.memory = {used: total - available, total};
        } catch (e) {
            console.warn(`lintel: reading memory: ${e.message}`);
            this.memory = null;
        }

        try {
            const counters = parseNetDev(_read('/proc/net/dev'),
                name => this._isPhysical(name));
            const previous = this._netCounters;
            this._netCounters = {...counters, at: now};
            if (previous && now > previous.at) {
                const seconds = (now - previous.at) / GLib.USEC_PER_SEC;
                // Counters shrink when an interface disappears; never go negative.
                this.network = {
                    rx: Math.max(0, counters.rx - previous.rx) / seconds,
                    tx: Math.max(0, counters.tx - previous.tx) / seconds,
                };
                _push(this.rxHistory, this.network.rx);
                _push(this.txHistory, this.network.tx);
            }
        } catch (e) {
            console.warn(`lintel: reading network counters: ${e.message}`);
            this.network = null;
        }

        if (this._temperatureInput === undefined)
            this._temperatureInput = findCpuTemperatureInput();
        try {
            this.temperature = this._temperatureInput
                ? Number(_read(this._temperatureInput)) / 1000
                : null;
        } catch (_e) {
            this.temperature = null;
        }

        if (now - this._storageAt > STORAGE_REFRESH_US)
            this._refreshStorage();
        this.emit('changed');
    }

    _refreshStorage() {
        if (this._storageCancellable)
            return;
        const cancellable = new Gio.Cancellable();
        this._storageCancellable = cancellable;
        this._storageAt = GLib.get_monotonic_time();

        Gio.File.new_for_path(GLib.get_home_dir()).query_filesystem_info_async(
            'filesystem::size,filesystem::free', GLib.PRIORITY_DEFAULT, cancellable,
            (file, result) => {
                if (cancellable.is_cancelled())
                    return;
                this._storageCancellable = null;
                try {
                    const info = file.query_filesystem_info_finish(result);
                    const total = info.get_attribute_uint64('filesystem::size');
                    const free = info.get_attribute_uint64('filesystem::free');
                    this.storage = total > 0 ? {used: total - free, total} : null;
                } catch (e) {
                    console.warn(`lintel: reading storage: ${e.message}`);
                    this.storage = null;
                }
                this.emit('changed');
            });
    }

    destroy() {
        this._active.clear();
        this._stop();
        this._interfaces.clear();
    }
});

let _store = null;
let _storeUsers = 0;

export const SystemStatsService = GObject.registerClass({
    Signals: {'changed': {}},
}, class SystemStatsService extends GObject.Object {
    _init() {
        super._init();
        if (!_store)
            _store = new SystemStatsStore();
        _storeUsers++;
        this._store = _store;
        this._storeId = this._store.connect('changed', () => this.emit('changed'));
    }

    /** Busy fraction of all CPUs, 0..1, or null before two samples. */
    get cpu() {
        return this._store?.cpu ?? null;
    }

    /** {used, total} bytes, or null. */
    get memory() {
        return this._store?.memory ?? null;
    }

    /** {used, total} bytes of the filesystem holding the home directory, or null. */
    get storage() {
        return this._store?.storage ?? null;
    }

    /** CPU temperature in degrees Celsius, or null without a known sensor. */
    get temperature() {
        return this._store?.temperature ?? null;
    }

    /** {rx, tx} bytes per second over physical interfaces, or null. */
    get network() {
        return this._store?.network ?? null;
    }

    get cpuHistory() {
        return this._store?.cpuHistory ?? [];
    }

    get rxHistory() {
        return this._store?.rxHistory ?? [];
    }

    get txHistory() {
        return this._store?.txHistory ?? [];
    }

    /** Sample while `active`; the store samples while any consumer is active. */
    setActive(active) {
        this._store?.setActive(this, active);
    }

    destroy() {
        if (!this._store)
            return;
        this._store.setActive(this, false);
        this._store.disconnect(this._storeId);
        this._storeId = 0;
        this._store = null;
        _storeUsers--;
        if (_storeUsers <= 0) {
            _storeUsers = 0;
            _store?.destroy();
            _store = null;
        }
    }
});
