#!/bin/zsh
# Buduje Skarbiec dla macOS (Apple Silicon i Intel).
# Budowanie odbywa się w katalogu tymczasowym, bo foldery synchronizowane
# (Pulpit/Dokumenty w iCloud, OneDrive) dodają atrybuty Findera, które psują podpis aplikacji.
set -euo pipefail
cd "$(dirname "$0")"
OUT="$(mktemp -d -t skarbiec-build)"
npx electron-builder --mac "$@" -c.directories.output="$OUT"
mkdir -p dist
cp "$OUT"/*.dmg "$OUT"/*.zip dist/
rm -rf "$OUT"
echo "Gotowe: $(pwd)/dist"
ls -lh dist
