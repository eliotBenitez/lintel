# Architecture

## Prime directive

**Never destroy or replace `Main.panel`.** This extension is a layout/compositor
layer *on top of* the native GNOME `Panel`. The native panel keeps ownership of:

- `statusArea` and `addToStatusArea()` (third-party extensions depend on it),
- `menuManager`,
- `panelBox` and its struts (work-area, maximize, fullscreen, hot corners),
- notification sources, grouping and actions (`MessageList.MessageView`),
- Quick Settings (`toggleQuickSettings()`).

`FullscreenReveal` is the narrow exception to the old "never touch
`panelBox`" invariant: it temporarily changes only the existing box's
`visible`/`translation_y` presentation while a fullscreen window is active. It
does not replace or reparent the box, alter its `trackFullscreen` registration,
or change struts, and teardown restores GNOME's current visibility immediately.

Bad:

```js
Main.panel.destroy();
Main.panel = new Lintel();   // breaks work area, struts, other extensions
```

Good: mutate the *contents* of the existing boxes and restore them on disable.

## Modules

```
extension.js            lifecycle only → PanelController
src/panelController.js   capture / applyLintelLayout / restore / handleSessionMode / destroy
src/panelState.js        PanelSnapshot: pristine capture + reconciling restore
src/compat/panelAdapter.js   ONLY place touching Main.panel private fields
src/compat/gnome50.js    version detection / per-version quirks
src/widgets/*            system menu, active app, control center, clock, notifications
src/services/*           window/app/theme, weather, battery and media models
```

The compat layer is the seam: a GNOME 51/52 break in `_leftBox`/`_centerBox`/
`_rightBox`/role names is a one-file fix in `panelAdapter.js`.

## Behaviour (this build — Stages 1–9)

- `captureOriginalState()` snapshots the ordered children + visibility of all
  three panel boxes **once**, before any mutation, plus the pristine
  `Main.messageTray.bannerAlignment`.
- `applyLintelLayout()` is **idempotent** — add `.lintel` style class, add the
  system menu + active-app name at the far left (order enforced by
  `_ensureLeftOrder()`), hide Activities, add the Control Center button and pin
  the independent Wi-Fi/battery status menus beside it, move the clock
  (`dateMenu`) to the far right, and align notification banners to the right
  (Stage 2). `LintelNotificationCenter` redirects the clock and
  `toggleCalendar()` / `closeCalendar()` to its overlay without destroying the
  native date menu.
- `handleSessionMode()` re-asserts the layout after GNOME's `Panel._updatePanel`
  rebuilds boxes on a `Main.sessionMode` `updated`, deferred via a coalesced idle
  so we run *after* GNOME.
- `destroy()` disconnects the session + monitors signals, removes the pending
  idle, restores banner alignment + the pristine snapshot, and drops all
  references.
- We re-assert the layout (via one coalesced idle) on both `Main.sessionMode`
  `updated` **and** `Main.layoutManager` `monitors-changed`, covering monitor
  hotplug / resolution / fractional-scale reallocation (Stage 10). The
  fullscreen overlay leaves the panel's native chrome tracking and strut
  ownership intact, so work-area and maximize geometry stay native — see
  `docs/TESTING.md` for the live verification protocol.

### Live settings (prefs)

`PanelController` listens to `settings::changed`. Keys in `STRUCTURAL_KEYS`
(which widgets exist, clock side, Activities visibility) trigger
`_reapplyStructure()` — tear down and re-add the affected widgets — so prefs take
effect without a re-enable. `hide-activities` and `clock-on-right` are honoured
(and reversible: `_applyActivitiesVisibility` shows Activities again,
`_moveClockHome` returns the clock to its captured original slot). All
appearance/clock-format/tunable keys are instead watched live by `ThemeManager`
and `LintelClock`, so they are deliberately excluded from `STRUCTURAL_KEYS`. The UI
itself is `prefs.js` (libadwaita).

### Right-block order (Stages 2 + 11)

`_positionRightControls()` explicitly keeps the extension-owned block
left→right as Wi-Fi (`lintel-wifi`), battery (`lintel-battery`), Control Center
(`lintel-control-center`), then the clock (`dateMenu`) at the far right. Native
clock padding is tightened only in this right-hand layout so the time follows
the Control Center glyph as part of the same compact status cluster. GNOME's
external/privacy, accessibility and input indicators remain ahead of that
block. Each status item is a separate `PanelMenu.Button`, so menu ownership,
pointer/keyboard focus and the popup anchor do not bleed across glyphs. The
center box is intentionally left empty/flexible.

### System menu (Stage 3)

`src/widgets/systemMenu.js` (`LintelSystemMenu extends PanelMenu.Button`) is our
first real widget. It is registered with `Main.panel.addToStatusArea(
'lintel-system-menu', menu, 0, 'left')`, which inserts `menu.container` at the left
edge **and self-cleans `statusArea` on the widget's `destroy`** — so teardown is
just `menu.destroy()` in `restoreOriginalState()`, run *before* the snapshot
restore so only GNOME's own actors are reconciled. Add is idempotent (the widget
persists across sessionMode; we only re-assert its leftmost position).

Power/session items (Sleep/Restart/Shut Down/Lock/Log Out) call GNOME's own
`SystemActions` singleton — availability via `can-*` properties, confirmation
dialogs for free. About/Settings appear when `gnome-control-center` is present;
App Center resolves through the distro's `appstream://` handler. Force Quit
`kill()`s the focused window. The popup itself has isolated Tahoe metrics,
a translucent material and a user-specific Log Out label. The logo
defaults to the distributor icon named by os-release `LOGO=`. That field is an
*icon name* per the freedesktop Icon Theme Specification and is optional, so it
is resolved by searching `hicolor` (scalable first, else the largest raster
size), then `/usr/share/pixmaps`, then `/usr/share/icons` itself — the last is
not spec-compliant but is where CachyOS puts its logo. Resolution is by FILE,
never by themed name: Apple-styled icon themes ship `start-here-symbolic` as an
Apple glyph, which this extension must never show. The artwork is then painted
as a flat silhouette of its alpha in the panel foreground colour
(`newLogoSilhouette()`), because distributor logos are full-colour and no
distribution ships a symbolic variant. Distributions that set no `LOGO` get a
best-effort guess from `ID`, then `start-here-symbolic`. Overridable via the
`system-menu-icon` setting (read defensively; falls back to the default if the schema isn't
compiled).

### Appearance (Stage 8)

`src/theme.js` (`ThemeManager`) generates a CSS string from settings and loads it
over the shell theme via `St.Theme.load_stylesheet`, unloading on disable — so no
static file can carry the continuous tunables. Everything is scoped under
`.lintel` / `#panel.lintel` (id+class beats the theme's `#panel`, so height /
background / font actually win). It regenerates on any of our settings changing,
on `color-scheme` (light/dark) changes, and re-applies itself if the shell theme
reloads (guarded against the reentrancy that `load_stylesheet` would otherwise
cause). The generated file lives in the user cache dir and is deleted on disable.

- `appearance`: tahoe-transparent (default) / translucent / solid / follow-gnome.
  Transparent mode adds a subtle text/icon shadow for wallpaper readability.
- `text-mode` picks the foreground rgb; hover/active washes are `rgba(fg, …)`.
- Tunables: `panel-height`, `h-padding`, `item-spacing`, `font-size-pt`,
  `font-family` (prepended to an `"SF Pro Text", "Adwaita Sans", sans-serif`
  fallback — SF Pro is never bundled), `font-weight`, `hover-opacity`,
  `active-opacity`, `show-menu-background`.
- **Overview safety:** rather than let a forced `#panel` background bleed into the
  Overview, we toggle a `lintel-overview-transparent` class across
  Overview show/hide (honouring `overview-mode`) that zeroes the background there.

### Hover / pressed (Stage 9)

The same generator gives panel buttons their Tahoe feel: an **explicitly
transparent** normal state (so St has a from-value to animate), the pill
`corner-radius` on every state (shape stays put while colour fades), a
`transition-ms` fade (default 120ms, the 100–150ms range the design calls for),
a faint `hover-opacity` wash, a stronger `active-opacity` wash on open/pressed,
and a slightly stronger wash again when hovering an already-open button. Our
active-app label is non-reactive so it never gets a pill — the app name reads as
plain bold text, as on macOS. `stylesheet.css` keeps a grey, theme-agnostic
version of these rules purely as a fallback if the dynamic sheet fails to load.

### Clock (Stage 7)

`src/widgets/clock.js` re-formats the panel clock without disturbing the native
dateMenu (calendar + notifications). The native `_clockDisplay` is bound to a
`GnomeDesktop.WallClock` via a `bind_property` whose binding is never stored, and
WallClock has no custom-format API — so instead of fighting the binding we
**hide `_clockDisplay`** and insert our own `St.Label` into the same
`clock-display-box`, driven by a 1 Hz timer + `GLib.DateTime.format`. Format is
built from our `clock-date-mode` / `clock-show-weekday` / `clock-show-ampm` /
`clock-show-seconds` keys plus the system
`org.gnome.desktop.interface clock-format` (12h/24h), all watched live.

Three details come from measuring a Tahoe capture rather than from taste: the
date is ordered by the locale (probe `%x` with a date whose day and month
differ — a hard-coded `%b %-d` reads wrong outside the US), the date and time
are separated by a double space (7.2pt against a 3.6pt word space), and AM/PM is
preceded by U+202F, a narrow no-break space (2.4pt). The label also carries
`font-feature-settings: "tnum"`: Adwaita Sans and Cantarell both default to
proportional digits, which made the clock swing 12px in width every minute and
shove the whole trailing cluster sideways.

`clock-date-mode = when-space-allows` mirrors macOS's default: on each tick the
full string is set, the three panel boxes' natural widths are summed, and if they
exceed the monitor width the date is dropped (the weekday and time stay). The
decision is re-derived from the full string every time, so it cannot oscillate. On
disable we destroy our label and un-hide the native one. `enable()` is idempotent
(guards on our label), so the sessionMode re-apply doesn't double-hijack.

### Notification Center (0.16)

`src/widgets/notificationCenter.js` creates a full-stage, transparent top-chrome
input surface and positions a 345px scrollable column 15px from the right edge,
50px below the top of the primary monitor. The root has no painted background:
notifications and widgets are independent translucent cards, 8px apart inside
the notification stack and 15px apart otherwise, as measured in
`docs/MACOS_REFERENCE.md`. It never affects struts.

Message styling is anchored on `#lintelNotificationCenter`. GNOME's theme
styles messages through three-class selectors (`.message .message-box
.message-icon`) and `!important` margins, so any two-class override silently
loses; only the ID wins against both the stock theme and user themes.

GNOME's collapsed notification-group layout deliberately overlaps full-height
message actors and depends on opaque stock cards to mask the older content.
Because this surface uses translucent cards, `LintelNotificationCenter` follows
the group's `second-in-stack` / `lower-in-stack` pseudo-classes, sets only those
messages' inner content opacity to zero, and gives every collapsed stack layer
an opaque background. The card surfaces still form clean native stack peeks,
while expansion restores every message's original translucent material.

The message surface is GNOME Shell 50's exported `MessageList.MessageView`, not
a copied notification database. It therefore retains native source lifecycle,
grouping, expansion, application activation, action buttons, media controls,
dismiss and Clear all. Opening the surface temporarily blocks banners; closing
or destroying it restores the exact prior tray state.

`PanelAdapter` is the only module touching `DateMenuButton._clickGesture` and
the panel's calendar methods. It suspends the native click gesture, installs a
replacement `Clutter.ClickGesture`, redirects `toggleCalendar()` /
`closeCalendar()` (so `Super+V` follows the clock), and also redirects a direct
native-menu open. The latter is the path `PopupMenuManager` uses when the
pointer crosses from another open panel menu onto the clock. Teardown checks
method identity before restoring, so a later third-party override is not
overwritten. The native date menu actor remains owned by GNOME for the entire
lifecycle.

The widget area is extension-owned; the widgets themselves live in
`src/widgets/ncWidgets.js`. Sizes follow Tahoe's grid — small is a 165px square
and consecutive small widgets pair two to a row, medium is 345 x 165, large
345 x 345 — with the geometry in `stylesheet.css`. Calendar and the analogue
clock use local GLib time; weather comes from a keyless web service (Open-Meteo
or wttr.in, `services/weatherProviders.js`) for the city chosen in preferences
or the GeoClue position (`services/geolocation.js`), and paints a sky gradient
for the current condition. Automatic location never falls back to IP
geolocation: with Location Services off it uses the chosen city or asks for
one. Yandex, Google and Gismeteo were ruled out because each needs an
account-bound API key. Up Next shares the date menu's calendar-server client
(`compat/calendarEvents.js`); the server keeps one time range for every client,
so it always requests a superset of the date menu's current month grid. Screen
Time reads GNOME Wellbeing's `session-active-history.json` and repeats the
Shell's arithmetic, 03:00 day boundary included. System reads `/proc` and
`/sys` directly (no libgtop), counts network traffic only on interfaces backed
by a device so VPN tunnels and bridges are not counted twice, and samples only
while a System widget is mapped. All three borrow their words from
the gnome-shell and gnome-control-center translations
(`compat/borrowedStrings.js`) instead of hard-coding English. Battery draws
a ring gauge from the same UPower DisplayDevice model as the status menu; Now
Playing uses MPRIS. Cairo-painted parts (ring, clock face) read their colours
from custom `-lintel-*` properties via `lookup_color()`, so light/dark stays
in CSS. Inline editing floats remove/move/size controls over each widget and
writes the ordered widget IDs and per-widget S/M/L sizes to GSettings.
Every widget also cleans up from its actor's `destroy` signal because Clutter can
destroy descendants from C without invoking a JavaScript `destroy()` override.

### Control Center (Stage 6)

`src/widgets/controlCenter.js` always owns an independent Control Center glyph.
In native compatibility mode click/touch/Enter call
`Main.panel.toggleQuickSettings()` and the button mirrors the QS menu's open
state via its `open-state-changed` signal. The native `quickSettings` indicator
therefore stays mapped/reactive in that mode. The icon is the fixed Tahoe
sliders glyph, rendered by an `St.DrawingArea`,
so it cannot degrade to a missing-icon placeholder when an icon theme omits the
name. Preferences can change the mode, but cannot replace or hide this glyph.

`control-center-mode = native` mounts **no** button of ours: GNOME's own Quick
Settings indicator stays in the bar and is the trigger. Earlier builds added our
glyph *as well*, so the bar carried two buttons for one popup.

**Custom mode (`control-center-mode = custom`, default):** instead of delegating
to Quick Settings, that glyph opens our **own** popup. Its composition follows
`docs/audits/tahoe-reference/26-Tahoe-Finder-Control-Center.png` in order:
Wi-Fi / Bluetooth / AirDrop as three stacked capsules beside a Now Playing card
and two square utilities; then an actions row carrying two circles (Dark Mode,
Screenshot) and the Focus capsule; then labelled Display and Sound modules; then
Edit Controls (`CCTile`, `CCActionButton`, `CCMediaCard`, `CCSlider`), all
styled under `.lintel-cc-*`. The 292px content width and its two 140px columns
with a 12px gutter come from that capture at 1pt = 1 logical px.

**There is no backdrop blur, by decision.** `BoxPointer` sets
`OffscreenRedirect.ALWAYS`, so a `Shell.BlurEffect` in BACKGROUND mode inside a
popup has no backdrop in its framebuffer to sample and blurs nothing. Every
alternative means compositing a copy of the screen behind the popup — a
wallpaper copy is wrong the moment a window is behind it, and a live clone of
`global.window_group` works but costs a screen-sized clone and blur per frame.
Both were built and both were removed; the modules rely on their tint alone. See
`DESIGN_QA.md` Pass 8-12 before reaching for this again. Each module owns a
the translucent dark material and text shadow provide the contrast over light
wallpaper. The controller
strips the native `quickSettings` indicator (see *Third-party Quick Settings*
below) and mounts two sibling status menus:

- `src/widgets/wifiMenu.js` owns `lintel-wifi` and a light Tahoe popup. Its
  `src/services/wifi.js` model uses libnm for the radio state, access-point
  grouping, active/known/signal/security state, periodic scanning while open,
  and activation/deactivation. Unsaved enterprise networks hand off to GNOME's
  Wi-Fi panel for credential/configuration UI.
- `src/widgets/batteryMenu.js` owns `lintel-battery`, including its own percentage,
  UPower charge status/time/source and optional power-profiles-daemon choices.
- `src/widgets/statusMenu.js` shares only presentation. It does not merge
  either actor or popup, preserving distinct hit targets and checked states.

### Third-party Quick Settings (`src/externalIndicators.js`)

Other extensions do not all use `Main.panel.addToStatusArea()`. Caffeine and
anything else built on `QuickSettings.addExternalIndicator()` parent their
`SystemIndicator` inside `quickSettings._indicators` and their tiles in the QS
menu grid. Hiding the whole `quickSettings` container therefore hid their glyph
*and* — since `Panel._toggleMenu()` returns early on an unmapped indicator —
made `Main.panel.toggleQuickSettings()` a no-op, so their toggles had no way in.

In custom mode we strip the button instead. `ExternalIndicators` forces GNOME's
own indicators hidden (one `notify::visible` guard each, because
`SystemIndicator._syncIndicatorsVisible()` re-asserts `visible` from its icons
and would undo a one-shot `hide()`), leaves third-party indicators exactly where
they are, and shows the container only while one of them is visible. With no such
extension installed the panel is unchanged. `PanelAdapter` owns the list of
private fields that identifies GNOME's own indicators.

Third-party indicators are deliberately **not** reparented into a box of ours:
Caffeine re-orders itself with `quickSettings._indicators.remove_child(this)`,
which would hit the wrong parent and raise a Clutter critical. For the same
reason we never touch their signals.

**Their tiles are mirrored, not adopted** (`src/services/quickSettingsBridge.js`).
`ccTile.js` already explains why this popup does not host GNOME Quick Settings
widgets; a third-party `QuickToggle` adds two more reasons. A `QuickMenuToggle`'s
sub-page actor lives in the QS menu's private `_overlay`, constrained to the QS
grid through `QuickSettingsMenu._completeAddItem()`, so reparenting the toggle
strands its sub-page; and extensions reach back into the grid on disable. The
bridge therefore only reads their public properties (`title`, `subtitle`,
`gicon`, `checked`) and drives them the way `St.Button` does — flipping `checked`
first when `toggle-mode` is set, then emitting `clicked`, because that is the
order a real click produces and handlers read the current state. `ControlCenter`
reconciles one `CCTile` per tile into `.lintel-cc-extensions` at the bottom of
the popup (reconcile, not rebuild: `changed` also fires for a plain state flip).

`QuickSlider` items are skipped — non-reactive and title-less, a capsule cannot
stand in for a slider — and so is any bare custom widget. Those are the only
reason the stripped button still exists: `ExternalIndicators` keeps it **only
while some third-party tile is one our popup cannot represent**, asking exactly
the predicate the bridge uses (`isRepresentableQuickSettingsItem`). For a plain
toggle like Caffeine's there is nothing left uncovered, so the button — and the
third-party glyphs riding inside it — is hidden, and the extension's control
lives in the Control Center instead.

The consequence to know: an extension that contributes *only* a panel glyph and
no tile has nothing for us to cover and nothing behind the button worth opening,
so its glyph does not appear in custom mode. A `QuickMenuToggle`'s sub-page
(Caffeine's timers) is likewise unreachable while the button is hidden.

**Known extensions get an adapter** (`src/adapters/`, driven by
`src/services/extensionAdapters.js`). An adapter is a declarative descriptor over
an extension's own *published* contract — for Caffeine, the single GSettings key
`cli-toggle`, which its `_inhibitorUpdated()` keeps in sync with the live state
and its `_commandStateChanged()` treats as a level-set. That buys three things
the generic mirror cannot: our icon and wording instead of theirs, a state read
that does not depend on the tile existing (Caffeine's `show-toggle` can hide it),
and a toggle that does not rely on `St.Button` internals. No adapter imports
another extension's code or touches its `stateObj`.

Two hazards the adapter layer exists to contain. A schema we do not ship is
**never** opened as `new Gio.Settings({schema_id})` — GLib aborts the process on a
miss, taking the Shell with it — so every lookup chains a
`Gio.SettingsSchemaSource` rooted at the extension's own `schemas/` onto the
default source and tolerates a null. And an adapter must recognise the tile it
supersedes, or the popup shows the extension twice; matching an English label
would fail immediately, since these titles are translated (Caffeine's tile reads
"Кофеин" in `ru_RU`), so `claims()` resolves the msgid through the extension's
**own** gettext domain and matches that. `ControlCenter._extensionEntryList()`
merges the two sources, adapters first.


Control Center controls are wired to existing backends only — no daemon is
reimplemented: volume via `Gvc`, brightness via
`org.gnome.SettingsDaemon.Power.Screen` or, when there's no D-Bus backlight,
`brightnessctl` (verified present on the dev machine), Wi-Fi via NetworkManager
`WirelessEnabled`, Bluetooth/Airplane via
`org.gnome.SettingsDaemon.Rfkill`, Now Playing through MPRIS, and Dark Mode /
Focus through their gsettings keys. Every
service lives in `src/services/*`, emits `changed`, and releases its
proxies/signals on destroy. Actor construction and popup opening are verified in
a headless GNOME 50.4 session; `control-center-mode = native` remains the safe
fallback.

### Global menu — removed

Planned as Stage 5 and removed again in 0.15.5. Two providers were built and
both were dead ends on a modern GNOME desktop:

- `com.canonical.AppMenu.Registrar` + `com.canonical.dbusmenu` — keyed by X11
  window id, so XWayland-only, and in practice only Qt apps with `appmenu-qt5`
  ever register.
- `org.gtk.Menus` off `Meta.Window.get_gtk_menubar_object_path()` — worked
  against a GTK3 test app end to end (tree, enabled state, activation), but it
  needs `appmenu-gtk-module` loaded session-wide *and* an app that still has a
  `GtkMenuBar`. GTK4/libadwaita apps have no menubar to export, which is most of
  a current desktop.

The panel therefore stops at the focused app's name (`src/widgets/activeApp.js`),
and `ActiveApp` is intentionally non-reactive. Do not re-add a menu host without
first checking that real target apps actually export a menu.

### Active application (Stage 4)

`src/widgets/activeApp.js` is a passive (non-reactive, menu-less)
`PanelMenu.Button` holding a bold `St.Label`, placed at left index 1. It listens
to `src/services/windowTracker.js`, which debounces `Shell.WindowTracker`'s
`focus-app` (80ms) so rapid Alt+Tab doesn't thrash the panel. When `focus-app`
is null (nothing focused, or the focused app just closed — Criterion #16) it
shows the configurable `empty-app-label` ("Desktop"), or hides itself if that
label is empty. Teardown: the widget disconnects its tracker signal and destroys
the tracker (timeout + notify handler released) before the base destroy.

### Notification alignment (Stage 2)

`src/notificationAlignment.js` owns `Main.messageTray.bannerAlignment`
(→ `_bannerBin.x_align`, default `CENTER`). We set it to `Clutter.ActorAlign.END`
on apply and restore the captured value on disable. Because `session-modes` is
`["user"]`, the extension is disabled on the lock screen, so banners revert to
native centering there automatically — we don't fight the lock-screen layout.

## Restore strategy

Snapshot at the **box level** (ordered child actors + a visibility map), not by
per-indicator index. This survives reparenting between boxes and is robust to
third-party items appearing while enabled. Every actor access is guarded by an
`_isAlive()` disposed-object check.

## Acceptance criteria (full project — track against these)

1. `enable()` needs no logout. 2. `disable()` restores the stock top bar exactly.
3. 20× enable/disable leaks no actors/signals/timeouts. 4. Quick Settings works.
5. Calendar/notifications work. 6. Input source works. 7. A11y indicators kept.
8. Screen sharing/recording indicators kept. 9. `addToStatusArea()` unbroken.
10. Panel reserves screen height. 11. Maximized windows don't overlap.
12. Fullscreen works. 13. Overview works. 14. Lock→unlock keeps layout.
15. Alt+Tab updates Active App. 16. Closing focused app clears its name.
17. Wayland is the primary test env. 18. GNOME 50 required. 19. GNOME 51 has a
separate compat test. 20. No repeating exceptions in the Shell journal.

Stages 1–10 target #1, #2, #3, #4 (Control Center opens Quick Settings), #5
(native calendar + notifications intact under a reformatted clock), #9, #10–#13
(hotplug re-assert; struts/work-area/maximize untouched; fullscreen adds a
temporary top-edge overlay; Overview stays transparent), #14 (layout re-assert), #15/#16
(Alt+Tab updates the app name; closing the focused app clears it), #20. The
system-menu, active-app and control-center widgets exercise #9 directly (they
*are* `addToStatusArea` clients); #3 covers every timer, signal, bus name and the
theme manager's stylesheet + cache file — all released on disable, and verified by
the enable/disable stress + `statusArea` leak check in `docs/TESTING.md`.
Scenarios #10–#14 need a live session (see that protocol); the code invariants
they rely on were audited here.
