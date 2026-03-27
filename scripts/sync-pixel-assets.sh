#!/bin/bash
# Sync sprite assets from pixel-agents submodule to our renderer assets
# Run after: git submodule update --remote vendor/pixel-agents

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

SRC="$PROJECT_ROOT/vendor/pixel-agents/webview-ui/public/assets"
DEST="$PROJECT_ROOT/src/renderer/src/assets/pixel-office"

if [ ! -d "$SRC" ]; then
  echo "Error: pixel-agents submodule not found at $SRC"
  echo "Run: git submodule update --init vendor/pixel-agents"
  exit 1
fi

echo "Syncing pixel office assets..."

mkdir -p "$DEST/characters" "$DEST/floors" "$DEST/walls" "$DEST/furniture"

# Characters (6 sprite sheets)
cp -r "$SRC/characters/"* "$DEST/characters/" 2>/dev/null && echo "  ✓ Characters synced" || echo "  ⚠ No character assets found"

# Floor tiles
cp -r "$SRC/floors/"* "$DEST/floors/" 2>/dev/null && echo "  ✓ Floors synced" || echo "  ⚠ No floor assets found"

# Wall tiles
cp -r "$SRC/walls/"* "$DEST/walls/" 2>/dev/null && echo "  ✓ Walls synced" || echo "  ⚠ No wall assets found"

# Furniture (directories with PNGs inside)
cp -r "$SRC/furniture/"* "$DEST/furniture/" 2>/dev/null && echo "  ✓ Furniture synced" || echo "  ⚠ No furniture assets found"

# Default layout
if [ -f "$SRC/default-layout-1.json" ]; then
  cp "$SRC/default-layout-1.json" "$DEST/default-layout.json"
  echo "  ✓ Default layout synced"
fi

echo ""
echo "Pixel office assets synced to: $DEST"
echo "Characters: $(ls "$DEST/characters/" 2>/dev/null | wc -l | tr -d ' ') files"
echo "Floors:     $(ls "$DEST/floors/" 2>/dev/null | wc -l | tr -d ' ') files"
echo "Walls:      $(ls "$DEST/walls/" 2>/dev/null | wc -l | tr -d ' ') files"
echo "Furniture:  $(ls "$DEST/furniture/" 2>/dev/null | wc -l | tr -d ' ') dirs"
