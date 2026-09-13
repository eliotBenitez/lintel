# Architectural Decisions

## Keep translucent notification cards while masking collapsed stack content

The Notification Center retains translucent Tahoe-style message surfaces while
groups are expanded. The center observes GNOME's native stack pseudo-classes,
sets the inner content actor of background messages to zero opacity, and makes
only collapsed stack layers opaque. Expanding a group restores the captured
content opacity and removes the front-card mask. This preserves native group
geometry and interaction without allowing complete background rectangles to
show through one another.

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
