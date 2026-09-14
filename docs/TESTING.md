# Stage 10 — live test protocol

These scenarios require a running GNOME 50 session. The extension never changes
the native panel's chrome registration or struts. `FullscreenReveal` only
animates `panelBox.visible` / `translation_y` while a fullscreen window is active,
then restores GNOME's current visibility on disable; work-area and maximize
geometry remain native.

Commands assume the `fish` shell (the project default). Adjust loops for bash.

## Setup

```bash
./install.sh
```

Test in a nested session (safest — doesn't disturb your real shell):

```bash
dbus-run-session -- gnome-shell --nested --wayland
```

In another terminal, watch the journal the whole time (Criterion #20 — there must
be no repeating exceptions from `lintel@topbar`):

```bash
journalctl --user -f -o cat /usr/bin/gnome-shell
```

Enable:

```bash
gnome-extensions enable lintel@topbar
```

## Scenarios

| # | Scenario | Steps | Expected | Crit |
|---|----------|-------|----------|------|
| 1 | Normal desktop | Enable | Logo + app name left; separate Wi-Fi + battery + Control Center + clock right; Activities gone | #1 |
| 1b | Status popups | Open Wi-Fi, battery and Control Center one at a time | Each glyph owns its hit target/anchor and only its own popup opens; Wi-Fi networks and battery details are current | #4 |
| 2 | Maximized window | Maximize any window | Window top edge sits **below** the panel; no overlap | #11 |
| 3 | Fullscreen reveal | F11, then touch the top edge, then push the pointer up against it | Touching alone (or dragging with a button held) does not reveal; pushing slides the panel over the app; moving away hides it; exit → returns intact | #12 |
| 3b | Fullscreen popup | Reveal the panel and open System Menu / Control Center | Panel stays visible while the popup is open, then hides after close + pointer leave | #12 |
| 3c | Fullscreen notifications | Reveal the panel and click the clock | Notification Center opens above the fullscreen app; panel stays revealed while it is open | #12 |
| 4 | Overview | Press Super | Panel background transparent (default `overview-mode=transparent`); widgets still there | #13 |
| 4b| Overview modes | `gsettings set …lintel overview-mode keep` then Super | Bar keeps its background; try `native` too | #13 |
| 5 | Lock / unlock | Lock (Super+L), then unlock | Panel returns **identical**; no duplicated widgets; journal clean | #14 |
| 6 | Monitor hotplug | Plug/unplug a monitor (or start nested with `--monitors=2`) | Panel re-lays out; exactly one of each widget; clock still right | #10 |
| 7 | Resolution change | Change resolution in Settings → Displays | Panel reflows; clock/Control Center intact | — |
| 8 | Fractional scaling | Set 125% / 150% scaling | Panel + icons scale crisply; no overlap with windows | — |
| 8b | Adaptive contrast | Use light and dark wallpapers with Text colour = Automatic | Text/glyphs switch dark/light after the wallpaper transition; forced Light/Dark do not switch | — |
| 9 | Alt+Tab / close | Switch apps, then close the focused one | App name updates (debounced); clears to `Desktop` when nothing focused | #15 #16 |
| 10| Third-party items | Enable another indicator extension (e.g. appindicator) | Its icon appears via `addToStatusArea`; disabling us leaves it intact | #9 |
| 10b| Third-party Quick Settings | Enable Caffeine (or any extension using `addExternalIndicator`) in custom Control Center mode | No stray Quick Settings button in the bar: its toggle lives in the Control Center instead. The button appears only for an extension contributing a tile we cannot mirror (a `QuickSlider`) | #9 |
| 10c| …then restore | Switch to `control-center-mode = native`, then disable us | GNOME's own Quick Settings glyphs (network, volume, power…) all come back; no stuck-hidden indicator | #9 #2 |
| 10d| Mirrored toggles | With Caffeine enabled, open the Control Center | A `Caffeine` capsule above Edit Controls carrying its icon and state; clicking it toggles the extension, the capsule follows, and `gsettings get org.gnome.shell.extensions.caffeine cli-toggle` matches | #9 #4 |
| 10e| Mirror lifecycle | `gnome-extensions disable caffeine@patapon.info` with our popup open, then re-enable | The capsule disappears and comes back; no Clutter criticals in the journal about a wrong parent | #9 #3 |
| 10f| Adapter precedence | With Caffeine enabled, open the Control Center in a translated session (`LANG=ru_RU.UTF-8`) | Exactly ONE Caffeine capsule, carrying our title and its own on/off icon — never a second one labelled `Кофеин` | #9 |
| 10g| Adapter without a tile | `gsettings --schemadir …/caffeine@patapon.info/schemas set org.gnome.shell.extensions.caffeine show-toggle false` | Its Quick Settings tile is gone but our capsule stays and still toggles it | #9 |
| 11 | Notification Center | Click clock, then press `Esc`; repeat with `Super+V`; open Control Center and move the pointer onto the clock | 345px free-floating card column opens at right in all three cases; native date-menu plate never appears | #4 |
| 11b | Notification actions | Send at least three notifications from one application; inspect the collapsed stack, expand it, activate/dismiss one, then Clear all | The collapsed stack shows only the newest notification content (older cards remain as clean peeks); expanding restores every message; actions, application activation, dismiss and clear remain functional | #4 |
| 11c | Widget editing | Edit Widgets; add/remove/reorder widgets and cycle S/M/L; reopen | Layout persists; the full column scrolls when it exceeds the monitor; Edit Widgets/Done keeps its full height and can be scrolled into view | #3 #4 |

## Enable/disable stress + leak check (Criterion #3)

Run 20 cycles:

```bash
for i in (seq 20); gnome-extensions disable lintel@topbar; gnome-extensions enable lintel@topbar; end
```

Then verify:

- **Journal**: no growing list of exceptions during the loop.
- **statusArea is clean.** Open Looking Glass (`Alt+F2` → `lg` → Evaluator) and run:

  ```js
  Object.keys(Main.panel.statusArea).filter(r => r.startsWith('lintel-'))
  ```

  - While **enabled** in custom mode: `["lintel-system-menu", "lintel-active-app", "lintel-control-center", "lintel-wifi", "lintel-battery"]`
    (each exactly once).
  - After **disable**: `[]` (empty — nothing left behind).

- **Dynamic stylesheet is unloaded and its cache file removed:**

  ```bash
  ls ~/.cache/lintel/    # present while enabled; gone (or empty) after disable
  ```

- **Clock restored**: after disable, the panel clock is back in the center with
  GNOME's native format.

## Notifications

```bash
notify-send "Lintel" "top-right while enabled"
```

Banner appears top-right while enabled; disable → next banner is centered again.

The checked-in automation script validates the non-visual contract in an
isolated headless GNOME Shell: the replacement opens from the panel calendar
handler, the native date menu stays closed, notification banners pause only
while the center is open, and both states restore on close. It also checks that
content from older notifications cannot bleed through a collapsed translucent
stack, reappears on expansion, and is hidden again after collapse. It then runs
the full 20-cycle enable/disable stress check and rejects leaked center chrome.

```bash
test_dir=$(mktemp -d)
gnome-extensions pack . --force --out-dir "$test_dir" --extra-source=src \
  --schema=schemas/org.gnome.shell.extensions.lintel.gschema.xml
dbus-run-session -- gnome-shell-test-tool --headless \
  --extension "$test_dir/lintel@topbar.shell-extension.zip" \
  tools/notification-center-smoke.js
```

## What a failure looks like

- Windows overlapping the panel → something touched struts (should never happen).
- Leftover `lintel-*` roles after disable → a widget didn't destroy.
- Repeating `JS ERROR … lintel` in the journal → a live regression to fix.
- Panel opaque in the Overview with `overview-mode=transparent` → the overview
  class toggle regressed.
