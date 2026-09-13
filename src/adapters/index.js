// SPDX-License-Identifier: GPL-2.0-or-later
//
// The adapter registry. Each entry teaches the Control Center how to present
// and drive one third-party extension through its own public settings contract,
// so the capsule carries our icon and wording instead of whatever its Quick
// Settings tile happens to look like — and keeps working when that tile is
// switched off. Adding one is data, not code: see adapters/README.md.
//
// Extensions with no adapter are still mirrored generically by
// services/quickSettingsBridge.js; an adapter simply takes precedence.

import {CaffeineAdapter} from './caffeine.js';

export const EXTENSION_ADAPTERS = Object.freeze([
    CaffeineAdapter,
]);
