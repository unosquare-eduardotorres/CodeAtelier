#!/bin/bash
# Build macOS installer — works around electron-builder OOM on large node_modules.
# Prunes to production deps before packaging, then restores full dev deps after.
#
# IMPORTANT: A trap guarantees dev-dependency restoration even if the build fails.
# Without it, `set -euo pipefail` would abort on a failed electron-builder step
# and leave node_modules permanently pruned (no tsc, no electron-vite, etc.).
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
  if [ "$PRUNED" = true ]; then
    echo ""
    echo "▸ Restore: Full dependencies"
    npm install --include=dev
    echo "  node_modules restored"
  fi
}
trap restore_deps EXIT

echo "▸ Step 1: Build (typecheck + electron-vite)"
npm run build

echo ""
echo "▸ Step 2: Prune to production dependencies"
npm prune --omit=dev
PRUNED=true
echo "  node_modules: $(du -sh node_modules | cut -f1) ($(find node_modules -type f | wc -l | tr -d ' ') files)"

echo ""
echo "▸ Step 3: Package with electron-builder"
# Use npx to resolve electron-builder (pruned from local node_modules).
# electron-builder.yml has npmRebuild: true — after prune leaves ~278 production
# packages, electron-builder runs @electron/rebuild to recompile native modules
# (better-sqlite3) against Electron's Node headers. This fixes MODULE_VERSION
# mismatches that cause "Database Error" on launch from a packaged DMG.
set +e
npx electron-builder --mac "$@"
BUILD_EXIT=$?
set -e

# The EXIT trap handles restoration automatically (Step 4).

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
