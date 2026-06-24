#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "▸ Step 1: Build (electron-vite only - skip typecheck)"
electron-vite build

echo ""
echo "▸ Step 2: Prune to production dependencies"
npm prune --omit=dev

echo ""
echo "▸ Step 2b: Rebuild native modules"
npx --yes @electron/rebuild \
  --version 42.4.1 \
  --module-dir "$ROOT" \
  --types prod \
  --force

echo ""
echo "▸ Step 2c: Strip runtime-unnecessary files"
rm -rf node_modules/electron
find node_modules -name '*.map' -type f -delete
find node_modules \( -name '*.d.ts' -o -name '*.d.mts' \) -type f -delete
find node_modules -type l ! -exec test -e {} \; -delete 2>/dev/null || true

echo ""
echo "▸ Step 3: Package with electron-builder"
NODE_OPTIONS="--max-old-space-size=16384" npx electron-builder --mac "$@"

echo ""
echo "✅ Build complete"
ls -lh dist/*.dmg 2>/dev/null || echo "check dist/ for output"
