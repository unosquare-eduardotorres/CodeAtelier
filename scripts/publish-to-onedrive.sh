#!/bin/bash
# Publish build artifacts to OneDrive for auto-update distribution.
# Called automatically at the end of build-mac.sh / build-win.sh.
# Can also be run standalone: ./scripts/publish-to-onedrive.sh
#
# Safe to run twice — the manifest rewrite is idempotent and every publish ends
# with a verification pass that fails the step rather than leaving a feed that
# points at files which do not exist.
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
PATCH_SCRIPT="$ROOT/scripts/patch-feed-manifest.mjs"
COPIED=0
FEED_FILES=()

# ── Create version/platform subdirectories
WIN_DIR="$ONEDRIVE_DIR/$VERSION/win"
MAC_DIR="$ONEDRIVE_DIR/$VERSION/mac"
mkdir -p "$WIN_DIR" "$MAC_DIR"

# Read the `version:` field out of a channel manifest.
yml_version() {
  grep -m1 '^version:' "$1" 2>/dev/null \
    | sed -e 's/^version:[[:space:]]*//' -e "s/^['\"]//" -e "s/['\"]\$//" -e 's/[[:space:]]*$//'
}

# Copy + patch one channel manifest, but ONLY when it describes this build.
#
# dist/ is not cleaned between platforms: after a Windows build, dist/latest.yml
# describes the Windows release and survives into the next Mac build. Copying it
# unconditionally (as this script used to) rewrote the *previous* version's
# manifest body into the *current* version's URL path, producing a feed entry
# that could never resolve. Leave the other platform's channel file alone.
publish_manifest() {
  local channel="$1" platform="$2"
  local src="dist/${channel}"
  [ -f "$src" ] || return 0

  local found
  found="$(yml_version "$src")"
  if [ "$found" != "$VERSION" ]; then
    echo "  ⊘ ${channel} skipped — describes v${found:-unknown}, this build is v${VERSION}"
    return 0
  fi

  local refs
  if ! refs="$(node "$PATCH_SCRIPT" "$src" "$ONEDRIVE_DIR/${channel}" "$VERSION" "$platform")"; then
    echo "  ❌ Failed to patch ${channel}"
    exit 1
  fi

  while IFS= read -r ref; do
    [ -n "$ref" ] && FEED_FILES+=("$ref")
  done <<< "$refs"

  echo "  ✓ ${channel} (urls → ${VERSION}/${platform}/)"
  COPIED=$((COPIED + 1))
}

# ── Windows artifacts
WIN_EXE="dist/code-atelier-${VERSION}-setup.exe"
if [ -f "$WIN_EXE" ]; then
  cp -f "$WIN_EXE" "$WIN_DIR/"
  echo "  ✓ $(basename "$WIN_EXE") → $VERSION/win/ ($(du -h "$WIN_EXE" | cut -f1 | xargs))"
  COPIED=$((COPIED + 1))
fi
publish_manifest "latest.yml" "win"

# ── macOS artifacts
# electron-builder names the zip with spaces but writes the hyphenated "safe
# name" into latest-mac.yml. Publishing it verbatim made every Mac update 404 on
# download, so copy it under the name the manifest actually references.
MAC_ZIP=""
for candidate in dist/*"${VERSION}"*-mac.zip; do
  [ -f "$candidate" ] && MAC_ZIP="$candidate"
done
if [ -n "$MAC_ZIP" ]; then
  MAC_ZIP_SAFE="$(basename "$MAC_ZIP" | tr ' ' '-')"
  cp -f "$MAC_ZIP" "$MAC_DIR/$MAC_ZIP_SAFE"
  echo "  ✓ $MAC_ZIP_SAFE → $VERSION/mac/ ($(du -h "$MAC_ZIP" | cut -f1 | xargs))"
  COPIED=$((COPIED + 1))
fi
MAC_DMG="dist/code-atelier-${VERSION}.dmg"
if [ -f "$MAC_DMG" ]; then
  cp -f "$MAC_DMG" "$MAC_DIR/"
  echo "  ✓ $(basename "$MAC_DMG") → $VERSION/mac/ ($(du -h "$MAC_DMG" | cut -f1 | xargs))"
  COPIED=$((COPIED + 1))
fi
publish_manifest "latest-mac.yml" "mac"

# ── Verify the feed before declaring success
# A manifest referencing a file that is not there is worse than a failed build
# step: the build looks green and every client 404s until someone notices.
if [ "${#FEED_FILES[@]}" -gt 0 ]; then
  echo "  ▸ Verifying feed references..."
  MISSING=0
  for ref in "${FEED_FILES[@]}"; do
    if [ -f "$ONEDRIVE_DIR/$ref" ]; then
      echo "    ✓ $ref"
    else
      echo "    ❌ missing: $ref"
      MISSING=$((MISSING + 1))
    fi
  done
  if [ "$MISSING" -gt 0 ]; then
    echo "  ❌ Feed verification failed — $MISSING referenced file(s) missing under $ONEDRIVE_DIR"
    exit 1
  fi
fi

if [ $COPIED -eq 0 ]; then
  echo "  ⚠ No artifacts found in dist/ — nothing to publish"
else
  echo "  ✅ Published $COPIED artifact(s) to OneDrive (v${VERSION})"
  echo "  📁 $ONEDRIVE_DIR/$VERSION/{mac,win}/"
fi
