# services/

Non-visual trackers shared by widgets (later stages — not wired in the skeleton).
Each owns its GNOME signal connections and disconnects them fully on `destroy()`.

| File | Stage | Purpose |
|------|-------|---------|
| `windowTracker.js` | 4 ✅ | Watches `Shell.WindowTracker`'s `focus-app`; emits a debounced `app-changed` so the panel isn't rebuilt on every Alt+Tab step. `focus-app` goes null when the focused app closes, which clears the name (Criterion #16). Window→app resolution is built in, so a separate `appTracker.js` wasn't needed. |
| ~~`themeTracker.js`~~ | 8 ✅ | Superseded — light/dark tracking is handled inside `src/theme.js` (`ThemeManager`), which also watches it to regenerate the dynamic stylesheet. |
| `volume.js` | CC ✅ | Output volume/mute via `Gvc.MixerControl`. |
| `brightness.js` | CC ✅ | Screen backlight via `org.gnome.SettingsDaemon.Power.Screen` (optional). |
| `connectivity.js` | CC ✅ | Lightweight Wi-Fi switch for Control Center + Bluetooth/Airplane (GNOME `Rfkill`). |
| `wifi.js` | Status ✅ | libnm Wi-Fi devices/access points, signal/security state, scanning and activation. |
| `battery.js` | Status ✅ | UPower DisplayDevice — percentage, state, icon, power source and charge time. |
| `powerProfiles.js` | Status ✅ | Optional power-profiles-daemon integration for the battery popup. |
| `media.js` | CC ✅ | MPRIS metadata, artwork and playback controls for Now Playing. |
| `weather.js`, `weatherProviders.js`, `geolocation.js` | NC ✅ | Weather widget: keyless Open-Meteo / wttr.in forecasts for a chosen city or the GeoClue position. |
| `upNext.js`, `agenda.js` | NC ✅ | Up Next widget: the coming week of events from the Shell's calendar server (`compat/calendarEvents.js`), grouped by day. `agenda.js` is Shell-free. |
| `systemStats.js` | NC ✅ | System widget: CPU load, memory, home-filesystem usage, CPU temperature (hwmon) and physical-interface network rates from `/proc` and `/sys`, sampled every 2 s only while a System widget is on screen. No libgtop. |
| `screenTime.js` | NC ✅ | Screen Time widget: today, the last seven days and today by hour, computed from GNOME Wellbeing's session history file with the Shell's own 03:00 day boundary. |
| `quickSettingsBridge.js` | CC ✅ | Reads and drives OTHER extensions' Quick Settings toggles (title/subtitle/gicon/checked) so the Control Center can mirror them as capsules. Never adopts their actors — see `docs/ARCHITECTURE.md` §Third-party Quick Settings. |
| `extensionAdapters.js` | CC ✅ | Drives known third-party extensions through their own published GSettings contract (`src/adapters/`), picking our icon and wording and superseding the generic mirror of the same extension. |

NC = Notification Center widget backends. CC = custom Control Center backends (phase 2). Each is a small GObject with a
`changed` signal; none reimplements a daemon — they read/flip existing services.
