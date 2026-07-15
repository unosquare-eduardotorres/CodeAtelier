#!/bin/bash
# Full coverage run — rebuilds better-sqlite3 for the local Node ABI so that
# repository/migration tests actually execute instead of skipping.
#
# Strategy:
#   1. Rebuild better-sqlite3 for the running Node.js ABI (not Electron)
#   2. Run the full coverage suite — repo tests now run for real
#   3. Restore Electron ABI on ANY exit (trap: success, failure, ctrl-c)
#
# Usage:
#   bash scripts/coverage-full.sh          # text reporter
#   bash scripts/coverage-full.sh --html   # text + html reporter
#
# After the run completes, `npm run dev` still works because the EXIT trap
# rebuilds better-sqlite3 against Electron headers.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Restore Electron ABI on ANY exit ──
restore_electron_abi() {
  echo ""
  echo "🔄 Restoring better-sqlite3 for Electron ABI..."
  npx electron-builder install-app-deps 2>/dev/null || {
    echo "⚠️  electron-builder install-app-deps failed — try: npm run postinstall"
  }
  echo "✅ Electron ABI restored"
}
trap restore_electron_abi EXIT

# ── Step 1: Rebuild better-sqlite3 for Node ABI ──
echo "🔨 Rebuilding better-sqlite3 for Node.js $(node -v)..."
npm rebuild better-sqlite3 2>&1 | tail -3

# Verify the rebuild worked
node -e "require('better-sqlite3')" 2>/dev/null && echo "✅ better-sqlite3 loaded under Node.js" || {
  echo "❌ better-sqlite3 rebuild failed — falling back to standard coverage"
  npx c8 npx tsx src/main/__tests__/run-all.ts
  exit $?
}

# ── Step 2: Run full coverage suite ──
echo ""
echo "📊 Running full coverage suite..."
echo ""

if [[ "${1:-}" == "--html" ]]; then
  npx c8 --reporter=html --reporter=text npx tsx src/main/__tests__/run-all.ts
else
  npx c8 npx tsx src/main/__tests__/run-all.ts
fi
