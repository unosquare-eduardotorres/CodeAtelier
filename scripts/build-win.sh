#!/bin/bash
# Build Windows NSIS installer — cross-compiled from macOS.
#
# Mirrors build-mac.sh's OOM-prevention strategy:
#   1. Stripping runtime-unnecessary files from node_modules
#   2. Temporarily removing `dependencies` from package.json so electron-builder
#      sees no node_modules to resolve (~290 files instead of ~6,000+)
#   3. Copying node_modules into the app bundle via afterPack hook
#
# With better-sqlite3 v13 (N-API), no platform-specific rebuild is needed —
# prebuilt binaries for win32-x64 are shipped in the npm package.
#
# IMPORTANT: A trap guarantees dev-dependency restoration even if the build fails.
#
# NOTE: Does NOT bump version — run build:mac first for version bumps,
# or pass BUMP_VERSION=1 to bump here.
set -euo pipefail

if [ "${NODE_ENV:-}" = "production" ]; then
  echo "⚠️  NODE_ENV=production detected — restore step will use --include=dev to override"
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PRUNED=false
BUILD_EXIT=0

restore_deps() {
  if [ -f "package.json.original" ]; then
    mv package.json.original package.json
    echo "  package.json restored"
  fi

  if [ "$PRUNED" = true ]; then
    echo ""
    echo "▸ Restore: Full dependencies"
    rm -rf node_modules
    npm install --include=dev
    echo "  node_modules restored (clean install)"
  fi
}
trap restore_deps EXIT

echo "▸ Step 1: Build (typecheck + electron-vite)"
npm run build

echo ""
if [ "${BUMP_VERSION:-}" = "1" ]; then
  echo "▸ Step 1b: Bump patch version"
  OLD_VERSION="$(node -p "require('./package.json').version")"
  npm version patch --no-git-tag-version >/dev/null
  NEW_VERSION="$(node -p "require('./package.json').version")"
  echo "  Version bumped: ${OLD_VERSION} → ${NEW_VERSION}"
else
  echo "▸ Step 1b: Skip version bump (use BUMP_VERSION=1 to enable)"
  echo "  Current version: $(node -p "require('./package.json').version")"
fi

echo ""
echo "▸ Step 2: Prune to production dependencies"
npm prune --omit=dev
PRUNED=true

echo "  node_modules after prune: $(du -sh node_modules | cut -f1) ($(find node_modules -type f | wc -l | tr -d ' ') files)"

echo ""
echo "▸ Step 2a: Strip unused platform prebuilts"
# better-sqlite3 v13 ships N-API prebuilts for ALL platforms (~16MB).
# Keep only the Windows x64 binary (covers ~99% of Windows targets).
KEEP_PREBUILT="win32-x64.node"
find node_modules/better-sqlite3/prebuilds -name '*.node' ! -name "$KEEP_PREBUILT" -delete 2>/dev/null
echo "  Kept only $KEEP_PREBUILT prebuilt"

echo ""
echo "▸ Step 2c: Strip runtime-unnecessary files from node_modules"

rm -rf node_modules/electron

find node_modules -name '*.map' -type f -delete

find node_modules \( -name '*.d.ts' -o -name '*.d.mts' \) -type f -delete

find node_modules -type l ! -exec test -e {} \; -delete 2>/dev/null
echo "  Cleaned dangling symlinks"

echo "  node_modules after strip: $(du -sh node_modules | cut -f1) ($(find node_modules -type f | wc -l | tr -d ' ') files)"

echo ""
echo "▸ Step 2d: Isolate node_modules from electron-builder"
cp package.json package.json.original
node -e "
const pkg = JSON.parse(require('fs').readFileSync('package.json','utf8'));
delete pkg.dependencies;
delete pkg.optionalDependencies;
require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));
"
echo "  dependencies stripped from package.json (afterPack will copy node_modules)"

echo ""
echo "▸ Step 3: Package with electron-builder (Windows NSIS)"
set +e
NODE_OPTIONS="--max-old-space-size=16384" npx electron-builder --win --x64 "$@"
BUILD_EXIT=$?
set -e

if [ -f "package.json.original" ]; then
  mv package.json.original package.json
  echo "  package.json restored"
fi

if [ $BUILD_EXIT -eq 0 ]; then
  echo ""
  echo "▸ Step 3b: Verify packaged app native bindings"
  APP_DIR="dist/win-unpacked"
  if [ ! -d "$APP_DIR" ]; then
    echo "  ⚠ Could not locate win-unpacked directory in dist/ — skipping"
  else
    APP_NM="$APP_DIR/resources/app/node_modules"
    PACKAGED_PREBUILT="$APP_NM/better-sqlite3/prebuilds/$KEEP_PREBUILT"
    if [ -f "$PACKAGED_PREBUILT" ]; then
      echo "  ✅ N-API prebuilt present in app bundle ($KEEP_PREBUILT)"
    else
      echo "  ❌ N-API prebuilt MISSING from app bundle"
      BUILD_EXIT=1
    fi
  fi
fi

if [ $BUILD_EXIT -eq 0 ]; then
  echo ""
  echo "✅ Build complete — check dist/"
  ls -lh dist/*-setup.exe 2>/dev/null || ls -lh dist/win-unpacked/ 2>/dev/null || echo "  (check dist/ for output)"
else
  echo ""
  echo "❌ electron-builder failed with exit code $BUILD_EXIT"
  echo "  (dev dependencies will be restored by cleanup trap)"
  exit $BUILD_EXIT
fi

# ── Step 4: Publish to OneDrive (auto-update distribution)
if [ $BUILD_EXIT -eq 0 ] && [ "${SKIP_PUBLISH:-}" != "1" ]; then
  bash "$ROOT/scripts/publish-to-onedrive.sh"
fi
