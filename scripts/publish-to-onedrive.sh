#!/bin/bash
# Publish build artifacts to OneDrive for auto-update distribution.
# Called automatically at the end of build-mac.sh / build-win.sh.
# Can also be run standalone: ./scripts/publish-to-onedrive.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Resolve OneDrive path
ONEDRIVE_DIR=""
for candidate in "$HOME/Library/CloudStorage/OneDrive"*/Code\ Atelier; do
  if [ -d "$candidate" ]; then
    ONEDRIVE_DIR="$candidate"
    break
  fi
done

if [ -z "$ONEDRIVE_DIR" ]; then
  echo "⚠ OneDrive 'Code Atelier' folder not found — skipping publish"
  echo "  Expected at: ~/Library/CloudStorage/OneDrive-*/Code Atelier"
  exit 0  # Non-fatal — build still succeeded
fi

echo ""
echo "▸ Publishing artifacts to OneDrive: $ONEDRIVE_DIR"

VERSION=$(node -e "console.log(require('./package.json').version)")
COPIED=0

# ── Create version/platform subdirectories
WIN_DIR="$ONEDRIVE_DIR/$VERSION/win"
MAC_DIR="$ONEDRIVE_DIR/$VERSION/mac"
mkdir -p "$WIN_DIR" "$MAC_DIR"

# ── Windows artifacts
WIN_EXE="dist/code-atelier-${VERSION}-setup.exe"
if [ -f "$WIN_EXE" ]; then
  cp -f "$WIN_EXE" "$WIN_DIR/"
  echo "  ✓ $(basename "$WIN_EXE") → $VERSION/win/ ($(du -h "$WIN_EXE" | cut -f1 | xargs))"
  COPIED=$((COPIED + 1))
fi
if [ -f "dist/latest.yml" ]; then
  cp -f "dist/latest.yml" "$ONEDRIVE_DIR/latest.yml"
  # Patch url/path fields to point into the version/platform subfolder
  # e.g. "url: code-atelier-1.0.61-setup.exe" → "url: 1.0.61/win/code-atelier-1.0.61-setup.exe"
  sed -i '' "s|url: |url: ${VERSION}/win/|g; s|path: |path: ${VERSION}/win/|g" "$ONEDRIVE_DIR/latest.yml"
  echo "  ✓ latest.yml (patched urls → $VERSION/win/)"
  COPIED=$((COPIED + 1))
fi

# ── macOS artifacts
MAC_ZIP=$(ls -1 dist/Code\ Atelier-*-arm64-mac.zip 2>/dev/null | sort -V | tail -1)
if [ -n "$MAC_ZIP" ]; then
  cp -f "$MAC_ZIP" "$MAC_DIR/"
  echo "  ✓ $(basename "$MAC_ZIP") → $VERSION/mac/ ($(du -h "$MAC_ZIP" | cut -f1 | xargs))"
  COPIED=$((COPIED + 1))
fi
MAC_DMG="dist/code-atelier-${VERSION}.dmg"
if [ -f "$MAC_DMG" ]; then
  cp -f "$MAC_DMG" "$MAC_DIR/"
  echo "  ✓ $(basename "$MAC_DMG") → $VERSION/mac/ ($(du -h "$MAC_DMG" | cut -f1 | xargs))"
  COPIED=$((COPIED + 1))
fi
if [ -f "dist/latest-mac.yml" ]; then
  cp -f "dist/latest-mac.yml" "$ONEDRIVE_DIR/latest-mac.yml"
  # Patch url/path fields to point into the version/platform subfolder
  # e.g. "url: Code Atelier-1.0.61-arm64-mac.zip" → "url: 1.0.61/mac/Code Atelier-1.0.61-arm64-mac.zip"
  sed -i '' "s|url: |url: ${VERSION}/mac/|g; s|path: |path: ${VERSION}/mac/|g" "$ONEDRIVE_DIR/latest-mac.yml"
  echo "  ✓ latest-mac.yml (patched urls → $VERSION/mac/)"
  COPIED=$((COPIED + 1))
fi

if [ $COPIED -eq 0 ]; then
  echo "  ⚠ No artifacts found in dist/ — nothing to publish"
else
  echo "  ✅ Published $COPIED artifact(s) to OneDrive (v${VERSION})"
  echo "  📁 $ONEDRIVE_DIR/$VERSION/{mac,win}/"
fi
