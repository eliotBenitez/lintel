// Version detection + per-version quirks. PanelAdapter targets GNOME 50; when a
// GNOME 51/52 divergence appears, branch on shellMajorVersion() here and keep
// callers untouched.

import Config from 'resource:///org/gnome/shell/misc/config.js';

/** Major GNOME Shell version as an integer (e.g. 50), or 0 if unknown. */
export function shellMajorVersion() {
    const raw = Config.PACKAGE_VERSION ?? '';
    const major = parseInt(raw.split('.')[0], 10);
    return Number.isFinite(major) ? major : 0;
}

export function isAtLeast(major) {
    return shellMajorVersion() >= major;
}
