#!/bin/bash
# Build macOS installer — works around electron-builder OOM on large node_modules.
#
# Strategy: electron-builder's dependency resolver OOMs on large node_modules trees
# (~20x memory amplification per file during ASAR processing). We bypass it by:
#   1. Rebuilding native modules (better-sqlite3) against Electron headers ourselves
#   2. Stripping runtime-unnecessary files from node_modules
#   3. Temporarily removing `dependencies` from package.json so electron-builder
#      sees no node_modules to resolve (~290 files instead of ~6,000+)
#   4. Copying node_modules into the app bundle via afterPack hook (before signing)
#
# IMPORTANT: A trap guarantees dev-dependency restoration even if the build fails.
#
# NOTE: `--include=dev` is required on the restore step because NODE_ENV=production
# (common in CI and some shells) causes npm 11+ to default `omit=dev`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── macOS Notarization credentials ──────────────────────────────────────────
# electron-builder checks three credential methods in order:
#   1. APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID  (app-specific pwd)
#   2. APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER     (App Store Connect API)
#   3. APPLE_KEYCHAIN_PROFILE                                   (keychain — preferred)
#
# We use option 3: credentials stored via `xcrun notarytool store-credentials`.
# If APPLE_ID is set in the environment, electron-builder takes path 1 and
# demands APPLE_APP_SPECIFIC_PASSWORD — so we unset it to fall through.
unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD
export APPLE_KEYCHAIN_PROFILE="${APPLE_KEYCHAIN_PROFILE:-code-atelier}"

# Track whether we pruned, so the trap knows if restoration is needed.
PRUNED=false
BUILD_EXIT=0

restore_deps() {
  # Restore package.json if it was modified
  if [ -f "package.json.original" ]; then
    mv package.json.original package.json
    echo "  package.json restored"
  fi

  if [ "$PRUNED" = true ]; then
    echo ""
    echo "▸ Restore: Full dependencies"
    # Wipe and reinstall — plain `npm install` skips re-extraction when
    # package versions match, leaving .d.ts files deleted by the strip step.
    rm -rf node_modules
    npm install --include=dev
    echo "  node_modules restored (clean install)"
  fi
}
trap restore_deps EXIT

echo "▸ Step 1: Build (typecheck + electron-vite)"
npm run build

echo ""
echo "▸ Step 2: Prune to production dependencies"
npm prune --omit=dev
PRUNED=true

echo "  node_modules after prune: $(du -sh node_modules | cut -f1) ($(find node_modules -type f | wc -l | tr -d ' ') files)"

echo ""
echo "▸ Step 2b: Rebuild native modules against Electron headers"
# Must run BEFORE stripping electron/ (rebuild needs Electron headers info).
# better-sqlite3 is the only production native module that uses node-gyp.
# Prebuilt NAPI modules (if any survived prune) don't need rebuilding.
npx --yes @electron/rebuild \
  --version 41.7.0 \
  --module-dir "$ROOT" \
  --types prod \
  --force
echo "  Native modules rebuilt for Electron 41.7.0"

echo ""
echo "▸ Step 2c: Strip runtime-unnecessary files from node_modules"

# electron/ — not needed in packaged app (Electron IS the runtime).
# Survives prune because @electron-toolkit/* has it as a peerDependency.
rm -rf node_modules/electron

# Source maps — dev-only, never loaded at runtime
find node_modules -name '*.map' -type f -delete

# TypeScript definitions — compile-time only, never needed in packaged app
find node_modules \( -name '*.d.ts' -o -name '*.d.mts' \) -type f -delete

# Dangling symlinks — stripping packages (electron/, etc.) leaves broken
# symlinks in .bin/ and elsewhere. cp -a preserves them, and electron-builder's
# signing walk stats every entry — ENOENT on a dangling link aborts the build.
find node_modules -type l ! -exec test -e {} \; -delete 2>/dev/null
echo "  Cleaned dangling symlinks"

echo "  node_modules after strip: $(du -sh node_modules | cut -f1) ($(find node_modules -type f | wc -l | tr -d ' ') files)"

echo ""
echo "▸ Step 2d: Isolate node_modules from electron-builder"
# Strip dependencies from package.json so electron-builder's dependency
# resolver finds nothing to walk. Without this, it enumerates every file in
# node_modules, stats them, and builds rich in-memory structures — OOMing
# at 16GB+ even after stripping. The afterPack hook copies node_modules
# into the app bundle directly (bypassing the resolver).
cp package.json package.json.original
node -e "
const pkg = JSON.parse(require('fs').readFileSync('package.json','utf8'));
delete pkg.dependencies;
delete pkg.optionalDependencies;
require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));
"
echo "  dependencies stripped from package.json (afterPack will copy node_modules)"

echo ""
echo "▸ Step 3: Package with electron-builder"
# electron-builder now processes only out/ + resources/ + package.json (~290 files).
# asar: false — app loads from loose files in Resources/app/.
# npmRebuild: false — we rebuilt native modules in Step 2b.
# afterPack: copies node_modules + restores package.json in the app bundle.
set +e
NODE_OPTIONS="--max-old-space-size=8192" npx electron-builder --mac "$@"
BUILD_EXIT=$?
set -e

# Restore package.json immediately (trap also handles this as safety net).
if [ -f "package.json.original" ]; then
  mv package.json.original package.json
  echo "  package.json restored"
fi

# The EXIT trap handles full dep restoration automatically.

if [ $BUILD_EXIT -eq 0 ]; then
  echo ""
  echo "✅ Build complete — check dist/"
  ls -lh dist/*.dmg 2>/dev/null || ls -lh dist/mac-arm64/ 2>/dev/null || echo "  (check dist/ for output)"
else
  echo ""
  echo "❌ electron-builder failed with exit code $BUILD_EXIT"
  echo "  (dev dependencies will be restored by cleanup trap)"
  exit $BUILD_EXIT
fi
