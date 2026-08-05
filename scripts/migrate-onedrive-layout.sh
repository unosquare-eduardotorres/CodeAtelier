#!/bin/bash
# One-time migration: Move existing flat OneDrive artifacts into version/platform folders.
#
# Before:  Code Atelier/code-atelier-1.0.60-setup.exe
# After:   Code Atelier/1.0.60/win/code-atelier-1.0.60-setup.exe
#
# Non-artifact files (BUGS.txt, RAM.jpg, .DS_Store) are left in place.
# The latest.yml / latest-mac.yml manifests are patched to point to the new paths.
#
# Run once, verify, then delete this script.
set -euo pipefail

# ── Resolve OneDrive path
ONEDRIVE_DIR=""
for candidate in "$HOME/Library/CloudStorage/OneDrive"*/Code\ Atelier; do
  if [ -d "$candidate" ]; then
    ONEDRIVE_DIR="$candidate"
    break
  fi
done

if [ -z "$ONEDRIVE_DIR" ]; then
  echo "✗ OneDrive 'Code Atelier' folder not found"
  exit 1
fi

echo "▸ Migrating flat artifacts in: $ONEDRIVE_DIR"
echo ""
MOVED=0

# ── Move Windows EXEs (pattern: code-atelier-X.Y.Z-setup.exe)
for exe in "$ONEDRIVE_DIR"/code-atelier-*-setup.exe; do
  [ -f "$exe" ] || continue
  filename=$(basename "$exe")
  # Extract version: code-atelier-1.0.60-setup.exe → 1.0.60
  version=$(echo "$filename" | sed 's/code-atelier-\(.*\)-setup\.exe/\1/')
  dest="$ONEDRIVE_DIR/$version/win"
  mkdir -p "$dest"
  mv -f "$exe" "$dest/"
  echo "  ✓ $filename → $version/win/"
  MOVED=$((MOVED + 1))
done

# ── Move macOS ZIPs (pattern: Code Atelier-X.Y.Z-arm64-mac.zip)
for zip in "$ONEDRIVE_DIR"/Code\ Atelier-*-arm64-mac.zip; do
  [ -f "$zip" ] || continue
  filename=$(basename "$zip")
  # Extract version: Code Atelier-1.0.61-arm64-mac.zip → 1.0.61
  version=$(echo "$filename" | sed 's/Code Atelier-\(.*\)-arm64-mac\.zip/\1/')
  dest="$ONEDRIVE_DIR/$version/mac"
  mkdir -p "$dest"
  mv -f "$zip" "$dest/"
  echo "  ✓ $filename → $version/mac/"
  MOVED=$((MOVED + 1))
done

# ── Move macOS DMGs (pattern: code-atelier-X.Y.Z.dmg)
for dmg in "$ONEDRIVE_DIR"/code-atelier-*.dmg; do
  [ -f "$dmg" ] || continue
  filename=$(basename "$dmg")
  # Extract version: code-atelier-1.0.61.dmg → 1.0.61
  version=$(echo "$filename" | sed 's/code-atelier-\(.*\)\.dmg/\1/')
  dest="$ONEDRIVE_DIR/$version/mac"
  mkdir -p "$dest"
  mv -f "$dmg" "$dest/"
  echo "  ✓ $filename → $version/mac/"
  MOVED=$((MOVED + 1))
done

# ── Patch latest.yml (Windows) to point into version subfolder
if [ -f "$ONEDRIVE_DIR/latest.yml" ]; then
  # Read the current version from the YAML
  yml_version=$(grep '^version:' "$ONEDRIVE_DIR/latest.yml" | awk '{print $2}')
  if [ -n "$yml_version" ]; then
    # Only patch if not already prefixed with a version path
    if ! grep -q "url: ${yml_version}/" "$ONEDRIVE_DIR/latest.yml"; then
      sed -i '' "s|url: |url: ${yml_version}/win/|g; s|path: |path: ${yml_version}/win/|g" "$ONEDRIVE_DIR/latest.yml"
      echo "  ✓ latest.yml patched (urls → ${yml_version}/win/)"
    else
      echo "  · latest.yml already patched — skipping"
    fi
  fi
fi

# ── Patch latest-mac.yml to point into version subfolder
if [ -f "$ONEDRIVE_DIR/latest-mac.yml" ]; then
  yml_version=$(grep '^version:' "$ONEDRIVE_DIR/latest-mac.yml" | awk '{print $2}')
  if [ -n "$yml_version" ]; then
    if ! grep -q "url: ${yml_version}/" "$ONEDRIVE_DIR/latest-mac.yml"; then
      sed -i '' "s|url: |url: ${yml_version}/mac/|g; s|path: |path: ${yml_version}/mac/|g" "$ONEDRIVE_DIR/latest-mac.yml"
      echo "  ✓ latest-mac.yml patched (urls → ${yml_version}/mac/)"
    else
      echo "  · latest-mac.yml already patched — skipping"
    fi
  fi
fi

echo ""
if [ $MOVED -eq 0 ]; then
  echo "  · No flat artifacts to migrate (already clean)"
else
  echo "  ✅ Migrated $MOVED artifact(s) into version/platform folders"
fi
echo ""
echo "  Resulting layout:"
find "$ONEDRIVE_DIR" -maxdepth 3 -not -name '.DS_Store' | sort | head -40
