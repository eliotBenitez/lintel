// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared presentation for the independent Tahoe-style status menus.  These
// menus deliberately reuse the compact system-menu metrics, while keeping a
// separate class for status-specific rows and widths.

// No backdrop blur here: PopupMenu sits on a BoxPointer, which sets
// OffscreenRedirect.ALWAYS, so a BACKGROUND-mode Shell.BlurEffect has nothing
// behind it in that framebuffer to sample. This file used to attach one; it
// never did anything. See docs/DESIGN_QA.md, Pass 8.

export function styleStatusMenu(menu, contentClass = '') {
    menu.actor.add_style_class_name('lintel-system-menu');
    menu.actor.add_style_class_name('lintel-status-menu');
    menu.box.add_style_class_name('lintel-system-menu-content');
    menu.box.add_style_class_name('lintel-status-menu-content');
    if (contentClass)
        menu.box.add_style_class_name(contentClass);
}
