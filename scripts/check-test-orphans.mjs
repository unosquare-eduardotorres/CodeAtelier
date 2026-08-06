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

// -- Known backlog: registered in run-all.ts, absent from both unit runners --
// These predate the drift check below. They are NOT benign: each runs only
// under `npm run test:cov`, never under `npm run test:all`. Spot-checking the
// repository entries showed they do not currently pass in the repository
// runner either -- audit-plan.repository.test aborts the run with a CHECK
// constraint failure on mode -- which is the likely reason they were never
// wired in.
//
// Listed explicitly rather than skipped by pattern, so the gate still fails on
// any NEW drift. Shrink this list; do not add to it.
const KNOWN_UNIT_RUNNER_GAP = new Set(
  [
    'src/main/db/repositories/__tests__/agent-session.repository.test.ts',
    'src/main/db/repositories/__tests__/app-preference.repository.test.ts',
    'src/main/db/repositories/__tests__/audit-plan.repository.test.ts',
    'src/main/db/repositories/__tests__/base-repository.test.ts',
    'src/main/db/repositories/__tests__/checkpoint.repository.test.ts',
    'src/main/db/repositories/__tests__/chunk-embedding.repository.test.ts',
    'src/main/db/repositories/__tests__/code-chunk.repository.test.ts',
    'src/main/db/repositories/__tests__/code-graph-edge.repository.test.ts',
    'src/main/db/repositories/__tests__/code-graph-rank.repository.test.ts',
    'src/main/db/repositories/__tests__/code-graph-tag.repository.test.ts',
    'src/main/db/repositories/__tests__/conversation-specialist.repository.test.ts',
    'src/main/db/repositories/__tests__/core-agent-alias.repository.test.ts',
    'src/main/db/repositories/__tests__/core-agent-prompt.repository.test.ts',
    'src/main/db/repositories/__tests__/mpa-artifact.repository.test.ts',
    'src/main/db/repositories/__tests__/turn-usage.repository.test.ts',
    'src/main/db/repositories/__tests__/user-profile.repository.test.ts',
    'src/main/ipc/__tests__/audit-ipc-handlers.test.ts',
    'src/main/ipc/__tests__/blueprint-ipc-handlers.test.ts',
    'src/main/ipc/__tests__/config-ipc-validation.test.ts',
    'src/main/ipc/__tests__/conversation-crud-handlers.test.ts',
    'src/main/ipc/__tests__/crud-ipc-validation.test.ts',
    'src/main/ipc/__tests__/grill-ipc-handlers.test.ts',
    'src/main/ipc/__tests__/ipc-code-changes-p27.test.ts',
    'src/main/ipc/__tests__/ipc-utilities.test.ts',
    'src/main/ipc/__tests__/mpa-ipc-handlers.test.ts',
    'src/main/ipc/__tests__/workspace-ipc-handlers.test.ts'
  ].map((f) => path.normalize(f))
)

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
/** repo-relative path -> absolute path, so staleness can stat the real file. */
const registeredAbs = new Map()
for (const spec of importMatches) {
  const abs = path.normalize(path.join(runAllDir, spec + '.ts'))
  const rel = path.normalize(path.relative(ROOT, abs))
  registered.add(rel)
  registeredAbs.set(rel, abs)
}

// ── Compute orphans (on disk, not registered, not denied) ──────────────────
const orphans = onDisk.filter((f) => !registered.has(f) && !DENY_SET.has(f))

// ── Compute stale entries (registered, but no longer on disk) ──────────────
// Stat the resolved path rather than testing membership of `onDisk`. onDisk
// only covers SCAN_DIRS (src/main, src/shared), so a set-membership test
// reported every registered renderer test as stale even though it exists --
// which kept this script permanently red and unusable as a CI gate.
const stale = [...registered].filter((f) => !existsSync(registeredAbs.get(f))).sort()

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

// ── run-tests.ts vs run-all.ts drift ────────────────────────────────
// Two runners execute the same tests: run-tests.ts backs `npm run test:unit`,
// run-all.ts backs `npm run test:cov`. Registration is manual in both, so they
// drift silently -- 51 files once sat in run-all.ts but not run-tests.ts and so
// never ran in the unit suite at all, while still counting toward coverage.
//
// Only files under SCAN_DIRS are compared: run-all.ts additionally carries
// renderer and repository suites that run-tests.ts is not responsible for.
// `npm run test:all` is test:unit + test:repo, so the comparison target is the
// union of both runners -- the repository suite has its own entrypoint and is
// deliberately absent from run-tests.ts.
const UNIT_RUNNERS = [
  'src/main/services/__tests__/run-tests.ts',
  'src/main/db/repositories/__tests__/run-tests.ts'
].map((p) => path.join(ROOT, p))

if (UNIT_RUNNERS.every((p) => existsSync(p))) {
  const unitRegistered = new Set()
  for (const runnerPath of UNIT_RUNNERS) {
    const src = readFileSync(runnerPath, 'utf8')
    const dir = path.dirname(runnerPath)
    for (const m of src.matchAll(/'(\.\.?\/[^']+\.test)'/g)) {
      const abs = path.normalize(path.join(dir, m[1] + '.ts'))
      unitRegistered.add(path.normalize(path.relative(ROOT, abs)))
    }
  }

  const inScope = (f) => SCAN_DIRS.some((d) => f.startsWith(path.normalize(d) + path.sep))
  const covOnly = [...registered].filter(
    (f) => inScope(f) && !unitRegistered.has(f) && !DENY_SET.has(f) && !KNOWN_UNIT_RUNNER_GAP.has(f)
  )
  const unitOnly = [...unitRegistered].filter((f) => !registered.has(f)).sort()

  if (covOnly.length > 0) {
    failed = true
    console.error(
      `\n[check-test-orphans] FAILED — ${covOnly.length} file(s) are in run-all.ts but in neither unit runner, so \`npm run test:all\` skips them:\n`
    )
    for (const f of covOnly.sort()) console.error(`  - ${f}`)
    console.error('\nAdd each to TEST_FILES in src/main/services/__tests__/run-tests.ts.')
  }

  if (unitOnly.length > 0) {
    failed = true
    console.error(
      `\n[check-test-orphans] FAILED — ${unitOnly.length} file(s) are in a unit runner but NOT run-all.ts, so they contribute no coverage:\n`
    )
    for (const f of unitOnly) console.error(`  - ${f}`)
    console.error('\nAdd each to SERVICE_TEST_FILES in src/main/__tests__/run-all.ts.')
  }
}

if (failed) {
  process.exit(1)
}

console.log(
  '[check-test-orphans] OK — every on-disk test file is registered or explicitly deny-listed.'
)
