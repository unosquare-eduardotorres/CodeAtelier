// scripts/check-test-orphans.mjs
//
// Orphan test detector (FR-031 / SC-009).
//
// src/main/__tests__/run-all.ts is a hand-maintained registry of test-file
// import paths consumed by a single dynamic-import loop so `c8` can produce
// one merged coverage report. Because it is hand-maintained, a test file can
// be written, saved, and never wired in — it then contributes ZERO coverage
// while every test inside it still reports green when run standalone. This
// script closes that gap without requiring a full rewrite to filesystem
// discovery: it walks disk for every `*.test.ts` file under `src/main` and
// `src/shared`, parses the paths actually imported by run-all.ts, and fails
// loudly when disk has a file the registry doesn't know about.
//
// A small DENY_LIST below covers on-disk test files that are deliberately
// NOT wired into the unified coverage run (e.g. they require a live external
// service and would hang or fail on a machine that doesn't have it). Every
// entry requires a one-line justification comment — an empty list is the
// long-term goal once P2 in the plan replaces this registry with true
// discovery.
//
// Usage:
//   node scripts/check-test-orphans.mjs
//
// Exit code 0: every on-disk test file (outside DENY_LIST) is registered.
// Exit code 1: one or more on-disk test files are unregistered (orphaned),
//              OR one or more registry entries point at a file that no
//              longer exists on disk (a stale entry — usually a rename).

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const RUN_ALL_PATH = path.join(ROOT, 'src/main/__tests__/run-all.ts')
const SCAN_DIRS = ['src/main', 'src/shared']

// ── Deny list: on-disk test files deliberately excluded from run-all.ts ────
// Every entry MUST carry a one-line justification. Do not widen this list to
// silence a real orphan — fix or register the file instead.
const DENY_LIST = [
  {
    // Requires a real `opencode` CLI (v1.17+) and a live oMLX server at
    // OMLX_BASE_URL — would hang/fail in CI and violates the "never launch
    // claude or opencode" constraint on the unified coverage run.
    file: 'src/main/services/__tests__/opencode-executor-integration.test.ts',
    reason:
      'requires a real opencode CLI + live oMLX server (external dependency, forbidden in the unified coverage run)'
  },
  {
    // Same external-dependency constraint as above — a diagnostic script for
    // manually isolating hangs in the real oMLX flow, not a hermetic test.
    file: 'src/main/services/__tests__/opencode-session-diagnostic.test.ts',
    reason:
      'requires a real opencode CLI + live oMLX server (diagnostic script, not a hermetic test)'
  }
]
const DENY_SET = new Set(DENY_LIST.map((d) => path.normalize(d.file)))

// ── Walk disk for every __tests__/*.test.ts file ────────────────────────────
function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      walk(full, out)
    } else if (entry.endsWith('.test.ts') && path.basename(path.dirname(full)) === '__tests__') {
      out.push(path.normalize(path.relative(ROOT, full)))
    }
  }
}

const onDisk = []
for (const dir of SCAN_DIRS) {
  const abs = path.join(ROOT, dir)
  if (existsSync(abs)) walk(abs, onDisk)
}
onDisk.sort()

// ── Parse run-all.ts's registered import paths ──────────────────────────────
if (!existsSync(RUN_ALL_PATH)) {
  console.error(`[check-test-orphans] run-all.ts not found at ${path.relative(ROOT, RUN_ALL_PATH)}`)
  process.exit(1)
}
const runAllSrc = readFileSync(RUN_ALL_PATH, 'utf8')
const runAllDir = path.dirname(RUN_ALL_PATH)

// Matches single-quoted relative import specifiers ending in `.test`, e.g.
// '../services/__tests__/foo.test'. This is a deliberately narrow pattern —
// run-all.ts's arrays are the only place these strings should appear.
const importMatches = [...runAllSrc.matchAll(/'(\.\.?\/[^']+\.test)'/g)].map((m) => m[1])

const registered = new Set()
for (const spec of importMatches) {
  const abs = path.normalize(path.join(runAllDir, spec + '.ts'))
  registered.add(path.normalize(path.relative(ROOT, abs)))
}

// ── Compute orphans (on disk, not registered, not denied) ──────────────────
const orphans = onDisk.filter((f) => !registered.has(f) && !DENY_SET.has(f))

// ── Compute stale entries (registered, but no longer on disk) ──────────────
const onDiskSet = new Set(onDisk)
const stale = [...registered].filter((f) => !onDiskSet.has(f)).sort()

// ── Report ───────────────────────────────────────────────────────────────
console.log(
  `[check-test-orphans] ${onDisk.length} test file(s) on disk, ${registered.size} registered in run-all.ts, ${DENY_LIST.length} deny-listed`
)

let failed = false

if (orphans.length > 0) {
  failed = true
  console.error(
    `\n[check-test-orphans] FAILED — ${orphans.length} on-disk test file(s) are not registered in run-all.ts and contribute ZERO coverage:\n`
  )
  for (const f of orphans) console.error(`  - ${f}`)
  console.error(
    '\nRegister each file in src/main/__tests__/run-all.ts (SERVICE_TEST_FILES or REPO_TEST_FILES), ' +
      'or — if it genuinely cannot run in the unified coverage run (e.g. it requires a live external ' +
      'service) — add it to DENY_LIST in this script with a one-line justification.'
  )
}

if (stale.length > 0) {
  failed = true
  console.error(
    `\n[check-test-orphans] FAILED — ${stale.length} run-all.ts entr${stale.length === 1 ? 'y points' : 'ies point'} at file(s) that no longer exist on disk (likely a stale rename):\n`
  )
  for (const f of stale) console.error(`  - ${f}`)
}

if (failed) {
  process.exit(1)
}

console.log(
  '[check-test-orphans] OK — every on-disk test file is registered or explicitly deny-listed.'
)
