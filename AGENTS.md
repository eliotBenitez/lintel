# Repository Guidelines

## Project Structure & Module Organization

`extension.js` is the minimal GNOME Shell lifecycle entry point, while `prefs.js` defines the libadwaita preferences UI. Core behavior belongs in `src/`: panel lifecycle and restoration live in `panelController.js` and `panelState.js`, GNOME-version internals are isolated under `src/compat/`, UI actors under `src/widgets/`, and backend integrations under `src/services/`. Keep settings definitions in `schemas/`, icons in `icons/`, developer checks in `tools/`, and design or test notes in `docs/`. `dist/` contains packaged output, not source.

## Build, Test, and Development Commands

- `glib-compile-schemas schemas/` recompiles GSettings after editing the schema XML.
- `./install.sh` compiles schemas and symlinks the checkout to `~/.local/share/gnome-shell/extensions/lintel@topbar`.
- `dbus-run-session -- gnome-shell --nested --wayland` starts the preferred isolated test shell.
- `gnome-extensions enable lintel@topbar` and `gnome-extensions disable lintel@topbar` exercise lifecycle behavior.
- `gnome-extensions prefs lintel@topbar` opens the live preferences UI.
- `journalctl --user -f -o cat /usr/bin/gnome-shell` watches for GJS errors and leaks.
- `tools/check-undefined-calls.py` reports calls to identifiers nothing declares
  or imports. Run it after any edit that deletes or moves code.

There is no automated build runner or test suite in this checkout. Do not treat the committed `schemas/gschemas.compiled` or archive in `dist/` as substitutes for source changes.

## Coding Style & Naming Conventions

Use modern GJS ES modules, four-space indentation, semicolons, and braces on the same line as declarations. Follow existing names: `PascalCase` for classes, `camelCase` for functions/files, `_leadingUnderscore` for internal fields, and `UPPER_SNAKE_CASE` for constants. Keep `extension.js` lifecycle-only. Route access to private `Main.panel` fields through `src/compat/panelAdapter.js`, and make enable/apply/destroy paths idempotent and reversible. No formatter or linter is configured, so match adjacent code.

## Testing Guidelines

Before loading anything, run both static checks. `gjs -m <file>` only validates
SYNTAX: a call to a helper that an edit deleted parses cleanly and then throws
`ReferenceError` at runtime, which puts the extension into ERROR state — and
because the Shell caches extension modules, recovering from that needs a full
session restart, not `disable`/`enable`. So also run
`tools/check-undefined-calls.py`, which catches exactly that.

Follow `docs/TESTING.md` in a GNOME 50 Wayland session; GNOME 51 compatibility should also be checked when available. At minimum, test enable/disable, preferences updating live, Overview, lock/unlock, notifications, fullscreen, and monitor changes. Run the documented 20-cycle stress check and confirm no repeated journal errors, duplicate `lintel-*` status roles, or leftover dynamic stylesheet.

## Commit & Pull Request Guidelines

Git history is absent from this checkout, so no repository-specific commit convention can be verified. Use short, imperative subjects such as `Fix clock restoration after unlock`, and keep each commit focused. Pull requests should describe user-visible behavior, affected GNOME versions, manual test results, and restoration behavior. Link relevant issues and include screenshots or a short recording for panel, popup, theme, or preferences changes.

## Project memory

Before starting work, read:

- docs/ARCHITECTURE.md
- docs/DECISIONS.md
- docs/PROJECT_MEMORY.md
- .ai/progress.md

After completing significant work:

1. Update `.ai/progress.md`.
2. Add important architectural discoveries to `docs/PROJECT_MEMORY.md`.
3. Add significant architectural decisions to `docs/DECISIONS.md`.

Do not write trivial information into project memory.

Memory should contain information that will be useful in future sessions.
