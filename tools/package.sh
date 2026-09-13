#!/usr/bin/env bash
# Build the installable zip (GitHub releases, extensions.gnome.org) into dist/.
set -euo pipefail

UUID="lintel@topbar"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${ROOT}/dist"

mkdir -p "${OUT}"
gnome-extensions pack "${ROOT}" \
    --force \
    --out-dir="${OUT}" \
    --extra-source=src \
    --extra-source=icons \
    --extra-source=LICENSE \
    --schema=schemas/org.gnome.shell.extensions.lintel.gschema.xml \
    --podir=po \
    --gettext-domain="${UUID}"

echo "==> ${OUT}/${UUID}.shell-extension.zip"
