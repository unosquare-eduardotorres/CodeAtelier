#!/bin/bash
# Build macOS installer — works around electron-builder OOM on large node_modules.
#
# Strategy: electron-builder's dependency resolver OOMs on large node_modules trees
# (~20x memory amplification per file during ASAR processing). We bypass it by:
#   1. Stripping runtime-unnecessary files from node_modules
#   2. Temporarily removing `dependencies` from package.json so electron-builder
#      sees no node_modules to resolve (~290 files instead of ~6,000+)
#   3. Copying node_modules into the app bundle via afterPack hook (before signing)
#
# With better-sqlite3 v13 (N-API), no Electron-specific rebuild is needed —
# the same prebuilt binary works under both system Node.js and Electron.
#
# IMPORTANT: A trap guarantees dev-dependency restoration even if the build fails.
#
# NOTE: `--include=dev` is required on the restore step because NODE_ENV=production
# (common in CI and some shells) causes npm 11+ to default `omit=dev`.
set -euo pipefail

# ── Warn if NODE_ENV=production could affect the restore
if [ "${NODE_ENV:-}" = "production" ]; then
  echo "⚠️  NODE_ENV=production detected — restore step will use --include=dev to override"
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Augment PATH for @opencode-ai/cli installation
# The OpenCode CLI is installed globally and needs to be in PATH for the app to spawn it.
# Add Homebrew bin directories and npm global bin to PATH before running npm commands.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$PATH"

# ── Verify OpenCode CLI is available before build
echo "▸ Verify OpenCode CLI installation:"
if command -v opencode &>/dev/null; then
  which opencode
  opencode --version || true
  echo "OpenCode CLI found and available"
else
  echo "WARNING: OpenCode CLI not found. Install with: npm install -g @opencode-ai/cli"
  echo "This may cause spawn errors when building the app."
fi

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

# ── Build lock ──────────────────────────────────────────────────────────────
# This script mutates shared state (node_modules, package.json) and its trap
# does `rm -rf node_modules`. Two builds in the same tree corrupt each other:
# the macOS strip step deletes win32-x64.node, so a Windows build packaging
# concurrently ships an installer with no SQLite binding (Step 3b catches it,
# but only after several minutes of packaging and signing).
# mkdir is atomic, so it doubles as the lock acquire.
LOCKDIR="$ROOT/.build-lock"
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  echo "❌ Another build is already running in this tree."
  echo "   Builds mutate node_modules/package.json and cannot run concurrently —"
  echo "   run platform builds sequentially (build:mac, then build:win)."
  echo "   If no build is actually running, clear the stale lock:"
  echo "     rm -rf \"$LOCKDIR\""
  exit 1
fi

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

  rm -rf "$LOCKDIR"
}
trap restore_deps EXIT

echo "▸ Step 1: Build (typecheck + electron-vite)"
npm run build

echo ""
echo "▸ Step 1b: Bump patch version"
# Persistent patch bump. --no-git-tag-version skips git commit/tag AND the
# clean-working-tree check, updating package.json + package-lock.json in place.
# The bumped package.json is captured by the Step 2d backup and restored by the
# EXIT trap, so the new version survives the build (ready to commit later).
# Escape hatch: SKIP_VERSION_BUMP=1 npm run build:mac  (re-build without bumping).
if [ "${SKIP_VERSION_BUMP:-}" = "1" ]; then
  echo "  SKIP_VERSION_BUMP=1 — keeping version $(node -p "require('./package.json').version")"
else
  OLD_VERSION="$(node -p "require('./package.json').version")"
  npm version patch --no-git-tag-version >/dev/null
  NEW_VERSION="$(node -p "require('./package.json').version")"
  echo "  Version bumped: ${OLD_VERSION} → ${NEW_VERSION}"
fi

echo ""
echo "▸ Step 2: Prune to production dependencies"
npm prune --omit=dev
PRUNED=true

echo "  node_modules after prune: $(du -sh node_modules | cut -f1) ($(find node_modules -type f | wc -l | tr -d ' ') files)"

echo ""
echo "▸ Step 2a: Strip unused platform prebuilts"
# better-sqlite3 v13 ships N-API prebuilts for ALL platforms (~16MB).
# Keep only the target platform binary to save ~14MB in the DMG.
KEEP_PREBUILT="darwin-$(uname -m | sed 's/x86_64/x64/').node"
PREBUILD_DIR="node_modules/better-sqlite3/prebuilds"
# Assert the binary we need exists BEFORE deleting its siblings. A killed
# build (SIGKILL skips the trap) leaves a stripped tree behind; without this
# check we would delete the rest and silently package an app with no SQLite
# binding, only discovering it in Step 3b after packaging and signing.
if [ ! -f "$PREBUILD_DIR/$KEEP_PREBUILT" ]; then
  echo "  ❌ $KEEP_PREBUILT missing from $PREBUILD_DIR"
  echo "     node_modules is in a stripped state from an earlier interrupted build."
  echo "     Restore it, then re-run this script:"
  echo "       rm -rf node_modules && npm install --include=dev"
  exit 1
fi
find "$PREBUILD_DIR" -name '*.node' ! -name "$KEEP_PREBUILT" -delete 2>/dev/null
echo "  Kept only $KEEP_PREBUILT prebuilt"

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
# npmRebuild: false — N-API prebuilts don't need rebuilding.
# afterPack: copies node_modules + restores package.json in the app bundle.
set +e
NODE_OPTIONS="--max-old-space-size=16384" npx electron-builder --mac "$@"
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
  echo "▸ Step 3b: Verify packaged app native bindings"
  APP_DIR=$(find dist -maxdepth 1 -name "mac*" -type d | head -1)
  if [ -z "$APP_DIR" ]; then
    echo "  ⚠ Could not locate packaged app directory in dist/ — skipping"
  else
    APP_NM="$APP_DIR/Code Atelier.app/Contents/Resources/app/node_modules"
    KEEP_PREBUILT_NAME="darwin-$(uname -m | sed 's/x86_64/x64/').node"
    PACKAGED_PREBUILT="$APP_NM/better-sqlite3/prebuilds/$KEEP_PREBUILT_NAME"
    if [ -f "$PACKAGED_PREBUILT" ]; then
      echo "  ✅ N-API prebuilt present in app bundle ($APP_DIR)"
    else
      echo "  ❌ N-API prebuilt MISSING from app bundle ($APP_DIR)"
      BUILD_EXIT=1
    fi
  fi
fi

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

# ── Step 4: Publish to OneDrive (auto-update distribution)
if [ $BUILD_EXIT -eq 0 ] && [ "${SKIP_PUBLISH:-}" != "1" ]; then
  bash "$ROOT/scripts/publish-to-onedrive.sh"
fi
