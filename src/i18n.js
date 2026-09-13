// SPDX-License-Identifier: GPL-2.0-or-later
//
// Translation helpers shared by the Shell process and the preferences process.
// GNOME binds this domain to the extension's locale/ directory from the
// `gettext-domain` entry in metadata.json before loading either entry point.

import Gettext from 'gettext';

export const GETTEXT_DOMAIN = 'lintel@topbar';

export function gettext(message) {
    return Gettext.dgettext(GETTEXT_DOMAIN, message);
}

export function ngettext(singular, plural, count) {
    return Gettext.dngettext(GETTEXT_DOMAIN, singular, plural, count);
}

export function pgettext(context, message) {
    return Gettext.dpgettext(GETTEXT_DOMAIN, context, message);
}

export {gettext as _};
