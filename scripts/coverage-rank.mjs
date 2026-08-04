// scripts/coverage-rank.mjs
//
// Coverage prioritisation report (FR-003 / US-001 AS2).
//
// Reads the c8 `json-summary` reporter output (coverage/coverage-summary.json,
// produced by `npm run test:cov` — see .c8rc.json's `reporter` array) and prints:
//
//   1. Aggregate totals (lines/branches/functions) as percentage AND covered/total counts.
//   2. A per-directory rollup table with the same three columns.
//   3. The top N source files ranked by ABSOLUTE UNCOVERED LINES descending — this is
//      the work-prioritisation artefact: a file at 18% covered but 1,400 uncovered lines
//      outranks a file at 14% covered but 85 uncovered lines, because it is where the
//      next hour of test-writing pays back the most against the coverage gate.
//   4. A "below per-file expectation" list of files under the --threshold (default 65%) line.
//
// This tool does not run tests or measure anything itself — it only reads and ranks
// whatever coverage/coverage-summary.json already contains. Run `npm run test:cov` (or
// `npm run test:cov:report` to do both in one step) first.
//
// Usage:
//   node scripts/coverage-rank.mjs                     # defaults: top 25, 65% threshold, depth 3
//   node scripts/coverage-rank.mjs --top=40
//   node scripts/coverage-rank.mjs --threshold=70
//   node scripts/coverage-rank.mjs --depth=2            # directory-rollup grouping depth
//   node scripts/coverage-rank.mjs --file=coverage/coverage-summary.json

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// ── CLI args ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    file: path.join(ROOT, 'coverage', 'coverage-summary.json'),
    top: 25,
    threshold: 65,
    depth: 3
  }
  for (const arg of argv) {
    const [rawKey, rawVal] = arg.split('=')
    const key = rawKey.replace(/^--/, '')
    if (key === 'file' && rawVal)
      opts.file = path.isAbsolute(rawVal) ? rawVal : path.join(ROOT, rawVal)
    if (key === 'top' && rawVal) opts.top = Number.parseInt(rawVal, 10)
    if (key === 'threshold' && rawVal) opts.threshold = Number.parseFloat(rawVal)
    if (key === 'depth' && rawVal) opts.depth = Number.parseInt(rawVal, 10)
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))

// ── Load summary ────────────────────────────────────────────────────────
if (!existsSync(opts.file)) {
  console.error(`[coverage-rank] No coverage summary found at ${path.relative(ROOT, opts.file)}`)
  console.error(
    '[coverage-rank] Run `npm run test:cov` first (or `npm run test:cov:report` to do both).'
  )
  process.exitCode = 1
  process.exit(1)
}

let summary
try {
  summary = JSON.parse(readFileSync(opts.file, 'utf-8'))
} catch (err) {
  console.error(`[coverage-rank] Failed to parse ${path.relative(ROOT, opts.file)}: ${err.message}`)
  process.exitCode = 1
  process.exit(1)
}

const { total, ...fileEntries } = summary
if (!total) {
  console.error(
    '[coverage-rank] Summary is missing the "total" aggregate entry — is this a valid c8 json-summary file?'
  )
  process.exitCode = 1
  process.exit(1)
}

// Guard against a stale/corrupt summary reporting an all-zero run (e.g. a committed
// artifact from before instrumentation ran, or a run that crashed before any module
// loaded). Printing a plausible-looking 0.00%-everywhere report here would silently
// mislead the SC-011 "10-minute onboarding" path in docs/testing/coverage.md — fail
// loudly instead so the stale file gets regenerated rather than trusted.
if (total.lines && total.lines.total > 0 && total.lines.covered === 0) {
  console.error(
    `[coverage-rank] ${path.relative(ROOT, opts.file)} reports 0/${total.lines.total} lines covered across ${Object.keys(fileEntries).length} file(s) — this looks like a stale or corrupt summary, not a real run.`
  )
  console.error(
    '[coverage-rank] Delete coverage/ and re-run `npm run test:cov` (or `npm run test:cov:report`) to regenerate it.'
  )
  process.exitCode = 1
  process.exit(1)
}

// ── Helpers ─────────────────────────────────────────────────────────────
function toRelative(absPath) {
  const rel = path.relative(ROOT, absPath)
  // Files outside the repo root (shouldn't normally happen) keep their absolute form.
  return rel.startsWith('..') ? absPath : rel
}

function pct(covered, total) {
  if (total === 0) return 100
  return (covered / total) * 100
}

function fmtPct(n) {
  return `${n.toFixed(2)}%`
}

function padRight(str, len) {
  return str.length >= len ? str : str + ' '.repeat(len - str.length)
}

function padLeft(str, len) {
  return str.length >= len ? str : ' '.repeat(len - str.length) + str
}

function dirKey(relPath, depth) {
  const segments = path.dirname(relPath).split(path.sep)
  return segments.slice(0, depth).join('/')
}

// ── Build per-file records ─────────────────────────────────────────────
const files = Object.entries(fileEntries).map(([absPath, data]) => {
  const relPath = toRelative(absPath)
  const lines = data.lines ?? { total: 0, covered: 0 }
  const branches = data.branches ?? { total: 0, covered: 0 }
  const functions = data.functions ?? { total: 0, covered: 0 }
  const uncoveredLines = lines.total - lines.covered
  return {
    path: relPath,
    lines,
    branches,
    functions,
    uncoveredLines,
    linesPct: pct(lines.covered, lines.total)
  }
})

// ── 1. Aggregate totals ─────────────────────────────────────────────────
console.log('')
console.log('='.repeat(78))
console.log('Coverage Ranking Report')
console.log('='.repeat(78))
console.log(`Source: ${path.relative(ROOT, opts.file)}`)
console.log(`Files measured: ${files.length}`)
console.log('')
console.log('Aggregate totals')
console.log('-'.repeat(78))
for (const metric of ['lines', 'branches', 'functions']) {
  const m = total[metric]
  if (!m) continue
  console.log(
    `  ${padRight(metric, 12)} ${padLeft(fmtPct(m.pct), 8)}   (${m.covered}/${m.total} covered)`
  )
}
console.log('')

// ── 2. Per-directory rollup ─────────────────────────────────────────────
const dirTotals = new Map()
for (const f of files) {
  const key = dirKey(f.path, opts.depth) || '.'
  if (!dirTotals.has(key)) {
    dirTotals.set(key, {
      lines: { covered: 0, total: 0 },
      branches: { covered: 0, total: 0 },
      functions: { covered: 0, total: 0 },
      fileCount: 0
    })
  }
  const d = dirTotals.get(key)
  d.lines.covered += f.lines.covered
  d.lines.total += f.lines.total
  d.branches.covered += f.branches.covered
  d.branches.total += f.branches.total
  d.functions.covered += f.functions.covered
  d.functions.total += f.functions.total
  d.fileCount += 1
}

const dirRows = [...dirTotals.entries()]
  .map(([dir, d]) => ({
    dir,
    fileCount: d.fileCount,
    lines: d.lines,
    branches: d.branches,
    functions: d.functions,
    linesPct: pct(d.lines.covered, d.lines.total),
    uncoveredLines: d.lines.total - d.lines.covered
  }))
  .sort((a, b) => b.uncoveredLines - a.uncoveredLines)

console.log(`Per-directory rollup (grouped at depth=${opts.depth}, sorted by uncovered lines)`)
console.log('-'.repeat(100))
console.log(
  `  ${padRight('Directory', 45)} ${padLeft('Files', 6)} ${padLeft('Lines %', 9)} ${padLeft('Lines cov/total', 18)} ${padLeft('Branches %', 11)} ${padLeft('Funcs %', 9)}`
)
for (const row of dirRows) {
  console.log(
    `  ${padRight(row.dir, 45)} ${padLeft(String(row.fileCount), 6)} ${padLeft(fmtPct(row.linesPct), 9)} ${padLeft(`${row.lines.covered}/${row.lines.total}`, 18)} ${padLeft(fmtPct(pct(row.branches.covered, row.branches.total)), 11)} ${padLeft(fmtPct(pct(row.functions.covered, row.functions.total)), 9)}`
  )
}
console.log('')

// ── 3. Top N files ranked by absolute uncovered lines ───────────────────
const ranked = [...files].sort((a, b) => b.uncoveredLines - a.uncoveredLines).slice(0, opts.top)

console.log(
  `Top ${ranked.length} files by ABSOLUTE uncovered lines (the work-prioritisation ranking)`
)
console.log('-'.repeat(100))
console.log(
  `  ${padRight('#', 4)} ${padRight('File', 60)} ${padLeft('Uncovered', 10)} ${padLeft('Lines %', 9)} ${padLeft('cov/total', 14)}`
)
ranked.forEach((f, i) => {
  console.log(
    `  ${padRight(String(i + 1), 4)} ${padRight(f.path, 60)} ${padLeft(String(f.uncoveredLines), 10)} ${padLeft(fmtPct(f.linesPct), 9)} ${padLeft(`${f.lines.covered}/${f.lines.total}`, 14)}`
  )
})
console.log('')

// ── 4. Below per-file expectation ────────────────────────────────────────
const belowExpectation = [...files]
  .filter((f) => f.lines.total > 0 && f.linesPct < opts.threshold)
  .sort((a, b) => a.linesPct - b.linesPct)

console.log(
  `Below per-file expectation (< ${opts.threshold}% lines): ${belowExpectation.length} file(s)`
)
console.log('-'.repeat(100))
for (const f of belowExpectation) {
  console.log(
    `  ${padRight(f.path, 60)} ${padLeft(fmtPct(f.linesPct), 9)} ${padLeft(`${f.lines.covered}/${f.lines.total}`, 14)} ${padLeft(`${f.uncoveredLines} uncovered`, 16)}`
  )
}
console.log('')
console.log('='.repeat(78))
console.log('')
