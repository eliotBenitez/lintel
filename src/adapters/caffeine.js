// SPDX-License-Identifier: GPL-2.0-or-later
//
// Caffeine (caffeine@patapon.info) — https://github.com/eonpatapon/gnome-shell-extension-caffeine
//
// A declarative descriptor, not an integration: we never import Caffeine's
// modules and never touch its `stateObj`. The whole contract is one GSettings
// key, and it is the one its author added for exactly this purpose.
//
// Verified against Caffeine v60 (extension.js):
//   • `_inhibitorUpdated()` mirrors the live inhibit state into `cli-toggle` on
//     every change, so the key is a faithful *read* of the current state —
//     better than `user-enabled`, which only records the user's own toggle and
//     is written before the inhibitor has settled.
//   • `_commandStateChanged()` compares `cli-toggle` against its state and
//     toggles when they differ, so a *write* is a level-set ("be this"), not a
//     pulse. That is the documented `gsettings set … cli-toggle true` channel.
//
// Its Quick Settings tile IS translated ("Кофеин", "Koffein", "カフェイン" …),
// so `titleMsgid` is resolved through Caffeine's own gettext domain to
// recognise that tile in any locale — see services/extensionAdapters.js.

import {_} from '../i18n.js';

const STATE_KEY = 'cli-toggle';

export const CaffeineAdapter = {
    id: 'caffeine',
    uuid: 'caffeine@patapon.info',
    schemaId: 'org.gnome.shell.extensions.caffeine',

    // What we display: the brand name, the way macOS labels a Control Center
    // module, independent of how the extension localises its own tile.
    title: 'Caffeine',

    // How we recognise the tile this adapter supersedes.
    gettextDomain: 'gnome-shell-extension-caffeine',
    titleMsgid: 'Caffeine',

    // Shipped in the extension's own icons/ directory, which GNOME adds to the
    // icon theme search path; fallback covers a partial install.
    iconNames: {on: 'my-caffeine-on-symbolic', off: 'my-caffeine-off-symbolic'},
    fallbackIconName: 'user-idle-symbolic',

    watchKeys: [STATE_KEY],

    read(settings) {
        return settings.get_boolean(STATE_KEY);
    },

    write(settings, active) {
        settings.set_boolean(STATE_KEY, active);
    },

    subtitle(active) {
        return active ? _('On') : _('Off');
    },
};
