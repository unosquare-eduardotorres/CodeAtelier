#!/bin/bash
# Full coverage run — includes repository and migration tests.
#
# With better-sqlite3 v13 (N-API), the same binary works under both
# Node.js and Electron — no rebuild dance needed.
#
# Usage:
#   bash scripts/coverage-full.sh          # text reporter
#   bash scripts/coverage-full.sh --html   # text + html reporter
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "📊 Running full coverage suite..."
echo ""

if [[ "${1:-}" == "--html" ]]; then
  npx c8 --reporter=html --reporter=text npx tsx src/main/__tests__/run-all.ts
else
  npx c8 npx tsx src/main/__tests__/run-all.ts
fi
