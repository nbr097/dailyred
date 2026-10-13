#!/usr/bin/env bash
# Builds the modified FireRed ROM with the project-local toolchain
# (see scripts/setup-macos.sh) and puts a gzipped copy in web/game/ for the website.
#
#   scripts/build-rom.sh            # normal build
#   scripts/build-rom.sh clean      # any extra args are passed to make
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TC="$ROOT/.toolchain"
GAME="$ROOT/pokefirered"

if [ ! -x "$TC/arm-none-eabi/bin/arm-none-eabi-gcc" ]; then
  echo "Toolchain missing. Run scripts/setup-macos.sh first."; exit 1
fi

# gbagfx asks pkg-config for libpng; clang also honours these variables,
# which lets it find our static libpng without pkg-config/Homebrew.
export CPATH="$TC/libpng/include${CPATH:+:$CPATH}"
export LIBRARY_PATH="$TC/libpng/lib${LIBRARY_PATH:+:$LIBRARY_PATH}"
# A no-op pkg-config so the tool Makefiles don't print "command not found".
export PATH="$ROOT/scripts/shims:$PATH"

JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

if [ "$#" -gt 0 ]; then
  make -C "$GAME" -j"$JOBS" TOOLCHAIN="$TC/arm-none-eabi" MODERN=1 "$@"
  exit 0
fi

make -C "$GAME" -j"$JOBS" TOOLCHAIN="$TC/arm-none-eabi" MODERN=1

ROM="$GAME/pokefirered_modern.gba"
# The website downloads a gzipped copy (16 MB -> ~5.5 MB, mostly 0xFF padding)
# and unpacks it in the browser, so it stays small on any static host.
mkdir -p "$ROOT/web/game"
rm -f "$ROOT/web/game/dailyred.gba"
gzip -9 -n -c "$ROM" > "$ROOT/web/game/dailyred.gba.gz"
# RED's battle sprite for the site's title card (from the decomp, like the ROM).
cp "$GAME/graphics/trainers/front_pics/red_front_pic.png" "$ROOT/web/game/red.png"
# Species, moves and items for the hidden team editor, parsed from the decomp.
node "$ROOT/scripts/build-editor-data.mjs"
# The version shown in the page footer: the commit, with "+" when the tree has
# uncommitted changes, and the build date.
VERSION="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
git -C "$ROOT" diff --quiet HEAD 2>/dev/null || VERSION="$VERSION+"
echo "$VERSION $(date +%Y-%m-%d)" > "$ROOT/web/game/version.txt"
echo
echo "Built $ROM"
echo "Website copy: web/game/dailyred.gba.gz ($(wc -c < "$ROOT/web/game/dailyred.gba.gz" | tr -d ' ') bytes)"
