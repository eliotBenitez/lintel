# adapters/

Declarative descriptors for third-party extensions the Control Center can drive
directly. An adapter never imports the other extension's code and never reaches
for its `stateObj` — that breaks on their next release and is not something we
want to ship. The contract is whatever *public* channel their author provides:
a GSettings key, or a D-Bus property.

| File | Extension | Contract |
|------|-----------|----------|
| `caffeine.js` | `caffeine@patapon.info` | `org.gnome.shell.extensions.caffeine` → `cli-toggle` (read = live inhibit state, write = level-set). |

## Writing one

| Field | Purpose |
|-------|---------|
| `id` | Stable key for our own bookkeeping. |
| `uuid` | Checked against `Main.extensionManager.lookup()`; no adapter runs unless that extension is `ACTIVE`. |
| `schemaId` | Looked up in the extension's `schemas/` dir, falling back to the default source. **Never** construct `Gio.Settings` from a bare `schema_id` — a missing schema aborts the whole Shell process. |
| `title` | What *we* show. Ours to choose, on-design. |
| `gettextDomain` + `titleMsgid` | Used to resolve the extension's own Quick Settings tile label in the current locale, so the adapter's capsule supersedes that tile instead of duplicating it. Omit when the extension has no tile. |
| `iconNames.on/.off`, `fallbackIconName` | Icon names; extension-shipped icons resolve because GNOME adds their `icons/` dir to the theme search path. |
| `watchKeys` | Keys whose changes should refresh the capsule. |
| `read(settings)` → bool, `write(settings, active)`, `subtitle(active)` | The behaviour. |

Verify the read/write semantics against the extension's source before adding it
— "the key that mirrors state" and "the key that sets state" are not always the
same one — and record what you verified, with a version, in the file header.
