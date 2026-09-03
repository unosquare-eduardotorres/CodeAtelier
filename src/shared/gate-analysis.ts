/**
 * Pure analysis behind the static gates (G4 write-set, G3 stub scan,
 * G5 test integrity).
 *
 * All I/O — git, fs, spawning — lives in `blueprint-gates.service.ts`. Keeping
 * the judgement here means the interesting cases (a stub added 300 lines from
 * the change, a test file renamed, a `.only` slipped into a diff) are unit
 * tests over strings rather than temp-repo scaffolding.
 *
 * A theme runs through all three: they read the DIFF, not the file. A gate that
 * scanned whole changed files would fail a task for a `TODO` that predates it,
 * which is a false `fail` — and a false `fail` costs two builder retries and a
 * strong-model fix before anyone notices the gate was wrong.
 */

// ── Path helpers ──

/** Normalise to forward slashes and strip a leading `./`. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * Does `file` fall under `allowed`?
 *
 * `allowed` is either an exact path or a directory prefix. A trailing slash
 * makes the directory intent explicit; without one, a prefix only matches on a
 * path-segment boundary, so `src/apiary.ts` is NOT covered by `src/api`.
 */
/** C-style escapes git emits inside a quoted path, minus the octal form. */
const GIT_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92
}

/**
 * Undo git's C-style path quoting.
 *
 * `core.quotePath` defaults to true, so any path with a non-ASCII byte reaches
 * a diff header already mangled: `+++ "b/src/Caf\303\251.cs"`. Left alone, the
 * `b/` strip below silently no-ops (the string starts with `"`) and every gate
 * downstream compares a path that does not exist against write-sets that use
 * the real one — a false violation no retry can clear.
 *
 * Unquoting is byte-wise, not char-wise: `\303\251` is a two-byte UTF-8
 * sequence for one character, so the octal escapes must be collected as bytes
 * and decoded together.
 */
export function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path
  const body = path.slice(1, -1)
  const encoder = new TextEncoder()
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      for (const b of encoder.encode(body[i])) bytes.push(b)
      continue
    }
    const next = body[++i]
    if (next === undefined) break
    if (/[0-7]/.test(next) && /^[0-7]{2}$/.test(body.slice(i + 1, i + 3))) {
      bytes.push(parseInt(body.slice(i, i + 3), 8))
      i += 2
      continue
    }
    // An unknown escape is passed through as the literal character: git never
    // emits one, and dropping it would corrupt the path worse than keeping it.
    bytes.push(GIT_ESCAPES[next] ?? next.charCodeAt(0))
  }

  return new TextDecoder().decode(new Uint8Array(bytes))
}

export function pathMatches(file: string, allowed: string): boolean {
  const f = normalizePath(file)
  const a = normalizePath(allowed)
  if (f === a) return true
  if (a.endsWith('/')) return f.startsWith(a)
  return f.startsWith(`${a}/`)
}

// ── G4: write-set ──

export interface WriteSetInput {
  /** Repo-relative paths changed during the task session. */
  changedFiles: readonly string[]
  /** The union of the packet's `allowedFiles` and the task's planned files. */
  allowedFiles: readonly string[]
  /**
   * The packet's test files. Changing one is not a write-set violation — it is
   * a TEST-INTEGRITY violation, and reporting it in both places would make one
   * mistake look like two independent failures.
   */
  testFiles?: readonly string[]
  /** Paths the packet explicitly forbids. A hit here is always a violation. */
  forbiddenFiles?: readonly string[]
}

export interface WriteSetResult {
  /** Changed files outside the allowed set. */
  violations: string[]
  /** Changed files that hit an explicit `forbiddenFiles` entry. */
  forbidden: string[]
  changedCount: number
}

export function evaluateWriteSet(input: WriteSetInput): WriteSetResult {
  const changed = input.changedFiles.map(normalizePath)
  const forbidden = changed.filter((f) =>
    (input.forbiddenFiles ?? []).some((p) => pathMatches(f, p))
  )

  const violations = changed.filter((f) => {
    if (forbidden.includes(f)) return false // already reported as forbidden
    if ((input.testFiles ?? []).some((p) => pathMatches(f, p))) return false
    return !input.allowedFiles.some((p) => pathMatches(f, p))
  })

  return { violations, forbidden, changedCount: changed.length }
}

// ── Unified diff parsing ──

export interface AddedLine {
  file: string
  /** 1-indexed line number in the post-image. */
  line: number
  text: string
}

/**
 * Extract added lines from `git diff` output.
 *
 * Handles the standard `diff --git` / `+++ b/<path>` / `@@ -a,b +c,d @@` shape.
 * `/dev/null` targets (deletions) are skipped: a deleted file has no added
 * lines, and treating the `---` side as a path would attribute every removal to
 * the wrong file.
 */
export function parseDiffAddedLines(diffText: string): AddedLine[] {
  const out: AddedLine[] = []
  let file: string | null = null
  let lineNo = 0

  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const target = unquoteGitPath(raw.slice(4).trim())
      file = target === '/dev/null' ? null : normalizePath(target.replace(/^b\//, ''))
      continue
    }
    if (raw.startsWith('@@')) {
      // @@ -12,3 +14,6 @@ optional section heading
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      lineNo = m ? Number(m[1]) : 0
      continue
    }
    if (!file || lineNo === 0) continue

    if (raw.startsWith('+')) {
      out.push({ file, line: lineNo, text: raw.slice(1) })
      lineNo++
    } else if (raw.startsWith('-') || raw.startsWith('\\')) {
      // Removals and "\ No newline at end of file" do not advance the post-image.
    } else if (raw.startsWith(' ')) {
      lineNo++
    }
  }

  return out
}

/** Repo-relative paths that appear as changed in a `git diff` body. */
export function parseDiffFiles(diffText: string): string[] {
  const files = new Set<string>()
  for (const raw of diffText.split('\n')) {
    if (!raw.startsWith('+++ ')) continue
    const target = unquoteGitPath(raw.slice(4).trim())
    if (target === '/dev/null') continue
    files.add(normalizePath(target.replace(/^b\//, '')))
  }
  return [...files]
}

// ── G3: stub scan ──

export type StubKind = 'todo' | 'fixme' | 'not-implemented' | 'empty-body' | 'placeholder-return'

export interface StubFinding {
  file: string
  line: number
  kind: StubKind
  /** The offending line, trimmed and length-capped for evidence. */
  snippet: string
}

interface StubRule {
  kind: StubKind
  pattern: RegExp
}

/**
 * Default rules. Deliberately conservative: each one matches a marker a
 * developer writes to mean "unfinished", not merely a word that can appear in
 * prose. `TODO` inside a string or a comment still counts — a shipped TODO is
 * the residue this gate exists to catch.
 *
 * R2.2 — narrowed after false-positive audit:
 *   - the bare `{}` empty-body rule is GONE. `const config = {}`, `: {}` type
 *     annotations and object-literal arguments are legitimate code; only
 *     `pass` / `...` bodies (a shape no real implementation takes) remain.
 *   - `placeholder-return` only fires when the return is followed by a
 *     TODO-style comment — `return []` as a real (if trivial) implementation
 *     is not unfinished work, it is a decision the reviewer can judge.
 */
export const DEFAULT_STUB_RULES: readonly StubRule[] = [
  { kind: 'todo', pattern: /\bTODO\b/ },
  { kind: 'fixme', pattern: /\b(FIXME|XXX|HACK)\b/ },
  {
    kind: 'not-implemented',
    pattern:
      /(NotImplementedException|NotImplementedError|not[ _-]?implemented|unimplemented!\s*\(|todo!\s*\(|panic!\s*\(\s*["']todo)/i
  },
  // A body that is only `pass` / `...` on its own line, i.e. the shape a model
  // emits when it declares an interface it never filled in.
  { kind: 'empty-body', pattern: /^\s*(pass|\.\.\.)\s*$/ },
  {
    kind: 'placeholder-return',
    pattern:
      /^\s*(return\s+(null|None|undefined|0|""|''|\[\]|\{\})\s*;?)\s*(\/\/|\/\*|#).*?(todo|fixme|stub|placeholder|not implemented|unimplemented).*$/i
  }
]

const MAX_SNIPPET = 160

/**
 * Scan ADDED lines for unfinished-work markers.
 *
 * Scanning added lines rather than whole changed files is the whole point: a
 * task that edits one function in a 2000-line file must not be failed by a
 * `TODO` someone else left in 2023.
 */
export function scanAddedLinesForStubs(
  lines: readonly AddedLine[],
  rules: readonly StubRule[] = DEFAULT_STUB_RULES
): StubFinding[] {
  const findings: StubFinding[] = []
  for (const line of lines) {
    for (const rule of rules) {
      if (!rule.pattern.test(line.text)) continue
      findings.push({
        file: line.file,
        line: line.line,
        kind: rule.kind,
        snippet: line.text.trim().slice(0, MAX_SNIPPET)
      })
      break // one finding per line — the first rule that matches names it well enough
    }
  }
  return findings
}

// ── G5: test integrity ──

/** Markers that disable a test. Added in a diff, any of these is a red flag. */
const SKIP_PATTERNS: readonly RegExp[] = [
  /\b(it|test|describe|context)\s*\.\s*(skip|only|todo)\b/,
  /\b(xit|xdescribe|xtest|fdescribe|fit)\s*\(/,
  /@(Ignore|Skip)\b/,
  /\[(Ignore|Skip)\]/,
  /\bpytest\s*\.\s*mark\s*\.\s*(skip|xfail)\b/,
  /\bt\s*\.\s*Skip\s*\(/
]

/** Rough per-file test count — enough to notice a suite shrinking. */
export function countTests(content: string): number {
  const matches = content.match(
    /(^|[^\w.])(it|test|Test)\s*(\.each\s*(\(|`))?\s*\(|^\s*def\s+test_\w+|^\s*\[Fact\]|^\s*\[Theory\]|^\s*func\s+Test\w+/gm
  )
  return matches ? matches.length : 0
}

export interface TestFileState {
  hash: string
  testCount: number
}

export interface TestIntegrityInput {
  /** Packet test files as they were BEFORE the build session. */
  before: Readonly<Record<string, TestFileState>>
  /** The same files AFTER. `null` means the file no longer exists. */
  after: Readonly<Record<string, TestFileState | null>>
  /** Added diff lines restricted to test files. */
  addedTestLines: readonly AddedLine[]
}

export interface TestIntegrityResult {
  modified: string[]
  deleted: string[]
  skipsAdded: StubFinding[]
  /** Files whose test count went down, with the before/after numbers. */
  countDrops: { file: string; before: number; after: number }[]
  /**
   * EXTENSION ALLOWANCE: files that changed but ONLY by adding tests — strict
   * count increase, no skips added in that file, no count drop, not deleted.
   * Authoring new tests inside an existing packet-declared test file is a
   * legitimate deliverable (T001: extend test_rls_isolation.py with election
   * coverage), so these are excluded from `modified` while staying visible
   * as evidence.
   */
  extended: string[]
  ok: boolean
}

/**
 * The builder must make the pre-authored tests pass, not edit them into
 * passing. The gate distinguishes WEAKENING the spec (fail) from EXTENDING it
 * (pass):
 *   (a) the file changed at all (hash) — fail, UNLESS it is a pure extension:
 *       test count strictly increased, no skip markers added in that file, no
 *       count drop (same-count rewrites still fail — they could be rewriting
 *       assertions to match broken code),
 *   (b) a test was disabled (skip markers) — fail,
 *   (c) tests disappeared (count drop or deletion) — fail.
 * Residual trade-off: a rewrite that ALSO adds tests can slip past the hash
 * check — that shape is still covered by the stub scan (added lines) and
 * peer review.
 */
export function evaluateTestIntegrity(input: TestIntegrityInput): TestIntegrityResult {
  const modified: string[] = []
  const deleted: string[] = []
  const extended: string[] = []
  const countDrops: { file: string; before: number; after: number }[] = []

  const skipsAdded: StubFinding[] = []
  for (const line of input.addedTestLines) {
    if (SKIP_PATTERNS.some((p) => p.test(line.text))) {
      skipsAdded.push({
        file: line.file,
        line: line.line,
        kind: 'not-implemented',
        snippet: line.text.trim().slice(0, MAX_SNIPPET)
      })
    }
  }
  const filesWithSkips = new Set(skipsAdded.map((s) => s.file))

  for (const [file, before] of Object.entries(input.before)) {
    const after = input.after[file]
    if (after === null || after === undefined) {
      deleted.push(file)
      continue
    }
    if (after.testCount < before.testCount) {
      countDrops.push({ file, before: before.testCount, after: after.testCount })
    }
    if (after.hash !== before.hash) {
      // EXTENSION ALLOWANCE: strict count increase + no skips in this file +
      // no count drop (implied by the increase) = authoring, not weakening.
      if (after.testCount > before.testCount && !filesWithSkips.has(file)) {
        extended.push(file)
      } else {
        modified.push(file)
      }
    }
  }

  return {
    modified,
    deleted,
    skipsAdded,
    countDrops,
    extended,
    ok:
      modified.length === 0 &&
      deleted.length === 0 &&
      skipsAdded.length === 0 &&
      countDrops.length === 0
  }
}
