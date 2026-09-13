#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later

set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
capture_tmp=$(mktemp -d)
trap 'rm -rf -- "$capture_tmp"' EXIT

output_dir="$repo_dir/docs/screenshots"

for command_name in gnome-extensions gnome-shell-test-tool magick; do
    if ! command -v "$command_name" >/dev/null; then
        echo "Missing required command: $command_name" >&2
        exit 1
    fi
done

mkdir -p "$output_dir"

(
    cd "$repo_dir"
    gnome-extensions pack . --force \
        --out-dir "$capture_tmp" \
        --extra-source=src \
        --schema=schemas/org.gnome.shell.extensions.lintel.gschema.xml \
        >/dev/null
)

NO_AT_BRIDGE=1 \
GTK_A11Y=none \
LINTEL_SCREENSHOT_DIR="$output_dir" \
dbus-run-session -- gnome-shell-test-tool --headless \
    --extension "$capture_tmp/lintel@topbar.shell-extension.zip" \
    "$repo_dir/tools/capture-screenshots.js"

magick "$output_dir/01-desktop.png" \
    -crop 1280x96+0+0 +repage "$output_dir/01-top-bar.png"
magick "$output_dir/02-control-center.png" \
    -crop 360x540+920+0 +repage "$output_dir/02-control-center-detail.png"
magick "$output_dir/03-notification-center.png" \
    -crop 360x690+920+30 +repage \
    "$output_dir/03-notification-center-detail.png"
magick "$output_dir/04-preferences.png" \
    -crop 920x650+180+40 +repage "$output_dir/04-preferences-window.png"

echo "Screenshots written to $output_dir"
