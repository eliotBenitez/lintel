// SPDX-License-Identifier: GPL-2.0-or-later
// Headless GNOME Shell smoke test for the clock replacement.

import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export var METRICS = {};

function notificationCenterRoot() {
    return Main.layoutManager.uiGroup.get_children().find(
        actor => actor.name === 'lintelNotificationCenterRoot') ?? null;
}

function findActor(root, predicate) {
    if (predicate(root))
        return root;
    for (const child of root.get_children()) {
        const match = findActor(child, predicate);
        if (match)
            return match;
    }
    return null;
}

function findActors(root, predicate, matches = []) {
    if (predicate(root))
        matches.push(root);
    for (const child of root.get_children())
        findActors(child, predicate, matches);
    return matches;
}

function assertCollapsedStackContentHidden(root) {
    const allMessages = findActors(root,
        actor => actor.has_style_class_name?.('message'));
    const allStacked = allMessages.filter(message =>
        message.has_style_pseudo_class('second-in-stack') ||
        message.has_style_pseudo_class('lower-in-stack'));
    if (allStacked.length < 2)
        throw new Error('Notification stack regression setup did not collapse');

    const group = allStacked[0].get_parent().get_parent();
    const messages = findActors(group,
        actor => actor.has_style_class_name?.('message'));
    const stacked = messages.filter(message =>
        message.has_style_pseudo_class('second-in-stack') ||
        message.has_style_pseudo_class('lower-in-stack'));
    if (stacked.length < 2)
        throw new Error('Notification stack regression group is incomplete');
    for (const message of stacked) {
        if (message.get_child()?.opacity !== 0) {
            throw new Error(
                'Collapsed notification content remains visible through the stack');
        }
    }
    const front = messages.find(message => !stacked.includes(message));
    if (!front?.has_style_class_name('lintel-nc-collapsed-stack-front'))
        throw new Error('Collapsed notification front card is not masking the stack');
    if (front.get_theme_node().get_background_color().alpha !== 255)
        throw new Error('Collapsed notification front card remains translucent');
    return group;
}

function assertExpandedStackContentVisible(group) {
    if (!group.expanded)
        throw new Error('Notification group did not expand');
    const messages = findActors(group,
        actor => actor.has_style_class_name?.('message'));
    if (messages.length < 3)
        throw new Error('Expanded notification group lost messages');
    if (messages.some(message => message.get_child()?.opacity === 0))
        throw new Error('Expanded notification content remained hidden');
    if (messages.some(message =>
        message.has_style_class_name('lintel-nc-collapsed-stack-front')))
        throw new Error('Expanded notification retained its collapsed mask');
}

function assertEditButtonKeepsItsHeight(root, stateName) {
    const button = findActor(root,
        actor => actor.has_style_class_name?.('lintel-nc-edit-button'));
    if (!button)
        throw new Error('Notification Center edit button is missing');
    if (!button.label)
        throw new Error(`Notification Center ${stateName} button has no label`);

    const [, naturalHeight] = button.get_preferred_height(-1);
    const themeNode = button.get_theme_node();
    const verticalMargin = themeNode.get_margin(St.Side.TOP) +
        themeNode.get_margin(St.Side.BOTTOM);
    const naturalActorHeight = naturalHeight - verticalMargin;
    if (button.height < naturalActorHeight)
        throw new Error(
            `Notification Center ${stateName} button was clipped to ` +
            `${button.height}px (natural actor height ${naturalActorHeight}px)`);
    return button;
}

function scrollToEditButton(root, button) {
    const scroll = findActor(root,
        actor => actor.has_style_class_name?.('lintel-nc-column-scroll'));
    if (!scroll)
        throw new Error('Notification Center column scroll view is missing');

    const adjustment = scroll.get_vadjustment();
    if (adjustment.upper <= adjustment.page_size)
        throw new Error('Notification Center regression setup did not overflow');
    adjustment.value = adjustment.upper - adjustment.page_size;
    const [, buttonY] = button.get_transformed_position();
    const [, scrollY] = scroll.get_transformed_position();
    if (buttonY + button.height > scrollY + scroll.height)
        throw new Error('Notification Center edit button cannot be scrolled into view');
}

export async function run() {
    let extension = null;
    for (let attempt = 0; attempt < 20; attempt++) {
        extension = Main.extensionManager.lookup('lintel@topbar');
        if (extension?.stateObj)
            break;
        await Scripting.sleep(200);
    }
    const settings = extension?.stateObj?.getSettings();
    if (!settings)
        throw new Error('Extension settings were not loaded');
    // Leave three entries in the editing gallery, matching the overflowing
    // layout that used to squash the Done button to a thin blue line.
    settings.set_strv('notification-center-widgets', [
        'calendar', 'weather', 'screentime', 'system', 'media',
    ]);
    settings.set_value('notification-center-widget-sizes',
        new GLib.Variant('a{ss}', {
            calendar: 'large',
            upnext: 'medium',
            weather: 'medium',
            screentime: 'small',
            system: 'medium',
            battery: 'small',
            media: 'medium',
            clock: 'small',
        }));
    await Scripting.sleep(200);

    const dateMenu = Main.panel.statusArea.dateMenu;
    if (!dateMenu)
        throw new Error('The native dateMenu is missing');

    const root = notificationCenterRoot();
    if (!root)
        throw new Error('Notification Center root was not installed');
    if (root.visible)
        throw new Error('Notification Center started visible');

    const source = new MessageTray.getSystemSource();
    const notifications = Array.from({length: 3}, (_, index) =>
        new MessageTray.Notification({
            source,
            title: `Lintel smoke test ${index + 1}`,
            body: 'Notification Center retains native notification actions.',
        }));
    for (const notification of notifications)
        source.addNotification(notification);
    await Scripting.sleep(200);

    Main.panel.toggleCalendar();
    await Scripting.sleep(300);
    if (!root.visible)
        throw new Error('toggleCalendar() did not open Notification Center');
    if (dateMenu.menu.isOpen)
        throw new Error('The native combined date menu opened as well');
    if (!Main.messageTray._bannerBlocked)
        throw new Error('Notification banners were not paused while open');
    const group = assertCollapsedStackContentHidden(root);
    group.emit('expand-toggle-requested');
    await Scripting.sleep(300);
    assertExpandedStackContentVisible(group);
    group.emit('expand-toggle-requested');
    await Scripting.sleep(300);
    assertCollapsedStackContentHidden(root);

    const editButton = assertEditButtonKeepsItsHeight(root, 'edit-widgets');
    const editLabel = editButton.label;
    editButton.emit('clicked', null);
    await Scripting.sleep(150);
    const doneButton = assertEditButtonKeepsItsHeight(root, 'done');
    if (doneButton.label === editLabel)
        throw new Error('Notification Center edit button did not enter Done state');
    scrollToEditButton(root, doneButton);

    Main.panel.closeCalendar();
    await Scripting.sleep(250);
    if (root.visible)
        throw new Error('closeCalendar() did not hide Notification Center');
    if (Main.messageTray._bannerBlocked)
        throw new Error('Notification banners were not restored after close');

    // PopupMenuManager does not call toggleCalendar() when the pointer moves
    // from an open panel menu onto the clock: it opens dateMenu.menu directly.
    // Reproduce that path and ensure it is redirected to our replacement too.
    const controlCenter = Main.panel.statusArea['lintel-control-center'];
    if (!controlCenter)
        throw new Error('The custom Control Center is missing');
    controlCenter.menu.open();
    await Scripting.sleep(150);
    if (!controlCenter.menu.isOpen)
        throw new Error('Control Center did not open for hover-switch test');

    dateMenu.menu.open();
    await Scripting.sleep(300);
    if (!root.visible)
        throw new Error('Direct date-menu open did not redirect to Notification Center');
    if (dateMenu.menu.isOpen)
        throw new Error('Native date menu remained open after direct redirect');
    if (controlCenter.menu.isOpen)
        throw new Error('Control Center remained open after switching to the clock');

    Main.panel.closeCalendar();
    await Scripting.sleep(250);
    if (root.visible)
        throw new Error('Notification Center stayed visible after hover-switch test');

    for (const notification of notifications)
        notification.destroy();
    await Scripting.sleep(150);

    Main.extensionManager.disableExtension('lintel@topbar');
    await Scripting.sleep(300);
    if (notificationCenterRoot())
        throw new Error('Notification Center chrome remained after disable');
    if (Main.messageTray._bannerBlocked)
        throw new Error('Notification banners remained blocked after disable');

    Main.panel.toggleCalendar();
    await Scripting.sleep(150);
    if (!dateMenu.menu.isOpen)
        throw new Error('The native date-menu handler was not restored');
    dateMenu.menu.close();

    Main.extensionManager.enableExtension('lintel@topbar');
    await Scripting.sleep(350);
    if (!notificationCenterRoot())
        throw new Error('Notification Center was not recreated after re-enable');

    // The first cycle above also verifies native restoration. Repeat the raw
    // lifecycle enough times to expose leaked chrome, callbacks or cached state.
    for (let cycle = 1; cycle < 20; cycle++) {
        Main.extensionManager.disableExtension('lintel@topbar');
        await Scripting.sleep(200);
        if (notificationCenterRoot())
            throw new Error(`Notification Center leaked after cycle ${cycle + 1}`);

        Main.extensionManager.enableExtension('lintel@topbar');
        await Scripting.sleep(250);
        if (!notificationCenterRoot())
            throw new Error(`Notification Center missing after cycle ${cycle + 1}`);
    }
    await Scripting.waitLeisure();
}

export function finish() {
}
