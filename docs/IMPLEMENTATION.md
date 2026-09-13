# Implementation notes

Developer-facing status of every subsystem, the removed global menu, and the
full manual test checklist. The user-facing overview is the top-level
[README](../README.md).

## Status — 0.16.0 (Tahoe Notification Center)

Implemented:

- Project structure + compat seam (`src/compat/panelAdapter.js`).
- `PanelController`: capture / apply / restore / session-mode re-assert / destroy.
- Layout mutations: **hide Activities**, **move the clock to the far right**,
  right-block already in macOS order, center box left empty.
- **Notification banners aligned right** to follow the clock
  (`src/notificationAlignment.js`), restored to center on disable.
- **Tahoe Notification Center** (`src/widgets/notificationCenter.js`): clicking
  the clock or pressing `Super+V` opens a 345px free-floating card column 15px
  from the right edge. It uses GNOME's native `MessageView`, so notification
  grouping, expansion, actions, activation, dismiss and Clear all keep working.
  Calendar, Up Next, weather, Screen Time, System, battery, Now Playing and
  clock widgets can be added,
  removed, reordered and resized from the inline Edit Widgets mode. Long
  columns scroll; the native date menu and its exact handlers return on disable.
- **System menu** at the far left (`src/widgets/systemMenu.js`): configurable
  logo (default `start-here-symbolic`) → compact Tahoe glass popup with About /
  Settings / App Center, a Recent Items disclosure, Force Quit, and Sleep /
  Restart / Shut Down / Lock / named Log Out via GNOME's native
  `SystemActions`. App Center resolves through the distro's `appstream://`
  handler.
- **Active application name** (`src/widgets/activeApp.js` + `services/windowTracker.js`):
  bold name of the focused app next to the logo, debounced against Alt+Tab,
  cleared/`Desktop` when nothing is focused.
- **Control Center button** (`src/widgets/controlCenter.js`): an independent
  menu-bar item pinned just left of the clock. Custom mode opens the Tahoe
  popup; native compatibility mode delegates to Quick Settings. Both modes use
  a fixed, code-rendered Tahoe Control Center glyph.
- **Third-party Quick Settings kept reachable** (`src/externalIndicators.js`):
  extensions like Caffeine hang their glyph and tiles off GNOME's `quickSettings`
  button rather than `addToStatusArea`, so hiding that button outright used to
  take their toggles with it. Custom mode strips it down to third-party content
  and keeps it **only** as an escape hatch — while some third-party tile exists
  that the Control Center cannot represent (a slider, a custom widget). Ordinary
  toggles are covered by the popup, so the button stays hidden.
- **Third-party toggles in the Control Center**
  (`src/services/quickSettingsBridge.js`): their Quick Settings toggles are
  mirrored into the popup as ordinary Tahoe capsules — title, state and icon
  read from the tile itself, clicks driven back into it. Their actors are never
  adopted, so nothing about the other extension breaks; sliders and
  `QuickMenuToggle` sub-pages stay in native Quick Settings.
- **Adapters for known extensions** (`src/adapters/`): a small declarative
  descriptor drives an extension through its own published settings contract —
  Caffeine via `cli-toggle` — so its capsule carries our icon and wording, reads
  state directly, and keeps working when the extension's own Quick Settings tile
  is switched off. An adapter supersedes the generic mirror of the same
  extension, matching its tile through that extension's gettext domain so the
  two never double up in a translated session.
- **macOS clock** (`src/widgets/clock.js`): reformats the panel clock to match
  the Tahoe menu bar — locale-ordered date, tabular figures so the bar never
  shifts as the time ticks, and macOS's own Clock Options: show date
  (when space allows / always / never), day of the week, AM/PM, seconds; 12h/24h
  follows the system. The clock triggers the Tahoe Notification Center while
  enabled; its native GNOME date menu and format are fully restored on disable.
- **Tahoe appearance** (`src/theme.js`): dynamic stylesheet driven by settings —
  transparent / translucent / solid / follow-GNOME, light/dark-aware text and
  hover/active washes, height / padding / spacing / font tunables, and
  Overview-transparent handling. Unloaded cleanly on disable.
- **Tahoe adaptive contrast**: Automatic text colour samples the pixels actually
  visible under the transparent panel and switches the entire bar between dark
  and light glyphs with hysteresis. It follows wallpaper changes, monitor/focus
  changes and fullscreen content; explicit Light/Dark choices still override it.
- **Fullscreen top-edge reveal** (`src/fullscreenReveal.js`): GNOME's native
  fullscreen-hidden state remains the default, but moving the pointer to the top
  edge slides the existing panel over the fullscreen app. It stays while hovered
  or while a panel popup is open, then hides again without changing struts.
- **Tahoe hover/press**: transparent at rest → faint hover wash → stronger
  open/pressed wash, pill `corner-radius`, `transition-ms` fade; app name stays
  plain bold (no pill).
- **Preferences UI** (`prefs.js`): libadwaita pages (Layout / Clock / Appearance)
  covering every key. All controls apply **live** — structural
  ones via a settings listener in `PanelController`, appearance/clock ones via
  ThemeManager/LintelClock. `hide-activities` and `clock-on-right` are now honoured
  (and reversible) by the controller.
- **Stage 10 robustness**: re-asserts on `monitors-changed` (hotplug / resolution
  / fractional scale) as well as session changes. The fullscreen controller only
  animates native `panelBox` visibility/translation; it never changes its chrome
  tracking or struts, so work-area and maximize geometry stay native. Full live
  test protocol + leak check in [`docs/TESTING.md`](TESTING.md).
- **Custom Control Center** (`control-center-mode = custom`, default): own popup
  opened from its own Control Center glyph. The Wi-Fi and battery glyphs are
  separate `PanelMenu.Button` instances with independent hit targets, checked
  states, popup anchors and lifecycle roles (`lintel-wifi` / `lintel-battery`).
  The Wi-Fi popup lists live libnm access points, marks the active connection,
  connects/disconnects networks and exposes its own radio switch. The battery
  popup shows percentage, charge state, remaining time, power source and the
  available power profiles.
  The popup follows the macOS Tahoe module geometry: Wi-Fi, circular Bluetooth/
  AirDrop and Focus beside MPRIS Now Playing and system actions, full-width
  Display/Sound sliders, four circular utilities and Edit Controls. Backends
  only — Gvc volume, Power brightness (optional), NetworkManager Wi-Fi, GNOME
  Rfkill Bluetooth, UPower battery, MPRIS and gsettings dark/DND. The 0.14 pass
  aligns the columns, gives every toggle a shared blue checked state, rebuilds
  Now Playing as a compact artwork/metadata/transport composition, removes the
  redundant Sound output glyph, and uses a lighter Liquid Glass material with
  restrained edge light and keyboard-focus treatment. Each module uses Shell's
  a translucent tint and text shadow so labels stay readable over changing
  wallpaper. GNOME gives popups no usable backdrop blur — see [`DESIGN_QA.md`](DESIGN_QA.md).
  Construction and opening are verified in a headless
  GNOME 50.4 session; set `control-center-mode native` to fall back to Quick
  Settings — in that mode we mount no button of our own and GNOME's indicator
  is the trigger.

Not included: an app menu (File/Edit/View…). The panel shows the focused app's
name only — see below. Stages 10–11 full hardware/live-session verification
remains documented in `docs/TESTING.md`.

## Removed: global menu

An experimental File/Edit/View… menu shipped behind `enable-global-menu` up to
0.15.4 and was removed in 0.15.5, along with its setting and preferences page.
Both available protocols turned out to be dead ends on a current GNOME desktop:

- The `com.canonical.AppMenu.Registrar` / `com.canonical.dbusmenu` path is keyed
  by X11 window id, so it is XWayland-only, and in practice only Qt apps with
  `appmenu-qt5` register at all.
- The `org.gtk.Menus` path worked end to end against a GTK3 test app, but it
  requires `appmenu-gtk-module` enabled session-wide *and* an app that still has
  a `GtkMenuBar`. GTK4/libadwaita apps — most of a modern desktop — have no
  menubar to export, so the bar stays empty for them anyway.

`enable-global-menu` no longer exists. If it is still set in dconf it is simply
ignored; clear it with:

```bash
dconf reset /org/gnome/shell/extensions/lintel/enable-global-menu
```

## Develop

```bash
./install.sh
dbus-run-session -- gnome-shell --nested --wayland   # nested test session
gnome-extensions enable lintel@topbar
```

## Manual test checklist (Stages 1–4, 6–9)

- [ ] Enable: Activities disappears, clock jumps to the far right, a **logo
      button + bold app name appear at the far left**, and independent **Wi-Fi,
      battery and Control Center** buttons appear just left of the clock.
- [ ] Open Wi-Fi, battery and Control Center in turn: each button has its own
      popup and checked/open state. In the Wi-Fi popup, the active SSID is
      checked and the switch/network actions work. In the battery popup, charge
      details and power modes reflect the system.
- [ ] Clock reads macOS-style with the date in the locale's own order (e.g.
      `Mon Sep 7  19:02` in en_US, `Пн 7 сен  19:02` in ru_RU); clicking it still
      opens the Tahoe Notification Center. Its width must NOT change as the
      minutes tick. Toggle each Clock Options row in prefs — date
      (when space allows / always / never), day of the week, AM/PM, seconds —
      each applies live. Disable → native clock format returns.
- [ ] Click the clock or press `Super+V`: a free-floating right column opens,
      with no plate behind the cards. Notification activation/actions,
      expansion, dismiss and Clear all work; `Esc` closes it.
- [ ] Choose Edit Widgets: add/remove Calendar, Up Next, Weather, Screen Time,
      Battery, Now Playing and Clock; move them up/down and cycle S/M/L.
      Close/reopen and confirm the order/sizes persist. A column taller than the
      monitor scrolls.
- [ ] Up Next: add an event in GNOME Calendar for later today; it appears
      without reopening, and drops off once it ends. Disable the extension and
      open the native date menu: its month still shows its own events.
- [ ] Screen Time: today's total matches Settings → Wellbeing; turning
      recording off there shows "Screen Time Recording Disabled".
- [ ] System: processor and memory follow Mission Center / `top` within a few
      percent; a large download moves the network rate; with Notification
      Center closed the widget stops sampling (no 2-second wakeups).
- [ ] Appearance: default is transparent. Switch modes live —
      `gsettings set org.gnome.shell.extensions.lintel appearance solid|translucent|follow-gnome`
      — panel background updates without re-enabling.
- [ ] Toggle system dark/light → translucent/solid colours and text follow it.
- [ ] Open the Overview → panel background is transparent there (not opaque).
- [ ] Use a light then dark wallpaper with Text colour = Automatic → panel text
      switches dark/light after the wallpaper fade without re-enabling.
- [ ] Enter fullscreen, move the pointer to the top edge → panel slides in over
      the app; move away → it hides. Open a panel popup → it stays until closed.
- [ ] Disable → panel returns to the stock theme; no `lintel-dynamic.css`
      left loaded, cache file removed.
- [ ] Hover a panel button → faint rounded wash fades in (~120ms); open the
      system menu / Control Center → stronger wash while open. The bold app name
      shows no pill. Tweak `corner-radius`/`transition-ms` → updates live.
- [ ] Preferences: open `gnome-extensions prefs lintel@topbar` — toggling any
      control (hide Activities, clock side, appearance, opacity, clock format,
      logos) changes the panel **live**, no re-enable. Turning off Activities-hide
      brings Activities back; turning off clock-on-right moves the clock to center.
Tweak appearance from the terminal, e.g.:

```bash
gsettings set org.gnome.shell.extensions.lintel appearance translucent
```
- [ ] Focus different apps / Alt+Tab: the bold name updates (no flicker storm).
- [ ] Close the focused app so nothing is focused: name clears to `Desktop`
      (or hides if `empty-app-label` is empty) — Criterion #16.
- [ ] Open the system menu: About/Settings launch, Recent Items opens Files at
      recent, Force Quit shows the focused app's name, Sleep/Lock/Log Out/
      Restart/Shut Down work (with GNOME's confirm dialogs).
- [ ] Switch to native Control Center mode: Quick Settings becomes visible and
      opens normally. Notification Center and a11y still work in both modes.
- [ ] With Caffeine (or any `addExternalIndicator` extension) enabled in custom
      mode: its glyph is in the menu bar and clicking it opens Quick Settings
      with its toggle working. Switching to native mode / disabling us brings
      GNOME's own Quick Settings glyphs back.
- [ ] Open the Control Center: a `Caffeine` capsule sits above Edit Controls;
      clicking it flips the extension (its own glyph follows), and disabling the
      extension removes the capsule. Exactly **one** capsule, in any locale.
- [ ] **Trigger a notification** (e.g. `notify-send hi`): banner appears at the
      **top-right**, not centered.
- [ ] Disable: top bar returns *exactly* to stock (clock back in center,
      Activities back, **logo gone**) **and** the next notification is centered.
- [ ] Enable/disable ~20× — no growing warnings, no leftover logo/clock state,
      no orphaned `lintel-system-menu` in `Main.panel.statusArea`.
- [ ] Lock → unlock (or toggle session mode) — layout re-asserts, no dupes.
- [ ] `journalctl --user -f -o cat /usr/bin/gnome-shell` shows no repeating
      exceptions from `lintel@topbar`.

Quick notification test:

```bash
notify-send "Lintel" "should appear top-right"
```
