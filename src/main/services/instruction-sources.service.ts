/**
 * instruction-sources — discovery of agent rule files beyond workspace CLAUDE.md.
 *
 * A long-lived repository accumulates instructions in whatever format the tool
 * of the day expected: AGENTS.md, .cursor/rules/*.mdc, copilot-instructions.md,
 * .clinerules, .windsurfrules. Reading only CLAUDE.md throws all of that away —
 * and these files are the highest-signal prose in the tree, because a human
 * wrote them specifically to tell an agent how the project works.
 *
 * This module is pure filesystem + parsing: no LLM calls, no database writes.
 * It is consumed by the bootstrap planner (as extra doc items) and by the
 * prompt builder (as a concatenated instruction layer).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, basename, dirname, sep } from 'node:path'
import log from 'electron-log'

const isLog = log.scope('instruction-sources')

// ── Types ───────────────────────────────────────────────────────────────────

export type InstructionFormat =
  | 'claude-md'
  | 'agents-md'
  | 'cursor-mdc'
  | 'copilot'
  | 'cline'
  | 'windsurf'

/**
 * Precedence class. Ordering matters: later scopes override earlier ones when
 * the layers are concatenated for the prompt, mirroring Claude Code semantics.
 */
export type InstructionScope = 'user' | 'project' | 'local' | 'nested'

export interface InstructionSource {
  /** Absolute path on disk. */
  path: string
  scope: InstructionScope
  format: InstructionFormat
  /** Path globs this file applies to, from frontmatter (`globs`/`paths`/`applyTo`). */
  globs: string[]
  /** True when the file has no glob restriction, or declares `alwaysApply: true`. */
  alwaysApply: boolean
  /** File body with frontmatter stripped. */
  content: string
}

// ── Configuration ───────────────────────────────────────────────────────────

/** Directories never descended into when looking for nested rule files. */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', 'coverage',
  '.next', '.nuxt', '.cache', '__pycache__', '.tox', '.venv',
  'vendor', 'target', 'bin', 'obj', '.gradle', '.idea', '.vs'
])

/** How deep to search for nested AGENTS.md / CLAUDE.md below the root. */
const MAX_NESTED_DEPTH = 4

/** Hard cap so a pathological monorepo cannot stall discovery. */
const MAX_SOURCES = 300

/** Rule files are prose; anything larger is a generated artefact. */
const MAX_SOURCE_BYTES = 256 * 1024

/**
 * Root-level rule files, in precedence order.
 * `.local` variants are personal overrides and rank above the shared file.
 */
const ROOT_FILES: Array<{
  rel: string
  format: InstructionFormat
  scope: InstructionScope
}> = [
  { rel: 'CLAUDE.md', format: 'claude-md', scope: 'project' },
  { rel: 'AGENTS.md', format: 'agents-md', scope: 'project' },
  { rel: '.cursorrules', format: 'cursor-mdc', scope: 'project' },
  { rel: '.clinerules', format: 'cline', scope: 'project' },
  { rel: '.windsurfrules', format: 'windsurf', scope: 'project' },
  { rel: '.github/copilot-instructions.md', format: 'copilot', scope: 'project' },
  { rel: 'CLAUDE.local.md', format: 'claude-md', scope: 'local' },
  { rel: 'AGENTS.local.md', format: 'agents-md', scope: 'local' }
]

/** Directories holding one rule file per topic. */
const RULE_DIRS: Array<{
  rel: string
  format: InstructionFormat
  match: RegExp
}> = [
  { rel: '.cursor/rules', format: 'cursor-mdc', match: /\.(mdc|md)$/i },
  { rel: '.github/instructions', format: 'copilot', match: /\.(instructions\.md|md)$/i },
  { rel: '.clinerules', format: 'cline', match: /\.md$/i },
  { rel: '.windsurf/rules', format: 'windsurf', match: /\.md$/i }
]

/** Basenames that count as a nested per-directory rule file. */
const NESTED_NAMES = new Set(['claude.md', 'agents.md'])

/** Sort key for precedence: user → project → local → nested. */
const SCOPE_ORDER: Record<InstructionScope, number> = {
  user: 0,
  project: 1,
  local: 2,
  nested: 3
}

// ── Frontmatter parsing ─────────────────────────────────────────────────────

/**
 * Minimal YAML frontmatter reader.
 *
 * Deliberately not a YAML parser: rule-file frontmatter in the wild is flat
 * `key: value`, inline arrays, and block lists. Supporting exactly that keeps
 * this dependency-free and predictable, and an unparsed key simply yields no
 * globs rather than throwing.
 */
export function parseFrontmatter(raw: string): {
  data: Record<string, string | string[] | boolean>
  body: string
} {
  const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw)
  if (!match) return { data: {}, body: raw }

  const data: Record<string, string | string[] | boolean> = {}
  const lines = match[1].split(/\r?\n/)

  let listKey: string | null = null
  let listValues: string[] = []

  const flushList = (): void => {
    if (listKey) {
      data[listKey] = listValues
      listKey = null
      listValues = []
    }
  }

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue

    // Block-list continuation: "  - value"
    const listItem = /^[ \t]*-[ \t]+(.*)$/.exec(line)
    if (listItem && listKey) {
      listValues.push(stripScalar(listItem[1]))
      continue
    }

    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (!kv) continue

    flushList()
    const key = kv[1]
    const rawValue = kv[2].trim()

    if (rawValue === '') {
      // Either an empty value or the header of a block list.
      listKey = key
      listValues = []
      data[key] = ''
      continue
    }

    if (rawValue === 'true' || rawValue === 'false') {
      data[key] = rawValue === 'true'
      continue
    }

    // Inline array: [a, b] or ["a", "b"]
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      data[key] = splitList(rawValue.slice(1, -1))
      continue
    }

    data[key] = stripScalar(rawValue)
  }
  flushList()

  return { data, body: raw.slice(match[0].length) }
}

/** Strip surrounding quotes and trailing inline comments from a scalar. */
function stripScalar(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1)
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Split a comma-separated list, honouring quoted entries and brace groups. */
function splitList(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  let quote: string | null = null

  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '{') depth++
    if (ch === '}') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  out.push(current.trim())

  return out.filter(Boolean)
}

/** Pull path globs out of parsed frontmatter, whichever key the tool used. */
function extractGlobs(data: Record<string, string | string[] | boolean>): string[] {
  const keys = ['globs', 'paths', 'applyTo', 'applyto', 'files', 'include']
  const out: string[] = []

  for (const key of keys) {
    const value = data[key]
    if (Array.isArray(value)) {
      out.push(...value.map((v) => v.trim()).filter(Boolean))
    } else if (typeof value === 'string' && value.trim()) {
      out.push(...splitList(value))
    }
  }

  // '**' and '**/*' are "everything" — that is alwaysApply, not a scope.
  return [...new Set(out.filter((g) => g !== '**' && g !== '**/*'))]
}

// ── Discovery ───────────────────────────────────────────────────────────────

/** A rule file located on disk, before its content has been read. */
export interface InstructionRef {
  path: string
  format: InstructionFormat
  scope: InstructionScope
}

/**
 * Locate every agent rule file for a workspace without reading any of them.
 *
 * Split out from `discoverInstructionSources` because the bootstrap planner
 * must stay read-free — it needs paths to size the work queue, and the
 * executor does the reading when it actually processes each file.
 *
 * Returned in precedence order (user → project → local → nested), which is the
 * order they must be concatenated in for the prompt: later files win.
 */
export function collectInstructionRefs(workspacePath: string): InstructionRef[] {
  const found: InstructionRef[] = []
  const seen = new Set<string>()

  const add = (
    path: string,
    format: InstructionFormat,
    scope: InstructionScope
  ): void => {
    if (found.length >= MAX_SOURCES) return
    if (seen.has(path)) return
    seen.add(path)
    found.push({ path, format, scope })
  }

  // User-level (~/.claude/CLAUDE.md). Applies to every workspace, so it is
  // returned for prompt assembly but callers ingesting *project* knowledge
  // should filter it out.
  try {
    const userFile = join(homedir(), '.claude', 'CLAUDE.md')
    if (isFile(userFile)) add(userFile, 'claude-md', 'user')
  } catch {
    /* no home directory — headless CI */
  }

  for (const entry of ROOT_FILES) {
    // `.clinerules` may be a directory; RULE_DIRS handles that case.
    const abs = join(workspacePath, entry.rel)
    if (isFile(abs)) add(abs, entry.format, entry.scope)
  }

  for (const dir of RULE_DIRS) {
    const abs = join(workspacePath, dir.rel)
    if (!isDirectory(abs)) continue
    for (const file of listRuleDir(abs, dir.match)) {
      add(file, dir.format, 'project')
    }
  }

  collectNested(workspacePath, 0, add)

  found.sort((a, b) => {
    const byScope = SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]
    if (byScope !== 0) return byScope
    return a.path.localeCompare(b.path)
  })

  return found
}

/**
 * Find and read every agent rule file that applies to a workspace.
 *
 * Returned in precedence order (user → project → local → nested), which is the
 * order they must be concatenated in for the prompt: later files win.
 *
 * `expand` inlines `@path` imports. It defaults to off because the importing
 * and imported files are usually *both* discovered here — expanding during
 * knowledge ingestion would extract the same prose twice. The prompt layer,
 * which needs one complete instruction blob, turns it on.
 */
export function discoverInstructionSources(
  workspacePath: string,
  opts?: { expand?: boolean }
): InstructionSource[] {
  const found: InstructionSource[] = []

  for (const ref of collectInstructionRefs(workspacePath)) {
    const source = readInstructionSource(ref.path, ref.format, ref.scope)
    if (!source) continue
    if (opts?.expand) source.content = expandImports(source)
    found.push(source)
  }

  isLog.debug(
    `[discoverInstructionSources] ${found.length} source(s) in ${workspacePath}: ` +
      found.map((s) => `${s.scope}/${s.format}`).join(', ')
  )

  return found
}

/** Read + parse one rule file. Returns null when unreadable or not prose. */
export function readInstructionSource(
  absPath: string,
  format: InstructionFormat,
  scope: InstructionScope
): InstructionSource | null {
  try {
    const stat = statSync(absPath)
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SOURCE_BYTES) return null

    const raw = readFileSync(absPath, 'utf-8')
    const { data, body } = parseFrontmatter(raw)
    if (!body.trim()) return null

    const globs = extractGlobs(data)
    const declaredAlways = data.alwaysApply === true || data.always_apply === true

    return {
      path: absPath,
      scope,
      format,
      globs,
      alwaysApply: declaredAlways || globs.length === 0,
      content: body.trim()
    }
  } catch (err) {
    isLog.debug(`[readInstructionSource] Skipped ${absPath}:`, err)
    return null
  }
}

/** Nested per-directory CLAUDE.md / AGENTS.md below the workspace root. */
function collectNested(
  dir: string,
  depth: number,
  add: (path: string, format: InstructionFormat, scope: InstructionScope) => void
): void {
  if (depth > MAX_NESTED_DEPTH) return

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  for (const entry of entries) {
    const abs = join(dir, entry)
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(abs)
    } catch {
      continue
    }

    if (stat.isDirectory()) {
      if (IGNORE_DIRS.has(entry.toLowerCase())) continue
      collectNested(abs, depth + 1, add)
      continue
    }

    // Depth 0 is the root — those files are handled by ROOT_FILES with the
    // correct 'project' scope; re-adding them here would mark them 'nested'.
    if (depth === 0) continue
    if (!stat.isFile()) continue

    const lower = entry.toLowerCase()
    if (!NESTED_NAMES.has(lower)) continue
    add(abs, lower.startsWith('claude') ? 'claude-md' : 'agents-md', 'nested')
  }
}

/** List rule files inside a rules directory, one level of nesting deep. */
function listRuleDir(dir: string, match: RegExp): string[] {
  const out: string[] = []

  const walk = (current: string, depth: number): void => {
    if (depth > 2) return
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(current, entry)
      try {
        const stat = statSync(abs)
        if (stat.isDirectory()) {
          if (!IGNORE_DIRS.has(entry.toLowerCase())) walk(abs, depth + 1)
        } else if (stat.isFile() && match.test(entry)) {
          out.push(abs)
        }
      } catch {
        /* skip */
      }
    }
  }

  walk(dir, 0)
  return out.sort()
}

// ── @path import expansion ──────────────────────────────────────────────

/** Maximum import hops, matching Claude Code. */
const MAX_IMPORT_DEPTH = 4

/**
 * `@path` reference. Requires a path-like specifier so that prose such as
 * `@octocat` or an email address is not mistaken for an import.
 *
 * Built fresh per call: `expandContent` recurses from inside its own match
 * loop, and a shared global regex would have its `lastIndex` reset by the
 * nested call — rescanning text it had already consumed, forever.
 */
const importPattern = (): RegExp =>
  /@((?:~\/|\.{1,2}\/|\/)?[A-Za-z0-9_.\-/]*[A-Za-z0-9_.\-][A-Za-z0-9_.\-/]*)/g

/** Fenced blocks and inline code spans, whose contents are never expanded. */
const codePattern = (): RegExp =>
  /(^|\n)[ \t]*(`{3,}|~{3,})[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)|`[^`\n]*`/g

/**
 * Expand `@path` imports in a rule file, following Claude Code semantics.
 *
 * Imports are resolved relative to the *importing* file, capped at
 * {@link MAX_IMPORT_DEPTH} hops, and cycle-safe. References inside fenced code
 * blocks or inline code spans are left alone — a README showing `@scope/pkg`
 * in a snippet is documentation, not an instruction to inline a file.
 *
 * Unresolvable imports are left verbatim rather than dropped, so a typo stays
 * visible instead of silently deleting a line.
 */
export function expandImports(
  source: Pick<InstructionSource, 'path' | 'content'>,
  maxDepth: number = MAX_IMPORT_DEPTH
): string {
  return expandContent(source.content, dirname(source.path), maxDepth, new Set([source.path]))
}

function expandContent(
  content: string,
  baseDir: string,
  remainingDepth: number,
  visited: Set<string>
): string {
  if (remainingDepth <= 0) return content

  const protectedRanges = codeRanges(content)
  let out = ''
  let cursor = 0

  const re = importPattern()
  let match: RegExpExecArray | null

  while ((match = re.exec(content)) !== null) {
    const start = match.index

    // An '@' glued to a preceding word is an email address or a handle, not an
    // import: `support@example.com`, `npm i @scope/pkg` is fine but `x@y` is not.
    const prev = start > 0 ? content[start - 1] : '\n'
    if (!/[\s(\[{,;:]/.test(prev)) continue

    if (inRanges(protectedRanges, start)) continue

    const spec = match[1]
    const resolved = resolveImport(spec, baseDir)
    if (!resolved) continue

    out += content.slice(cursor, start)
    cursor = start + match[0].length

    if (visited.has(resolved)) {
      out += `<!-- circular import skipped: ${spec} -->`
      continue
    }

    let imported: string
    try {
      const stat = statSync(resolved)
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) {
        out += match[0]
        continue
      }
      imported = parseFrontmatter(readFileSync(resolved, 'utf-8')).body.trim()
    } catch {
      // Missing file — keep the reference so the author can see it failed.
      out += match[0]
      continue
    }

    const nested = expandContent(
      imported,
      dirname(resolved),
      remainingDepth - 1,
      new Set([...visited, resolved])
    )

    out += `\n<!-- imported: ${spec} -->\n${nested}\n`
  }

  out += content.slice(cursor)
  return out
}

/** Resolve an import specifier against the importing file's directory. */
function resolveImport(spec: string, baseDir: string): string | null {
  if (!spec) return null
  try {
    if (spec.startsWith('~/')) return join(homedir(), spec.slice(2))
    if (spec.startsWith('/')) return spec
    return join(baseDir, spec)
  } catch {
    return null
  }
}

/** Character ranges covered by fenced blocks or inline code spans. */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const re = codePattern()
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length])
    // Zero-length matches would spin forever.
    if (m[0].length === 0) re.lastIndex++
  }
  return ranges
}

function inRanges(ranges: Array<[number, number]>, index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end)
}

// ── Classification (used by the bootstrap executor) ──────────────────────────

/**
 * Decide whether a workspace-relative path is an agent rule file.
 *
 * The bootstrap executor already holds the file's content when it needs this,
 * so classification is path-only and the caller supplies the content — no
 * second read, and no need to persist source metadata through the item queue.
 */
export function classifyInstructionPath(relPath: string): InstructionFormat | null {
  const normalized = relPath.split(sep).join('/')
  const name = basename(normalized).toLowerCase()
  const parent = dirname(normalized).split('/').join('/')

  if (name === 'claude.md' || name === 'claude.local.md') return 'claude-md'
  if (name === 'agents.md' || name === 'agents.local.md') return 'agents-md'
  if (name === '.cursorrules' || parent.endsWith('.cursor/rules')) return 'cursor-mdc'
  if (name === 'copilot-instructions.md' || parent.endsWith('.github/instructions')) {
    return 'copilot'
  }
  if (name === '.clinerules' || parent.endsWith('.clinerules')) return 'cline'
  if (name === '.windsurfrules' || parent.endsWith('.windsurf/rules')) return 'windsurf'

  return null
}

/**
 * Scope paths to attach to facts extracted from a rule file.
 *
 * A rule file's own frontmatter already states which parts of the tree it
 * governs — that is exactly the `scope_paths` a fact needs to be activated on
 * the right files later, so it is seeded rather than inferred.
 */
export function scopePathsForSource(
  workspacePath: string,
  absPath: string,
  globs: string[]
): string[] {
  if (globs.length > 0) return globs.slice(0, 10)

  // No declared globs: a nested rule file governs its own directory; a root
  // file governs the whole workspace and gets no scope at all.
  const rel = relative(workspacePath, dirname(absPath))
  if (!rel || rel.startsWith('..')) return []
  return [rel.split(sep).join('/')]
}

/**
 * Scope paths for a rule file whose content the caller already holds.
 *
 * Saves the bootstrap executor a second read of a file it has just parsed.
 */
export function instructionScopePaths(
  workspacePath: string,
  absPath: string,
  rawContent: string
): string[] {
  const { data } = parseFrontmatter(rawContent)
  return scopePathsForSource(workspacePath, absPath, extractGlobs(data))
}

/** Files under the workspace that carry project knowledge (excludes user scope). */
export function projectInstructionSources(workspacePath: string): InstructionSource[] {
  return discoverInstructionSources(workspacePath).filter((s) => s.scope !== 'user')
}

// ── Prompt formatting ──────────────────────────────────────────────────

/** Total characters the instruction layer may contribute to a prompt. */
export const MAX_INSTRUCTION_LAYER_CHARS = 12_000

/** Per-file cap, so one sprawling rule file cannot crowd out the rest. */
const MAX_INSTRUCTION_FILE_CHARS = 4_000

/**
 * Render rule files as a single prompt layer.
 *
 * Sources arrive in precedence order and are emitted in that order, so a
 * later file's instruction is the last thing the model reads on any topic the
 * two disagree about. Each block is labelled with its path so the model can
 * attribute a rule, and with its globs when it only governs part of the tree.
 */
export function formatInstructionSources(
  sources: InstructionSource[],
  workspacePath: string,
  budget: number = MAX_INSTRUCTION_LAYER_CHARS
): string {
  if (sources.length === 0) return ''

  const blocks: string[] = []
  let used = 0
  const seen = new Set<string>()

  for (const source of sources) {
    if (seen.has(source.path)) continue
    seen.add(source.path)

    const label = displayPath(workspacePath, source.path)
    const scopeNote =
      source.globs.length > 0 ? ` (applies to: ${source.globs.slice(0, 5).join(', ')})` : ''
    const body = source.content.slice(0, MAX_INSTRUCTION_FILE_CHARS)
    const block = `### ${label}${scopeNote}\n\n${body}`

    if (used + block.length > budget) break
    blocks.push(block)
    used += block.length
  }

  if (blocks.length === 0) return ''
  return `## Project Agent Instructions\n\n${blocks.join('\n\n')}`
}

/** Workspace-relative label, or `~/...` for the user-level file. */
function displayPath(workspacePath: string, absPath: string): string {
  const rel = relative(workspacePath, absPath)
  if (rel && !rel.startsWith('..')) return rel.split(sep).join('/')

  try {
    const fromHome = relative(homedir(), absPath)
    if (fromHome && !fromHome.startsWith('..')) return `~/${fromHome.split(sep).join('/')}`
  } catch {
    /* no home directory */
  }
  return absPath
}

/**
 * Workspace-relative file paths, for matching user-configured globs.
 *
 * Bounded in both depth and count: this exists to resolve a handful of
 * `packages/*\/AGENTS.md`-style patterns, not to index the repository.
 */
export function listWorkspaceFiles(
  workspacePath: string,
  maxDepth = 5,
  maxFiles = 5_000
): string[] {
  const out: string[] = []

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || out.length >= maxFiles) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return
      const abs = join(dir, entry)
      try {
        const stat = statSync(abs)
        if (stat.isDirectory()) {
          if (!IGNORE_DIRS.has(entry.toLowerCase())) walk(abs, depth + 1)
        } else if (stat.isFile()) {
          out.push(relative(workspacePath, abs).split(sep).join('/'))
        }
      } catch {
        /* skip */
      }
    }
  }

  walk(workspacePath, 0)
  return out
}

// ── Small filesystem helpers ────────────────────────────────────────────────

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}
