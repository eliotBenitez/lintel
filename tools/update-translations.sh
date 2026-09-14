#!/usr/bin/env bash
# Regenerate the gettext template, merge catalogues and compile runtime files.
set -euo pipefail

DOMAIN="lintel@topbar"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POT="${ROOT}/po/${DOMAIN}.pot"

cd "${ROOT}"
mapfile -d '' SOURCES < <(
    find src -type f -name '*.js' -print0 | sort -z
)

xgettext \
    --language=JavaScript \
    --from-code=UTF-8 \
    --keyword=_ \
    --keyword=ngettext:1,2 \
    --keyword=pgettext:1c,2 \
    --add-comments=TRANSLATORS \
    --package-name="Lintel" \
    --package-version="0.17.1" \
    --output="${POT}" \
    prefs.js \
    po/metadata.js.in \
    "${SOURCES[@]}"

while IFS= read -r po_file; do
    msgmerge --quiet --update --backup=none "${po_file}" "${POT}"
    language="$(basename "${po_file}" .po)"
    locale_dir="${ROOT}/locale/${language}/LC_MESSAGES"
    mkdir -p "${locale_dir}"
    msgfmt --check --output-file="${locale_dir}/${DOMAIN}.mo" "${po_file}"
done < <(find "${ROOT}/po" -maxdepth 1 -type f -name '*.po' -print | sort)
