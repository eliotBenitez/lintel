// SPDX-License-Identifier: GPL-2.0-or-later
// Capture reproducible GitHub screenshots in gnome-shell-test-tool.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

const OUTPUT_DIR = GLib.getenv('LINTEL_SCREENSHOT_DIR');

async function capture(filename) {
    await Scripting.waitLeisure();
    await Scripting.sleep(350);

    const file = Gio.File.new_for_path(GLib.build_filenamev([
        OUTPUT_DIR,
        filename,
    ]));
    const stream = file.replace(
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    const screenshot = new Shell.Screenshot();

    try {
        await screenshot.screenshot(false, stream);
    } finally {
        stream.close(null);
    }
}

async function waitForExtension() {
    for (let attempt = 0; attempt < 30; attempt++) {
        const extension = Main.extensionManager.lookup('lintel@topbar');
        if (extension?.stateObj)
            return extension;
        await Scripting.sleep(100);
    }
    throw new Error('Lintel did not load in the screenshot session');
}

async function waitForWindow(title) {
    for (let attempt = 0; attempt < 60; attempt++) {
        const actor = global.get_window_actors().find(windowActor =>
            windowActor.meta_window?.get_title()?.includes(title));
        if (actor)
            return actor.meta_window;
        await Scripting.sleep(100);
    }
    const titles = global.get_window_actors().map(
        actor => actor.meta_window?.get_title() ?? '<untitled>');
    throw new Error(`Window did not appear: ${title}; visible windows: ${titles.join(', ')}`);
}

function configureBackground() {
    const background = new Gio.Settings({
        schema_id: 'org.gnome.desktop.background',
    });
    background.set_string('picture-uri', '');
    background.set_string('picture-uri-dark', '');
    background.set_string('color-shading-type', 'solid');
    background.set_string('primary-color', '#0b3c88');
    background.set_string('secondary-color', '#0b3c88');
}

function updateActivationEnvironment() {
    const environment = {
        GDK_BACKEND: 'wayland',
        NO_AT_BRIDGE: '1',
        GTK_A11Y: 'none',
        WAYLAND_DISPLAY: 'gnome-shell-test-display',
    };
    for (const key of ['DISPLAY', 'XDG_RUNTIME_DIR']) {
        const value = GLib.getenv(key);
        if (value)
            environment[key] = value;
    }
    Gio.DBus.session.call_sync(
        'org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus',
        'UpdateActivationEnvironment',
        new GLib.Variant('(a{ss})', [environment]),
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null);
}

export async function run() {
    if (!OUTPUT_DIR)
        throw new Error('LINTEL_SCREENSHOT_DIR is required');
    GLib.mkdir_with_parents(OUTPUT_DIR, 0o755);

    const extension = await waitForExtension();
    const settings = extension.stateObj.getSettings();
    settings.set_enum('text-mode', 1);
    settings.set_strv('notification-center-widgets', ['calendar']);

    configureBackground();
    Main.overview.hide();
    await Scripting.sleep(900);
    await capture('01-desktop.png');

    const controlCenter = Main.panel.statusArea['lintel-control-center'];
    if (!controlCenter)
        throw new Error('Lintel Control Center is missing');
    controlCenter.menu.open();
    await Scripting.sleep(450);
    await capture('02-control-center.png');
    controlCenter.menu.close();

    Main.panel.toggleCalendar();
    await Scripting.sleep(250);
    const source = new MessageTray.getSystemSource();
    const notifications = [
        new MessageTray.Notification({
            source,
            title: 'Native notifications',
            body: 'Grouping, actions and dismissal stay managed by GNOME.',
        }),
        new MessageTray.Notification({
            source,
            title: 'Lintel is reversible',
            body: 'Disabling the extension restores the stock panel.',
        }),
    ];
    for (const notification of notifications)
        source.addNotification(notification);
    await Scripting.sleep(500);
    await capture('03-notification-center.png');

    Main.panel.closeCalendar();
    for (const notification of notifications)
        notification.destroy();

    updateActivationEnvironment();
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.NONE,
    });
    launcher.spawnv([
        '/usr/bin/gnome-extensions',
        'prefs',
        'lintel@topbar',
    ]);
    const preferences = await waitForWindow('Lintel');
    if (preferences.allows_resize())
        preferences.move_resize_frame(false, 190, 50, 900, 620);
    preferences.raise();
    await Scripting.sleep(600);
    await capture('04-preferences.png');
    preferences.delete(global.get_current_time());

}

export function finish() {
}
