#!/usr/bin/env bash
# Local install for development: compile the schema and symlink this tree into
# the user extensions dir. Re-run after moving/renaming the project.
set -euo pipefail

UUID="lintel@topbar"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

echo "==> Compiling GSettings schema"
glib-compile-schemas "${SRC}/schemas"

echo "==> Compiling translations"
while IFS= read -r po_file; do
    language="$(basename "${po_file}" .po)"
    locale_dir="${SRC}/locale/${language}/LC_MESSAGES"
    mkdir -p "${locale_dir}"
    msgfmt --check --output-file="${locale_dir}/${UUID}.mo" "${po_file}"
done < <(find "${SRC}/po" -maxdepth 1 -type f -name '*.po' -print | sort)

echo "==> Linking ${SRC} -> ${DEST}"
mkdir -p "$(dirname "${DEST}")"
rm -rf "${DEST}"
ln -s "${SRC}" "${DEST}"

echo "==> Installed ${UUID}"
cat <<'EOF'

Next:
  # X11: restart the shell with Alt+F2 → r
  # Wayland: log out/in, OR test in a nested session (recommended):
  dbus-run-session -- gnome-shell --nested --wayland

  gnome-extensions enable lintel@topbar
  gnome-extensions disable lintel@topbar

Watch for errors:
  journalctl --user -f -o cat /usr/bin/gnome-shell
EOF
