# Control Center design QA — 0.14.0

- Source visual truth: Apple's official Tahoe Control Center image:
  `https://www.apple.com/newsroom/images/2025/06/macos-tahoe-26-makes-the-mac-more-capable-productive-and-intelligent-than-ever/article/Apple-WWDC25-macOS-Tahoe-26-Control-Center-250609_big.jpg.large.jpg`
- **Source raster, resolved:**
  `docs/audits/tahoe-reference/26-Tahoe-Finder-Control-Center.png` — a native
  2880 x 1800 capture at 1 pt = 2 px, from the Aqua Screenshot Library. The
  Apple newsroom endpoint below was never locally capturable; this replaces it,
  and the comparison it blocked has now been run (Pass 3).
- Supplied pre-change baseline:
  `docs/audits/tahoe-control-center/01-current-control-center.png`
- Implementation screenshot:
  `docs/audits/tahoe-control-center/02-implementation-gnome50.png`
- Focused implementation crop:
  `docs/audits/tahoe-control-center/03-implementation-popup.png`
- Before/after comparison input:
  `docs/audits/tahoe-control-center/04-before-after.png`
- Viewport: 1024 × 768 px, GNOME Shell 50.4, device scale 1.
- Source pixels: 2880 x 1800 at 2 px per point. Density normalization is exact
  and needs no resampling: 1 macOS point maps to 1 GNOME logical pixel, so every
  reference figure below is directly comparable to a CSS px in `stylesheet.css`.
- Baseline pixels: 619 × 901 px. Its visible popup was cropped to 530 × 850 and
  normalized to 307 × 493 for progress comparison.
- Implementation pixels: 1024 × 768 px; popup allocation 334 × 493 px; focused
  crop 334 × 493 px; CSS content width 318 px.
- State: custom Control Center open, GNOME dark appearance, the user's actual
  wallpaper, Wi-Fi/Bluetooth/Dark Mode active, Focus inactive, no active MPRIS
  player.

## Findings

The gate is no longer blocked — Pass 3 ran the comparison that cleared it and
found five issues, three structural. Pass 4 fixes all five in source. What
remains is render certification, not a known defect.

## Full-view comparison history

### Pass 0 — supplied baseline and audit

- P1: every module used a dark uniform plate and a dominant 30% white outline.
- P1: Bluetooth and AirDrop looked active whether checked or not.
- P1: Now Playing separated a large placeholder glyph from title and transport.
- P2: hard-coded Cantarell and an 82% black shadow produced a heavy text halo.
- P2: Stage Manager and AirDrop used visibly misleading grid/Wi-Fi glyphs.
- P2: Sound ended with two competing speaker glyphs.

Fixes: introduced lighter Liquid Glass tokens with stronger diffusion and
restrained edge light; shared blue checked states; rebuilt media composition;
switched to Adwaita Sans; replaced the two approximate icons with installed
multitasking/transfer symbols; reduced Sound to one maximum-volume glyph.

Post-fix evidence: the right half of
`docs/audits/tahoe-control-center/04-before-after.png`.

### Pass 1 — first GNOME 50 render

- P2: the media/utility column ended 6 px above the connectivity column.
- P2: four expanding bottom actions rendered as 75 × 70 ovals.
- P2: the Display/Sound fill inherited GNOME's blue accent because obsolete
  slider theme properties were used.

Fixes: raised the media content height from 112 to 118 px, fixed bottom actions
at 69 × 69 px and centered the row, and replaced the obsolete properties with
`-barlevel-*` tokens.

Post-fix evidence: `docs/audits/tahoe-control-center/03-implementation-popup.png`
shows aligned primary baselines, equal circles and white slider fill.

### Pass 2 — real-wallpaper render

- P2: a 38% module tint allowed high-luminance wallpaper regions to compete
  with the Sound label and Edit Controls.

Fixes: raised the neutral material tint to 44%, set blur brightness to 0.80 and
strengthened only the small text shadow to 48%, while retaining the low-contrast
14% glass edge.

Post-fix evidence: `docs/audits/tahoe-control-center/02-implementation-gnome50.png`
shows the final popup over the same wallpaper as the supplied baseline, with no
cropping or persistent-control overflow.

### Pass 3 — normalized comparison against the native source

Basis: reference figures measured off
`docs/audits/tahoe-reference/26-Tahoe-Finder-Control-Center.png` by edge
detection (a card border shows as a column where most rows differ sharply from
their neighbour three pixels left), divided by 2 to reach points. Implementation
figures are read from the literal values in `stylesheet.css` and the composition
in `src/widgets/controlCenter.js`. **This is a source-to-source comparison, not
a render comparison** — see the caveat at the end.

Reference module width is corroborated by four independent full-width modules:
Display slider 293.0 pt, Sound slider 292.5, Wi-Fi row 291.0, utility row 289.0.

| Metric | Reference | Implementation | Drift |
|--------|-----------|----------------|-------|
| Module column width | 292 pt | 302 px (`.lintel-cc-content` 318 − 2 × 8 padding) | +10 |
| Primary column width | 137 / 141 pt (~139) | 146 px | +7 |
| Gap between the two columns | ~13 pt | 8 px (`.lintel-cc-primary` spacing) | −5 |
| Inset from the right screen edge | 13.5 pt | positioned by GNOME's boxpointer, not CSS | unmeasured |

- [P1] Bluetooth and AirDrop are the wrong shape.
  Location: `controlCenter.js`, `_radioRow`.
  Evidence: the reference stacks Wi-Fi, Bluetooth and AirDrop as three
  full-column-width capsules, each with a circular glyph, a name and a status
  line ("On", "Everyone"). The implementation puts Bluetooth and AirDrop side by
  side as two small buttons in a `lintel-cc-radio-row`.
  Impact: the densest, most recognisable part of the module is wrong at a glance.
  Fix: drop the radio row; stack all three as `lintel-cc-tile` capsules.

- [P1] Focus sits in the wrong group.
  Location: `controlCenter.js`, `connectivity.add_child(this._focusTile)`.
  Evidence: the reference places Focus as a wide capsule in the utility row,
  beside two circular buttons. The implementation puts it at the foot of the
  left connectivity column.
  Fix: move Focus into the utility row.

- [P1] The utility row is on the wrong side of the sliders.
  Location: `controlCenter.js`, content assembly order.
  Evidence: the reference order is columns → circular buttons + Focus → Display
  → Sound → Edit Controls. The implementation emits columns → Display → Sound →
  four circular buttons → Edit Controls.
  Fix: move the row above the two sliders.

- [P2] The module column is 10 px too wide and its columns are misproportioned.
  Location: `stylesheet.css`, `.lintel-cc-content`, `.lintel-cc-connectivity`,
  `.lintel-cc-primary-right`, `.lintel-cc-primary`.
  Evidence: the table above.
  Fix: content width 308 px (292 + 2 × 8 padding), columns 140 px, primary
  spacing 12 px.

- [P2] The bottom row has four circles where the reference has two.
  Location: `controlCenter.js`, `bottom`.
  Evidence: the reference default carries Dark Mode and Screenshot as circles
  plus the Focus capsule; the implementation adds Calculator and Timer.
  Impact: minor — macOS makes this row user-editable, so extra modules are
  defensible, but the default should match the default.

Caveat carried forward: this pass compares the reference against the source
values, which settles geometry and composition but cannot certify what actually
renders — material opacity over a real wallpaper, blur radius, glyph silhouettes
and typography still need a capture of the popup as drawn. The Shell's
Screenshot D-Bus API refuses calls from outside the Shell, so that capture has
to be supplied. The 0.14.0 crops listed at the top predate this version and were
not used as evidence here.

### Pass 4 — Pass 3 findings applied

All five findings are fixed in source.

| Finding | Change |
|---------|--------|
| P1 Bluetooth/AirDrop shape | `_radioRow` removed; both are now `CCTile` capsules stacked under Wi-Fi. AirDrop gets `toggle_mode = false` — it is navigation, and GNOME has no AirDrop state to latch. Bluetooth moved from `_setAction` to `_setTile`, so it now carries an On/Off status line like Wi-Fi. |
| P1 Focus placement | Moved out of the connectivity column into the new actions row. |
| P1 Row above the sliders | New `lintel-cc-actions` row is appended before `_brightCard`, so the order is columns → actions → Display → Sound → Edit Controls. |
| P2 Metrics | `.lintel-cc-content` 318 → **308** px, columns 146 → **140**, `.lintel-cc-primary` spacing 8 → **12**. Circles 69 → **62** px so a pair plus a 16px gap fills one 140px column. |
| P2 Four circles | Calculator and Timer dropped; the row is Dark Mode + Screenshot, matching the reference default. |

Dead code removed with them: `_launch()`, `_setAction()`, and the
`.lintel-cc-radio`, `.lintel-cc-radio-row` and `.lintel-cc-bottom` rules.

Known cosmetic deviation, deliberate: the reference AirDrop capsule shows a
status line ("Everyone"). Ours leaves it empty, because GNOME exposes no AirDrop
state and inventing one would put a false claim about the system in the UI.

Still uncertified: everything that only exists once drawn — material opacity
over a real wallpaper, blur radius, glyph silhouettes, typography, and whether
the new actions row balances optically. That needs a capture of the popup as
rendered, which the Shell will not let this session take.

### Pass 5 — first render measurement, and a corrected assumption

A capture of the popup as drawn was supplied at last
(2879 x 1799 device px, scale 1.6667, so 1 logical px = 1.6667 image px).
Measuring it overturned an assumption Pass 4 was built on.

**St's `width` is a content width, not a border box.** `padding` is added
*outside* it. Pass 4 set `.lintel-cc-content { width: 308px; padding: 8px }`
believing the modules would get 308 - 16 = 292. The render says otherwise:

| Measured on the render | Logical px |
|------------------------|-----------|
| Sound slider (full-width module) | 308.4 |
| Display slider, module edge to module edge | 309.4 |
| Wi-Fi capsule (one column) | 149.4 |

308 of declared width produced 308 of module. So the pre-Pass-4 value of 318 was
never 302 of module either — it was **318, i.e. 26px over the reference**, not
the 10px Pass 3 reported. Pass 3's drift figure for that row was wrong in the
same way, and is superseded here.

Second correction from the same render: the explicit `width: 140px` on
`.lintel-cc-connectivity` / `.lintel-cc-primary-right` does nothing, because
both boxes carry `x_expand: true` and grow to fill the content width. The
columns measured 149.4, which is `(308 - 12 gutter) / 2 = 148` plus edge-detection
bleed from their border and shadow — the declared 140 was simply ignored.

Fix: `.lintel-cc-content` 308 → **292**. The columns then land on
`(292 - 12) / 2 = 140` on their own, matching the reference without relying on a
width declaration that St overrides anyway.

Not yet re-measured: this correction landed after the supplied capture, so 292
is derived from the render rather than confirmed by one. One more capture closes
it.

Also visible in that capture, and NOT a defect in the new code: the bottom row
rendered as four narrow pills. The Shell was still running the pre-Pass-4
`controlCenter.js` from its module cache, which puts `.lintel-cc-bottom-action`
on those buttons — a class Pass 4 deleted. New CSS against old cached JS. It
resolves on the next session restart, which the new composition needs anyway.

### Pass 6 — render after a session restart: geometry closed, material open

Capture: 2879 x 1799 device px at scale 1.6667, taken 22 s after a Shell restart,
so `controlCenter.js` and the 292px width are both live (version reads 0.15.5).
No lintel entries in the journal since that restart.

**Geometry and composition pass.** Five independent full-width modules measure
290.4 / 291.0 / 291.0 / 293.4 / 293.4 logical px against a 291-293 pt reference.
The actions row decomposes exactly as designed and as the reference does:

```
circle 62.4 | gap 16.2 | circle ~62 | gutter 10.8 | Focus 140.4  = 292.2 total
```

Columns land on 140 with a 12px gutter without the (ignored) `width: 140px`
declaration, confirming the Pass 5 correction. Module order matches the source.

**Material does not pass.** Measured as mean |d/dx| — high-frequency energy that
a backdrop blur destroys — inside a module versus the wallpaper beside it:

| | inside a module | wallpaper alongside | ratio |
|--|--|--|--|
| macOS Tahoe (Sound) | 1.91 | 4.53 | **0.42** |
| lintel (Sound) | 2.75 | 2.31 | 1.19 |
| lintel (AirDrop capsule) | 6.04 | 1.02 | **5.9** |

The reference crushes backdrop detail to 42% of its surroundings. Ours passes it
through undiminished — the AirDrop row carries six times the edge energy of the
wall beside it, because the wallpaper's ink lines cross it sharply. `addGlassBlur`
attaches a `Shell.BlurEffect` in `BACKGROUND` mode with radius 46 and the effect
constructs without error (`Shell.BlurMode.BACKGROUND` exists on this build), so
the effect is applied and simply not compositing. Root cause not yet established;
candidates are BACKGROUND mode not resolving a backdrop for actors inside a
popup-menu paint pass, and interference from the separately installed
blur-my-shell. This is the dominant visual gap — without it the modules read as
flat grey plates rather than glass.

Remaining findings, in priority order:

- [P1] Backdrop blur absent — above.
- [P1] Active-state tinting is applied to the wrong element. **Corrected in
  Pass 7** — the first reading of this finding was incomplete. Zooming the
  reference Wi-Fi row shows the *whole capsule* turns blue when a toggle is on
  (Wi-Fi, Bluetooth and AirDrop are all solid blue there; Focus, being off,
  stays neutral), and the icon disc inverts to a white fill with a blue glyph.
  Only the disc was being tinted, and in the opposite direction.
- [P2] Now Playing is composed differently. The reference stacks artwork, then
  the title, then the transport row; `CCMediaCard` puts artwork and title on one
  row with transport beneath.
- [P2] The sliders have a protruding round knob. The reference fill simply ends —
  there is no handle. `-slider-handle-radius: 6px` should go to 0.
- [P3] Edit Controls reads as flat grey; the reference pill carries a visible
  outline and a tinted label.
- [P3] Focus shows an "Off" status line where the reference shows the label alone.
- [P3] The reference Sound module ends with a trailing output-picker button that
  we do not have. Optional — it is a module macOS lets you remove.

### Pass 7 — fixes, and one finding corrected on closer reading

**Blur re-architected, not just re-tuned.** Pass 6 assumed the blur was right in
principle and merely not compositing. Measuring *where* the reference blurs
showed the design was wrong too:

| Region of the reference | mean \|d/dx\| |
|--------------------------|--------------|
| inside the Display module | 0.42 |
| **gap between Display and Sound** | **0.79** |
| below Edit Controls | 0.56 |
| wallpaper beside the popup | 5.22 |

The gaps between modules are blurred as much as the modules are. macOS blurs a
rectangular **region** behind Control Center; we were attaching a
`Shell.BlurEffect` to each module separately, which would leave those gaps sharp
even once it started compositing. The four per-module calls and the one on Edit
Controls are gone; a single `addGlassBlur(this.menu.box)` now covers the popup,
and `addGlassBlur()` carries the measurement that justifies it.

**Active state corrected.** A zoom of the reference Wi-Fi row settled what Pass 6
described loosely: the capsule itself goes solid blue, and the icon disc inverts
to white-fill/blue-glyph. `.lintel-cc-tile:checked` now tints the capsule and
`.lintel-cc-tile-icon:checked` inverts the disc; the redundant
`.lintel-cc-focus` icon overrides are gone, since Focus follows the same rule.

**Slider handle removed.** `-slider-handle-radius` 6px → 0; the reference fill
ends without a grab handle.

**Focus status.** Shown only while active — the reference renders an inactive
Focus as a bare label, not "Off".

New finding from the same zoom:

- [P2] The Wi-Fi capsule's status line should carry the **network name**, not
  "On". The white bar in the reference is the screenshot author's redaction over
  their SSID. Not fixed: `controlCenter.js` talks to `services/connectivity.js`,
  which exposes only an enabled flag, while the SSID lives in `services/wifi.js`
  behind `activeNetwork` and is owned by `LintelWifiMenu`. Wiring it in means either
  sharing that service through `PanelController` or giving the popup a second
  libnm client — a design call, not a tweak.

Unverified: every change in this pass is CSS or one-line logic except the blur
move, and none of it has been seen rendered. The blur in particular may still not
composite — the re-architecture fixes the *design*, and whether
`Shell.BlurEffect` in BACKGROUND mode works at all inside a popup-menu paint pass
is still open. blur-my-shell remains installed and untested as an interferer;
that experiment is deliberately held back so it does not confound this one.

### Pass 8 — blur root cause: BoxPointer renders offscreen

The Pass 7 re-architecture changed nothing measurable. Inside/outside
high-frequency ratio for the Sound module: **1.19 before, 1.14 after**, against
the reference's 0.42. Moving the effect from five modules to the popup was
correct by the reference, but it was never going to make the blur composite.

**Root cause, from GNOME Shell 50's own source:**

```js
class BoxPointer extends St.Widget {
    _init(arrowSide, binProperties) {
        super._init();
        this.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
```

Every `PopupMenu` — ours included — is built on a `BoxPointer`, and every
BoxPointer renders its whole subtree into an **offscreen framebuffer**. A
`Shell.BlurEffect` in `BACKGROUND` mode samples what is behind the actor *in the
framebuffer it is painted into*. Inside that offscreen buffer there is nothing
behind our modules, so there is nothing to blur. This is structural, not a
tuning problem, and it explains why per-module and popup-level blur fail
identically.

Corroboration: GNOME Shell never uses `BACKGROUND` mode itself. Its single
`Shell.BlurEffect` use is the screen shield, which blurs in the default ACTOR
mode over a wallpaper copy it *owns*:

```js
const widget = new St.Widget({..., effect: new Shell.BlurEffect({name: 'blur'})});
const bgManager = new Background.BackgroundManager({container: widget, monitorIndex, ...});
```

**Two ways forward.**

1. *Own the wallpaper.* Copy the screen shield's pattern: an `St.Widget` holding
   a `Background.BackgroundManager` for the monitor, offset so the wallpaper
   lines up with the popup's screen position, blurred in ACTOR mode, clipped and
   placed behind the content. This is what blur-my-shell does for panels and it
   is the only approach that actually produces glass. Cost: real work, plus a
   dependency on `resource:///org/gnome/shell/ui/background.js` and on keeping
   the offset in sync with popup position, monitor changes and wallpaper
   changes — version-fragile internals, so it belongs behind `src/compat/`.
2. *Stop pretending.* Drop the blur and raise the module tint until the plates
   read as opaque frosted material. One value. It abandons the Tahoe material,
   but it fixes the concrete defect visible today: with a busy wallpaper the ink
   lines cut straight through the labels.

Not yet attempted: disabling blur-my-shell. It is no longer the leading
hypothesis — the offscreen-redirect finding explains the symptom completely and
does not depend on it.

**Everything else in Pass 7 verified on this render**, sampled from the capture:

| | before | after |
|--|--|--|
| Wi-Fi capsule body (on) | rgb(79,80,78) | **rgb(10,132,255)** = `#0a84ff` |
| Wi-Fi icon disc | rgb(12,133,255) | **rgb(255,255,255)** |
| Bluetooth capsule (off) | — | rgb(105,111,109), stays neutral |
| AirDrop capsule (not a toggle) | — | neutral |

Focus renders as a bare label, and the sliders have no handle.

### Pass 9 — wallpaper-backed blur implemented

Took the first of the two Pass 8 options: own a wallpaper copy and blur it in
ACTOR mode, the way the screen shield does.

- `src/compat/background.js` — the only place that touches
  `resource:///org/gnome/shell/ui/background.js`, per the repo's rule that
  version-fragile internals stay in `compat/`. Exposes `createManager()`
  (a monitor-sized wallpaper actor with `controlPosition: false`, so we place it
  ourselves), `monitorIndexFor()` and `monitorAt()`.
- `src/widgets/glassBackdrop.js` — `GlassBackdrop`, an `St.Widget` with
  `clip_to_allocation` holding that wallpaper actor, blurred by
  `Shell.BlurEffect` in the **default ACTOR mode**. ACTOR mode blurs the actor's
  own content, so an offscreen-redirected ancestor cannot break it — which is
  the whole point. The header carries the BoxPointer finding so nobody
  "optimises" it back to BACKGROUND mode.
- `withGlassBackdrop(content)` stacks backdrop and content in a `BinLayout` and
  returns the wrapper; `ControlCenter._buildPopup()` mounts that instead of
  adding content directly.

Alignment: on every `notify::allocation` the backdrop reads its own transformed
stage position and offsets the wallpaper actor by `monitor.x - stageX,
monitor.y - stageY`, so the slice showing through is the piece of wallpaper
genuinely behind the popup. The write is guarded against re-entry, since moving
a child from an allocation handler queues another relayout. Monitor changes drop
and rebuild the manager; a wallpaper swap re-runs the offset, because the
replacement actor arrives at 0,0.

`addGlassBlur()` and its `Shell` import are gone from `ccTile.js` — dead once the
BACKGROUND-mode approach was abandoned.

Blur radius 48 (times the theme scale factor, as the shell does) and brightness
0.82 are starting values carried over from the old code, not measured ones. They
are the two knobs to tune once this is seen rendered.

**Regression on first render, fixed.** The first build of this inflated the popup
to fill the entire screen. Cause: `Meta.BackgroundActor` is monitor-sized, and an
`St.Widget` reports its children's size as its own preference — so the backdrop
asked for the whole monitor, the `BinLayout` wrapper adopted that, and the popup
grew to match. `clip_to_allocation` was clipping correctly; the allocation itself
was wrong. Fixed by overriding `vfunc_get_preferred_width` and
`vfunc_get_preferred_height` to return `[0, 0]`, so the backdrop contributes
nothing to layout and fills whatever its sibling content asks for.

That is the failure mode to watch for in anything that puts an oversized actor
behind sized content: clipping controls what is *painted*, never what is
*requested*.

Both the implementation and the regression fix are confirmed on a render in
Pass 10.

### Pass 10 — the blur composites

Rendered, popup back to its proper size, and the material is glass.

Measured against each capture's own wallpaper beside the popup, which is the
fairest available normaliser given the two wallpapers differ:

| | before backdrop | after backdrop | reference |
|--|--|--|--|
| inside the Sound module | 0.53 | **0.42** | 0.37 |
| **gap between modules** | 0.25 | **0.04** | 0.15 |

The gap figure is the meaningful one: it is pure backdrop, with none of our own
labels, icons or borders mixed in. Backdrop detail dropped roughly six-fold. Ours
now blurs *more* than the reference (0.04 against 0.15), so if anything
`BLUR_RADIUS = 48` is slightly strong — but the two wallpapers have very
different spectral content, and chasing an exact numeric match across them would
be false precision. Left as is, and the constant is one line to change.

The "inside the module" row moved less because it is dominated by our own module
content, which sits above the backdrop and is not blurred at all. It is a poor
metric and should not be used to judge blur again.

**Remaining differences, and one honest caveat about them.** Our material reads
as dark neutral glass; the reference reads as blue-tinted glass that takes the
wallpaper's hue. Before treating that as a defect: **the reference capture is in
Light appearance and our render is in Dark.** macOS Control Center is a much
darker material in Dark mode, so our fixed `rgba(35, 41, 48, 0.44)` tint may
already be right for the appearance we are rendering. Certifying the tint needs a
Dark-appearance reference capture, which the library does not include.

Still open, unchanged by this pass:

- [P2] Wi-Fi capsule should carry the network name, not "On".
- [P2] Now Playing stacks artwork, title, transport in the reference; ours puts
  artwork and title on one row.
- [P3] Edit Controls outline, and the reference's trailing output-picker button
  on the Sound module.

### Pass 11 — the wallpaper copy was the wrong content

Pass 10 called the material a pass. It was not: it only looked right because
every capture so far was taken over an empty desktop.

Open the popup over a **maximized window** and the defect is obvious — a blurred
bedroom wallpaper floating on top of a dark editor, tied to nothing on screen.
The mechanism worked; the *content* was wrong. macOS blurs whatever is actually
behind the popup, window content included. A wallpaper copy can only ever be
right when the desktop happens to be what is behind.

This is a design error on my part, not a regression: I verified that the blur
composited and stopped there, having only ever tested against a bare desktop.
"Is it blurred" and "is it blurring the right thing" are different questions and
I only asked the first.

Fix: blur a live `Clutter.Clone` of `global.window_group` instead. Shell parents
the desktop `_backgroundGroup` into that group at the bottom with every window
above it, so it is precisely "everything behind the popup". Our popup lives in
`Main.uiGroup`, outside `window_group`, so the clone cannot contain the popup
itself and there is no recursion. The offset is simpler too: `window_group` sits
at the stage origin, so the shift is just the backdrop's negated stage position,
with no monitor arithmetic.

`src/compat/background.js` is deleted — with `Background.BackgroundManager` gone
the extension no longer reaches into that shell internal at all, which is a
smaller version-fragile surface than Pass 9 left behind.

Not yet seen rendered over a window; that is the case to check, not another bare
desktop.

### Pass 12 — backdrop removed

Dropped at the user's call, before the Pass 11 clone was ever seen rendered.

`src/widgets/glassBackdrop.js` is deleted and `ControlCenter._buildPopup()` adds
its content directly again. `src/compat/background.js` went with Pass 11. The
extension now attaches no blur to the Control Center at all; the modules carry
their `rgba(35, 41, 48, 0.44)` tint and text shadow and nothing else.

What the four passes settled, so this is not re-litigated from scratch:

- BACKGROUND-mode blur cannot work inside a popup — `BoxPointer` sets
  `OffscreenRedirect.ALWAYS` (Pass 8).
- Blurring a wallpaper copy composites correctly (Pass 10: backdrop detail
  between modules 0.25 → 0.04) but shows the wrong content whenever a window is
  behind the popup (Pass 11).
- Blurring a live `Clutter.Clone` of `global.window_group` is the only variant
  that shows the right content. It was implemented and removed unrendered; the
  code is not in the tree.

Consequence, since handled: over a busy wallpaper the ink lines crossed the
module labels. Fixed by the only lever left — the tint alpha. White text on
`rgba(35, 41, 48, a)` over a **white** wallpaper, the worst case, hits WCAG 4.5
at a = 0.635; the plates were at 0.44, giving 2.60. Raised to 0.72 (contrast
5.88), with hover/focus/active and the insensitive state moved by the same
steps, and secondary text from 74% to 85% white because on the new plate it
needs 81% to clear 4.5 itself.

`systemMenu.js` and `statusMenu.js` carried the same inert BACKGROUND-mode blur
on their own popups — same BoxPointer, same offscreen framebuffer. Both are now
stripped too, along with their `Shell` imports and effect-name constants, each
leaving a comment so the effect is not reinstated.

## Focused-region evidence

The 334 × 493 popup crop was reviewed separately because the 8–9.5 pt labels,
16–22 px symbolic icons, five-pixel tracks and focus/edge treatments are too
small for reliable inspection in the full 1024 × 768 capture. It confirms:

- matching lower baselines for the two primary columns;
- one clean metadata/transport hierarchy in Now Playing;
- equal bottom-control diameters and centered row margins;
- one leading and one trailing glyph per slider;
- white active slider fill and distinct blue toggle states;
- no clipped label, icon, handle or persistent action.

## Required fidelity surfaces

- Fonts and typography: Adwaita Sans is the installed system substitute; SF Pro
  is not installed. Primary labels are semibold 9.25–9.5 pt, statuses 8–8.25 pt,
  with restrained two-pixel contrast shadows. No wrapping or truncation is
  visible in the tested empty-media state. Exact SF optical-weight comparison is
  blocked by the missing target raster.
- Spacing and layout rhythm: 318 px content width, 146 px primary columns, 8 px
  gaps, 22/24 px long-surface radii and 69 px compact circles. Popup allocation
  is 334 × 493 and all persistent controls fit. The normalized progress image
  confirms the layout became denser and more regular.
- Colors and visual tokens: regular material is neutral `rgba(35,41,48,.44)`
  over a 46 px background blur at 0.80 brightness; edge light is 14%; active blue
  is `#0a84ff`; slider fill is white. The final wallpaper capture shows stable
  foreground separation across light, dark and detailed regions.
- Image quality and asset fidelity: MPRIS artwork continues to use the player's
  original image. All other controls use installed GNOME symbolic assets. No
  handcrafted SVG, CSS drawing, emoji or placeholder asset was introduced.
- Copy and content: Wi-Fi, Focus, Not Playing, Display, Sound and Edit Controls
  are unchanged and match the intended Control Center labels. AirDrop and Stage
  Manager remain accessible names for icon-only controls.

## Functional evidence

- JavaScript syntax check passed for every `.js` file.
- GNOME Shell 50.4 loaded version 0.14.0 as `ACTIVE` with no extension errors.
- The menu opened and mapped at `[690,32,1024,525]` in the 1024 × 768 viewport.
- The documented 20-cycle disable/enable stress run completed with the extension
  active and no Lintel JavaScript or stylesheet errors.
- After disable, `Main.panel.statusArea` contained only GNOME's original roles;
  no `lintel-*` role remained. Re-enable returned to `ACTIVE` and the extension API
  reported an empty error list.

## Implementation checklist

- ~~Restore the exact original Tahoe reference as a local raster.~~ Done —
  `docs/audits/tahoe-reference/`.
- ~~Normalize it to the implementation popup state and density.~~ Done — native
  2x, 1 pt = 1 logical px, no resampling needed.
- ~~Run the normalized comparison.~~ Done — Pass 3.
- ~~Fix the three P1 composition findings, then the two P2 metric findings.~~
  Done — Pass 4.
- ~~Supply a capture of the popup as rendered.~~ Done — Pass 5, which corrected
  the content width.
- ~~Supply one more capture after a session restart.~~ Done — Pass 6 closed
  geometry and composition.
- ~~Re-measure the high-frequency ratio.~~ Done — unchanged at 1.14, and Pass 8
  found why.
- ~~Choose between owning a blurred wallpaper copy and dropping the blur.~~
  Done — Pass 9 implements the wallpaper copy.
- ~~Capture the popup and re-measure the high-frequency ratio.~~ Done — Pass 10,
  the blur composites.
- ~~If the flat tint reads badly over busy wallpaper, raise the alpha.~~ Done —
  0.44 to 0.72, computed against the worst-case white wallpaper.
- Obtain a Dark-appearance Control Center reference before judging the module
  tint; the Light capture cannot settle it.
- Decide how the Wi-Fi capsule reaches an SSID, then work the P3 list.

## Follow-up polish

- P3: test active MPRIS artwork/title/artist truncation with a long real track.
- P3: test keyboard focus rings against both very light and very dark wallpapers.
- P3: replace navigation-to-settings behavior only when native detail backends
  exist; do not simulate Tahoe subpages with non-functional controls.

final result: geometry, composition and toggle states PASS on a live render.
Material is deliberately NOT Tahoe's: the backdrop blur was removed in Pass 12
after Pass 8-11 established that GNOME gives popups no usable one and that every
workaround means compositing a copy of the screen. The modules are flat tinted
plates, and over a busy wallpaper their labels compete with it. Two P2 and two
P3 findings remain.
