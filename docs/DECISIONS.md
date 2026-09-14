# Architectural Decisions

## Keep translucent notification cards while masking collapsed stack content

The Notification Center retains translucent Tahoe-style message surfaces while
groups are expanded. The center observes GNOME's native stack pseudo-classes,
sets the inner content actor of background messages to zero opacity, and makes
only collapsed stack layers opaque. Expanding a group restores the captured
content opacity and removes the front-card mask. This preserves native group
geometry and interaction without allowing complete background rectangles to
show through one another.

## Control Center controls flow on a cell grid and are user-editable

The Control Center used hand-built columns (Wi-Fi/Bluetooth/AirDrop left, Now
Playing and utilities right, then a circles + Focus row). Hiding a control whose
hardware is missing — Bluetooth on most desktops — left a visible hole, and the
arrangement could not be changed. Controls are now listed in a user-editable
order and packed by `CCGrid` onto four cells per row, densely and row-major, the
way macOS fills its own grid. Every toggle is one `CCTile` with two sizes
(circle 1×1, capsule 2×1), so a single control can be removed or resized; the
default order reproduces the Tahoe reference unchanged. A capsule next to an
empty half takes the full width.

The grid is a custom `Clutter.LayoutManager`. A first version nested BoxLayouts
(two 140px columns), which cannot express a 1×1 circle as its own control and
had to re-parent actors on every rearrangement. `Clutter.GridLayout` was also
rejected: the half/pair gaps are unequal (16 vs 12) and would have moved out of
`stylesheet.css`. Editing happens in place in the popup, matching Tahoe and
Lintel's own "Edit Widgets", rather than in the preferences window. Rejected for
missing hardware: stretching the remaining capsules to fill a column (tall
capsules match nothing in the reference) and placeholders (a control that can
never work).

## Rename the project from Mac Panel to Lintel

The extension is now **Lintel** (`lintel@topbar`, schema
`org.gnome.shell.extensions.lintel`, gettext domain `lintel@topbar`, CSS prefix
`lintel-`, status roles `lintel-*`, widget classes `Lintel*`). "Mac" and "Tahoe"
are Apple trademarks and poor fits for an extensions.gnome.org listing; the name
describes the beam over a doorway, which matches the prime directive of carrying
a layout over the native panel without replacing it. "macOS" stays in prose
where it names the design reference. The code does not migrate settings: an
existing install starts with an empty `/org/gnome/shell/extensions/lintel/`
unless the old path is copied with `dconf dump … | dconf load …`. `dist/` still
holds the pre-rename package.
