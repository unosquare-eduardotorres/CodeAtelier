/**
 * scope-matcher — glob matching for path-scoped memory and file watching.
 *
 * Replaces the ad-hoc prefix/suffix matcher that lived inside
 * memory-doc-watcher.service.ts, which treated `src/**\/*.ts` as
 * "starts with src/ and ends with .ts" — so `src/a/b.ts.bak` matched and
 * `{a,b}` groups did not work at all.
 *
 * Semantics are the conventional ones:
 *   `*`      — any run of characters within one path segment
 *   `**`     — any number of whole segments, including none
 *   `?`      — exactly one character within a segment
 *   `{a,b}`  — alternation, nestable
 *   `!x`     — in a pattern *list*, excludes an otherwise-matching path
 *
 * Patterns are anchored to the whole workspace-relative path: `*.md` matches
 * `README.md` but not `docs/guide.md`. Write `**\/*.md` for the latter.
 *
 * No dependency is added for this: the repository has no glob library, and the
 * subset above is small enough that a compiled RegExp is simpler than pulling
 * in minimatch and its transitive tree.
 */

/** Compiled patterns are reused across turns; retrieval calls this per fact. */
const cache = new Map<string, RegExp>()

/** Bound on the cache so a pathological caller cannot grow it without limit. */
const MAX_CACHE = 500

/**
 * Characters that mean a string is a glob rather than a literal path.
 *
 * Deliberately excludes `[` and `]`: bracket classes are not supported (they
 * are escaped to literals), and treating them as glob syntax would misread
 * real directory names such as Next.js's `app/[id]/page.tsx`.
 */
const GLOB_CHARS = /[*?{]/

/** Normalise a path for matching: forward slashes, no `./`, no trailing slash. */
export function normalizePath(path: string): string {
  let out = path.replace(/\\/g, '/').trim()
  while (out.startsWith('./')) out = out.slice(2)
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

/**
 * Compile a glob to an anchored RegExp.
 *
 * Exported so callers that match one pattern against many paths can hoist the
 * compilation, though the cache makes that mostly unnecessary.
 */
export function compileGlob(pattern: string): RegExp {
  const key = pattern
  const hit = cache.get(key)
  if (hit) return hit

  const compiled = new RegExp(`^${globToRegexSource(normalizePath(pattern))}$`)

  if (cache.size >= MAX_CACHE) cache.clear()
  cache.set(key, compiled)
  return compiled
}

/** Translate a glob into regex source. */
function globToRegexSource(pattern: string): string {
  let out = ''
  let i = 0

  while (i < pattern.length) {
    const ch = pattern[i]

    if (ch === '*') {
      const isDouble = pattern[i + 1] === '*'
      if (isDouble) {
        // `a/**/b` must also match `a/b`, so the globstar swallows the
        // following slash rather than leaving an unmatchable separator.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 3
        } else {
          out += '.*'
          i += 2
        }
      } else {
        out += '[^/]*'
        i += 1
      }
      continue
    }

    if (ch === '?') {
      out += '[^/]'
      i += 1
      continue
    }

    if (ch === '{') {
      const close = findClosingBrace(pattern, i)
      if (close === -1) {
        out += '\\{'
        i += 1
        continue
      }
      const options = splitTopLevel(pattern.slice(i + 1, close))
      out += `(?:${options.map(globToRegexSource).join('|')})`
      i = close + 1
      continue
    }

    out += escapeRegex(ch)
    i += 1
  }

  return out
}

/** Index of the `}` matching the `{` at `open`, or -1. */
function findClosingBrace(pattern: string, open: number): number {
  let depth = 0
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++
    else if (pattern[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Split on commas that are not inside a nested brace group. */
function splitTopLevel(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''

  for (const ch of body) {
    if (ch === '{') depth++
    if (ch === '}') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)

  return out
}

function escapeRegex(ch: string): string {
  return /[.+^$()|[\]\\]/.test(ch) ? `\\${ch}` : ch
}

// ── Matching ────────────────────────────────────────────────────────────────

/** Whether a workspace-relative path matches a single glob. */
export function matchesGlob(path: string, pattern: string): boolean {
  if (!pattern) return false
  return compileGlob(pattern).test(normalizePath(path))
}

/**
 * Match against a list of patterns, honouring `!` negation.
 *
 * A path matches when at least one positive pattern matches and no negated
 * pattern does. A list of only negations matches everything not excluded.
 */
export function matchesAny(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false

  const normalized = normalizePath(path)
  let positives = 0
  let matched = false

  for (const raw of patterns) {
    const isNegated = raw.startsWith('!')
    const pattern = isNegated ? raw.slice(1) : raw
    if (!pattern) continue

    if (isNegated) {
      if (compileGlob(pattern).test(normalized)) return false
      continue
    }

    positives++
    if (compileGlob(pattern).test(normalized)) matched = true
  }

  return positives === 0 ? true : matched
}

/**
 * Whether a path falls under a stored `scope_paths` entry.
 *
 * Scope entries are a mix of globs (`src/api/**`, seeded from rule-file
 * frontmatter) and plain paths (`src/billing`, `src/billing/Invoice.java`,
 * seeded from extraction). A plain entry is treated as a prefix: naming a
 * directory scopes a fact to everything inside it, which is what someone
 * writing `src/billing` means.
 */
export function matchesScopePath(path: string, scopePath: string): boolean {
  const entry = normalizePath(scopePath)
  if (!entry) return false

  const target = normalizePath(path)

  if (GLOB_CHARS.test(entry)) return compileGlob(entry).test(target)

  return target === entry || target.startsWith(`${entry}/`)
}

/** Whether any of the active paths falls under any of the fact's scope entries. */
export function anyPathInScope(paths: string[], scopePaths: string[]): boolean {
  if (paths.length === 0 || scopePaths.length === 0) return false

  for (const scope of scopePaths) {
    for (const path of paths) {
      if (matchesScopePath(path, scope)) return true
    }
  }
  return false
}

/** Test-only: drop compiled patterns so cache behaviour can be asserted. */
export function clearGlobCache(): void {
  cache.clear()
}
