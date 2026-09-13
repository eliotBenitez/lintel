# widgets/

Visual building blocks that PanelController mounts into the native panel boxes
(later stages — not wired in the skeleton). Each is a `PanelMenu.Button` subclass
or a plain `St.Widget`, added via the compat layer so third-party status items
and GNOME's own indicators keep working.

| File | Stage | Purpose |
|------|-------|---------|
| `systemMenu.js`    | 3 | Apple-menu analogue (logo → About / Settings / Sleep / Lock / Log Out). Logo is user-configurable, never a bundled Apple asset. |
| `activeApp.js`     | 4 | Bold name of the focused application, tracked via `global.display.focus_window` with debounce. |
| `controlCenter.js` | 6 ✅ | Independent Control Center glyph with a custom Liquid Glass Tahoe popup and native Quick Settings compatibility mode. Mirrors third-party Quick Settings toggles as capsules via `services/quickSettingsBridge.js`. |
| `wifiMenu.js`      | 11 ✅ | Standalone Wi-Fi glyph and popup: radio switch, live access points, active-network checkmark and connect/disconnect actions. |
| `batteryMenu.js`   | 11 ✅ | Standalone battery glyph/percentage and popup: charge details, power source and power-profile selection. |
| `statusMenu.js`    | 11 ✅ | Shared Tahoe popup presentation for the independent status menus. |
| `notificationCenter.js` | 0.16 ✅ | Tahoe Notification Center opened from the clock: a free-floating card column over GNOME's own `MessageView`, plus the widget area and its in-place editing. |
| `ncWidgets.js`     | 0.16 ✅ | Notification Center widgets per Tahoe size (small square / medium / large): calendar, Up Next, weather, Screen Time, System, battery ring, analogue clock, Now Playing. |
| `clock.js`         | 7 ✅ | Hides `dateMenu._clockDisplay` and drives our own label in the same box with a Tahoe-accurate format: locale-ordered date, tabular figures, and macOS's Clock Options (date when-space-allows/always/never, weekday, AM/PM, seconds; system 12h/24h). Native calendar + notifications untouched; fully reversed on disable. |
| `statusArea.js`    | 2 | Helpers for keeping external/privacy/input indicators visible and ordered on the right. |

Contract every widget must honour: constructed lazily, destroyed fully on
`disable()`, and never assume it owns the panel box it lives in.
