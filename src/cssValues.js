// SPDX-License-Identifier: GPL-2.0-or-later
//
// Validation for the free-text settings that ThemeManager writes into the
// dynamic stylesheet. That sheet is loaded into the whole Shell theme, so a
// value that closes a declaration or a block (`"`, `;`, `}`) would inject rules
// for any Shell actor. Anything outside the accepted shapes is rejected, not
// escaped. Free of Shell imports so prefs.js can flag invalid input too.

const FONT_WEIGHT_KEYWORDS = new Set(['normal', 'bold', 'bolder', 'lighter']);

/** One Pango family name, or '' when the value is empty or unsafe. */
export function sanitizeFontFamily(value) {
    const family = String(value ?? '').trim();
    return /^[\p{L}\p{N} ._'-]{1,64}$/u.test(family) ? family : '';
}

/** A CSS font-weight keyword or 100..900, or '' when empty or unsafe. */
export function sanitizeFontWeight(value) {
    const weight = String(value ?? '').trim().toLowerCase();
    if (FONT_WEIGHT_KEYWORDS.has(weight))
        return weight;
    return /^[1-9]00$/.test(weight) ? weight : '';
}
