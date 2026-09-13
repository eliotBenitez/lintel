# macOS Tahoe menu bar — design target

Target layout the panel should become:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◉  AppName  File Edit View Go Window Help      ⌕  ◉  WiFi 🔊 🔋  Mon 19:02 │
└──────────────────────────────────────────────────────────────────────────┘
  │      │            │                          │   │              │
  │      │            └ global app menu (St.5)   │   │              └ date menu
  │      │                                       │   └ control center
  │      └ focused app (bold)                    └ spotlight (optional)
  └ system / logo menu
```

Mapping GNOME → macOS:

| macOS                | Backed by (GNOME)                                  |
|----------------------|----------------------------------------------------|
| Apple menu           | new `systemMenu.js` (logo user-configurable)       |
| App name (bold)      | `global.display.focus_window` + `Shell.WindowTracker` |
| File/Edit/View…      | *not implemented* — the bar shows the app name only |
| Wi-Fi status menu    | standalone `wifiMenu.js` + libnm                    |
| Battery status menu | standalone `batteryMenu.js` + UPower/power profiles |
| Control Center       | independent `controlCenter.js`; native QS fallback  |
| Notification Center  | native `dateMenu` (calendar + notifications), moved right |

Tahoe traits to honour:

- Menu bar background is **transparent** by default (our `tahoe-transparent`
  appearance mode; needs readable-text handling over arbitrary wallpapers).
- Items are transparent at rest; faint rounded wash on hover; slightly stronger
  when open. ~100–150ms transitions, high (pill) radius.
- Left = identity + app menus; right = status menus, control center, clock.

Window-state behaviour:

- **Fill / maximize:** the window fills the desktop work area below the menu bar;
  the menu bar and Dock remain visible. The transparent bar continues to expose
  the wallpaper rather than adopting the focused window's colour.
- **Full Screen:** the menu bar is hidden at rest and temporarily overlays the
  fullscreen app when the pointer reaches the top edge. It remains visible while
  a menu is being used, then hides again after the pointer leaves.
- In Automatic text mode, Tahoe chooses dark or light menu-bar content from the
  visible background rather than simply mirroring the system colour scheme.

Fonts: do **not** bundle SF Pro. Use
`font-family: "SF Pro Text", "Adwaita Sans", sans-serif;` so an installed SF Pro
is picked up, otherwise the system falls back.

### Reference captures

Native-resolution Tahoe screenshots now live in
[`docs/audits/tahoe-reference/`](audits/tahoe-reference/) — Notification Center,
Control Center (normal and editing), an open app menu and an open status menu.
Every file is 2880 x 1800, a 2x capture of a 1440 x 900 point screen, so
**1 point = 2 image pixels**. See that folder's
[`README.md`](audits/tahoe-reference/README.md) for the source, the scale check
and the measuring technique.

They supersede the video-frame capture the menu bar table below was measured
from (1.667 px/pt, blurred), and they resolve the missing raster that blocks the
final fidelity gate in `DESIGN_QA.md`.

### Notification Center measurements

Measured off `26-Tahoe-Notification-Center.png` at 1pt = 2px.

| Surface | Value |
|---------|-------|
| Card column width | 345 pt (card edges at x = 2160 and 2850 px) |
| Inset from the right screen edge | 15 pt |
| First card's top edge | 46 pt from the screen top (~22 pt below the 24 pt bar) |
| Gap between cards and widgets | **15 pt** (edges at y = 440/470 and 800/830 px) |
| Notification card height | 58 pt (two-line message), 74 pt (three-line banner) |
| Notification corner radius | ~18 pt |
| Notification app icon | 32 pt, 13.5 pt from the card's leading edge, ~14 pt before the text |
| Notification title / body | 13 pt semibold / 13 pt regular, 16 pt line pitch |
| "Notification Center" heading | ~18 pt bold (13 pt cap height), white on the wallpaper |
| Clear button | 20 pt circle, light glass with a dark ×, right-aligned to the column |
| Medium widget | 345 x 165 pt, corner radius ~24 pt, ~18 pt content inset |
| Weather widget | location 15 pt bold, temperature ~42 pt light, six hourly columns (time 11 pt, icon, temperature 13 pt semibold); sky gradient #2d5285 → #5e81ae |
| "Edit Widgets" pill | ~86 x 22 pt, 11 pt text, dark tinted glass, 16 pt below the last widget |
| Light notification material | ~60 % white over the (blurred) wallpaper; 1px brighter edge, almost no drop shadow |

Tahoe widget sizes follow the desktop grid: **small** is a ~165 pt square
(two share a row across the 15 pt gutter), **medium** is 345 x 165 and **large**
345 x 345. The first version of this table read the gap as ~8 pt and the card
heights as 30/38 pt; both were wrong, measured before the native capture was
edge-detected.

The structural point that matters most: **Notification Center has no container
of its own.** There is no panel background, no border and no shadow behind the
column — it is a stack of free-floating translucent cards over the wallpaper,
with the wallpaper visible in the gaps between them. A "Notification Center"
heading with an X button sits above the notification stack, and an "Edit
Widgets" pill closes the column at the bottom.

That is the opposite of GNOME's dateMenu, which is one opaque BoxPointer
containing everything. Any attempt to reproduce Notification Center by restyling
the dateMenu inherits the wrong structure, not just the wrong metrics.

### Menu bar measurements (measured, not estimated)

Taken from a macOS Tahoe capture rendered at 1.667 device px per point on a
2880 x 1800 panel, so **1 macOS point maps to 1 GNOME logical pixel** here.
Every figure below is the measured ink bounding box divided by that factor;
"gap" always means ink edge to ink edge, since that is what the eye reads.

| Surface                              | macOS Tahoe | Stock GNOME 50 |
|--------------------------------------|-------------|----------------|
| Bar height                           | 24 px       | 2.2em ≈ 32 px  |
| Menu bar text                        | 14 px (10.5pt), regular | 11pt, bold |
| App title weight                     | semibold    | bold           |
| Menu title cap/ascender ink          | 10–10.5 px  | —              |
| Menu title ink gap (File / Edit / …) | 22 px       | —              |
| Apple glyph ink                      | 13 x 15.5 px | 16px icon box |
| Apple glyph ink from screen edge     | 20.5 px     | ~8 px          |
| Status glyph box                     | 16 px       | 16 px (1.091em)|
| Status glyph ink gap                 | 17–19.5 px  | ≥ 20 px        |
| Status item pitch, centre to centre  | 36.7 px     | —              |
| Status item padding per side         | 10 px       | 12px + 6px icon padding + 4px icon margin |
| Clock ink → screen right edge        | 19.5 px     | ~14 px         |
| Date ↔ time gap inside the clock     | 7 px (two spaces) | —        |
| Narrow space before AM/PM            | 2.4 px (U+202F)   | —        |
| Control Center glyph ink             | ~12.5 x 12.5 px, two stacked toggle switches | — |
| Unread dot ink                       | ~5 px, 4 px after the Control Center glyph | 1.091em |

The two independent cross-checks that pin the padding: status items sit on a
36.7px pitch, which for a 16px glyph box means 10.3px per side; and 10px per
side plus the glyphs' side bearings reproduces the 22px ink gap between menu
titles. Both sides of the bar agree on the same number.

Those numbers drive the defaults: `panel-height 24`, `h-padding 10`,
`font-size-pt 10.5`, `font-weight normal`, a 16px status glyph with no padding
or margin of its own, an 8px inset on `#panelLeft` / `#panelRight`, and a 17px
Apple glyph (a 16px box renders about 14px of ink, one short of the reference).

> **Provenance.** The first version of this table was measured off a video frame
> at 1.667 px/pt and was wrong in one direction: blur inflated every glyph's ink
> extent, so each *gap between* glyphs came out ~2.5px short (menu title gaps
> read 19 instead of 22, the leading inset 18 instead of 20.5, the clock's
> trailing inset 17 instead of 19.5) and the text read 13px instead of 14.
> Vertical figures survived roughly intact. The table above is re-measured from
> `audits/tahoe-reference/26-Tahoe-Desktop.png`, a native 2x capture. Do not
> re-measure from resampled or video sources.

A caveat that cost real time: shell themes style the bar through
`#panel .panel-button`, which outranks `.lintel .panel-button`. Any metric
the extension sets must be anchored on `#panel.lintel` or the theme wins
silently — and the properties themes mark `!important` (panel height, button
border, the `.clock` label inset) need `!important` in return.

### System menu reference measurements

The supplied Tahoe capture is a 2×/Retina raster. Normalized to logical pixels,
the popup is approximately **316 × 317 px** with a **16 px** outer radius,
**14 px** leading icons, **14 px** body type, and **25 px** rows. It uses five
separators in this exact grouping:

1. About This System
2. System Settings / App Center
3. Recent Items
4. Force Quit
5. Sleep / Restart / Shut Down
6. Lock Screen / named Log Out

The material is light, translucent, and strongly blurred. The callout triangle
is absent, and the implementation intentionally omits shortcut glyphs.
The implementation's measured GNOME 50 preferred size is **316 × 318 px**.

MVP (Stage 7-complete) target:

```
◉  Firefox                              ⌨  ◉  WiFi 🔊 🔋  Mon 19:02
```

with Activities hidden, clock on the right, Quick Settings + notifications +
a11y + screen-share/record all still functional, and a clean disable().
