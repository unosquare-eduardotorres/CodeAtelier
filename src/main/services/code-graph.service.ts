import { EventEmitter } from 'node:events'
import { statSync, readFileSync, readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import log from 'electron-log/main'
import { codeGraphTagRepository } from '../db/repositories'
import { codeGraphEdgeRepository } from '../db/repositories'
import { codeGraphRankRepository } from '../db/repositories'
import type { RepomapTag } from '../db/repositories/code-graph-tag.repository'
import type { EdgeType, EdgeResolution } from '../db/repositories/code-graph-edge.repository'
import type { CodeGraphIndexingState } from '../../shared/types'
import { extractTypedTags, releaseTypedParser } from './code-graph-tags'
import { detectCommunities, findGodNodes } from './code-graph-communities'
import type { Community, GodNode } from './code-graph-communities'
import {
  CaseInsensitiveSet,
  isExcludedPath,
  isExcludedDirName,
  isMarkupFile,
  sizeCapForFile,
  toPosixRel,
  matchesSkipPattern
} from './code-graph-exclusions'
import { loadAllIgnorePatterns } from './workspace-ignore'
import { memoryCheckpoint } from './indexing-diagnostics'

/**
 * Directories repomap-mcp prunes internally — mirrored so our walker matches.
 * Uses CaseInsensitiveSet so "Build", "Dist", "Vendor" etc. are excluded on
 * case-insensitive filesystems (Windows NTFS, macOS HFS+).
 */
const REPOMAP_EXCLUDED_DIRS = new CaseInsensitiveSet([
  'node_modules', '__pycache__', 'venv', 'env', '.venv', '.env', 'dist', 'build',
  '.next', '.nuxt', 'target', 'vendor', '.bundle', 'coverage', '.nyc_output', '.tox', 'egg-info'
])

export interface DiscoveryResult {
  files: string[]
  prunedDirs: number
  oversizeSkipped: number
}

/**
 * Pruning file walker.
 *
 * Replaces `findSrcFiles(...).filter(...)`, which walked the ENTIRE tree —
 * including vendored NUnit and generated-doc directories — and only then
 * discarded the results. On a 280K-file tree that traversal alone was the
 * bulk of the scan cost. Here an excluded directory is never descended into.
 *
 * Also enforces the per-file size caps, which previously did not exist.
 */
export function discoverSrcFiles(
  workspacePath: string,
  isSupportedFile: (f: string) => boolean
): DiscoveryResult {
  const ignorePatterns = loadAllIgnorePatterns(workspacePath)
  const files: string[] = []
  let prunedDirs = 0
  let oversizeSkipped = 0

  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      const relPath = toPosixRel(fullPath, workspacePath)

      if (entry.name.startsWith('.')) continue

      if (entry.isDirectory()) {
        if (REPOMAP_EXCLUDED_DIRS.has(entry.name) || isExcludedDirName(entry.name)) {
          prunedDirs++
          continue
        }
        if (
          ignorePatterns.length > 0 &&
          (matchesSkipPattern(relPath, ignorePatterns) ||
            matchesSkipPattern(`${relPath}/`, ignorePatterns))
        ) {
          prunedDirs++
          continue
        }
        walk(fullPath)
      } else if (entry.isFile()) {
        if (!isSupportedFile(fullPath)) continue
        if (ignorePatterns.length > 0 && matchesSkipPattern(relPath, ignorePatterns)) continue
        try {
          if (statSync(fullPath).size > sizeCapForFile(fullPath)) {
            oversizeSkipped++
            continue
          }
        } catch {
          continue
        }
        files.push(fullPath)
      }
    }
  }

  walk(workspacePath)
  return { files, prunedDirs, oversizeSkipped }
}

// ── Race-condition guard for tree-sitter initialization ──

let initParserPromise: Promise<void> | null = null

/**
 * Serialized initParser — prevents the race condition in repomap-mcp's
 * initializeBinding() where concurrent calls both see Module3 === null
 * and create duplicate Emscripten instances.
 */
async function safeInitParser(initParser: () => Promise<void>): Promise<void> {
  if (!initParserPromise) {
    initParserPromise = initParser()
  }
  return initParserPromise
}

/**
 * Core service for persisted code graph indexing and queries.
 *
 * Replaces the `repomap-mcp` RepoMap class orchestration with our own
 * DB-backed implementation. Still uses repomap-mcp for Tree-sitter parsing,
 * PageRank algorithm, file discovery, and tree context rendering.
 *
 * Key differences from the old approach:
 * - Indexes once, persists to SQLite → agent tool calls read from DB (instant)
 * - Incremental re-indexing via file mtime comparison
 * - Progress events streamed to renderer via IPC
 */
/** Edge in the code graph: a reference from one file to a definition in another. */
interface GraphEdge {
  from: string
  to: string
  name: string
  edgeType: EdgeType
  resolution: EdgeResolution
  /** How many files defined this symbol name — 1 means the match was unambiguous. */
  defFanout: number
}

/**
 * Fan-out above which a name/definition match is flagged as a guess
 * (`resolution: 'ambiguous'`). The edge is still stored — only labelled.
 */
export const AMBIGUOUS_FANOUT = 8

/**
 * Fan-out above which edges are not stored at all: a name defined in this many
 * files (`handle`, `render`, `id`, …) is an identifier collision, and the
 * ref×def cartesian product it generates is pure noise.
 *
 * Set to `Infinity` to disable dropping entirely. Both numbers come from measuring
 * six real indexed workspaces with `scripts/codegraph-fanout-report.ts`:
 *
 *   - Fan-out >32 is where names stop being symbols and become noise: in the
 *     largest workspace measured, 16 such names produced 71% of all edges
 *     (`T` alone: fan-out 123 → 8,795 edges; then `type`, `apply`, `get`).
 *   - Fan-out 17-32 still carries real relationships (query-builder methods like
 *     `from`/`select`/`eq` in one workspace), so cutting lower loses recall —
 *     at ≤16 that workspace lost 46% of its edges.
 *   - This repo is barely affected either way: ≤8 already retains 99.5%.
 */
export const AMBIGUITY_THRESHOLD = 32

/**
 * Map a (reference subtype, definition subtype) pair to a typed edge.
 * Pure — the truth table lives here and nowhere else.
 *
 * Only relationships the `.scm` queries actually encode unambiguously are typed:
 *   - `reference.call` / `reference.send` / `reference.constructor` → `calls`
 *   - `reference.implementation` / `reference.interface`           → `implements`
 *   - `reference.module` onto a module definition                  → `imports`
 *
 * `extends` is deliberately never emitted: the only candidate signal,
 * `reference.class`, is overloaded across grammars — Java uses it for both
 * `(superclass)` and `(object_creation_expression)`, C# for base lists, `new`,
 * generic constraints and variable types. A wrong edge type is worse than a
 * generic one, so those collapse to `references`.
 */
export function deriveEdgeType(
  refKind: string | null | undefined,
  defKind: string | null | undefined
): EdgeType {
  switch (refKind) {
    case 'call':
    case 'send':
    case 'constructor':
      return 'calls'
    case 'implementation':
    case 'interface':
      return 'implements'
    case 'module':
      return defKind === 'module' || defKind == null ? 'imports' : 'references'
    default:
      return 'references'
  }
}

/**
 * Priority order when one file uses the same name in several roles (e.g. calls
 * `Foo()` and annotates `: Foo`). The most specific relationship wins so the
 * edge is typed by the strongest evidence available.
 */
const KIND_PRIORITY = [
  'call',
  'send',
  'constructor',
  'implementation',
  'interface',
  'module',
  'function',
  'method',
  'class',
  'type'
]

function kindRank(kind: string | null | undefined): number {
  if (kind == null) return KIND_PRIORITY.length + 1
  const idx = KIND_PRIORITY.indexOf(kind)
  return idx === -1 ? KIND_PRIORITY.length : idx
}

/** Collapse a file's several capture subtypes for one name into the strongest one. */
function strongerKind(
  current: string | null | undefined,
  incoming: string | null | undefined
): string | null {
  if (current === undefined) return incoming ?? null
  return kindRank(incoming) < kindRank(current) ? (incoming ?? null) : (current ?? null)
}

/**
 * Build edge list from defines/references tag maps.
 * Pure function: takes tags, returns edge list.
 * An edge is created from each reference file to each definition file for the same symbol,
 * excluding self-references (ref and def in same file).
 *
 * Each edge carries provenance:
 *   - `resolution: 'extracted'` when exactly one file defines the name
 *   - `resolution: 'inferred'`  when several files do (this edge is one of N guesses)
 *   - `resolution: 'ambiguous'` above AMBIGUITY_THRESHOLD, where the name is almost
 *     certainly a collision rather than a relationship
 */
export function buildEdgesFromTags(
  tags: RepomapTag[],
  ambiguityThreshold: number = AMBIGUITY_THRESHOLD
): GraphEdge[] {
  // name → (file → strongest capture subtype seen in that file)
  const defines = new Map<string, Map<string, string | null>>()
  const references = new Map<string, Map<string, string | null>>()
  for (const tag of tags) {
    const map = tag.kind === 'def' ? defines : references
    let byFile = map.get(tag.name)
    if (!byFile) {
      byFile = new Map()
      map.set(tag.name, byFile)
    }
    byFile.set(tag.relFname, strongerKind(byFile.get(tag.relFname), tag.symbolKind))
  }

  const edges: GraphEdge[] = []
  for (const [name, refFiles] of references) {
    const defFiles = defines.get(name)
    if (!defFiles) continue
    const defFanout = defFiles.size
    if (defFanout > ambiguityThreshold) continue
    const resolution: EdgeResolution =
      defFanout === 1 ? 'extracted' : defFanout <= AMBIGUOUS_FANOUT ? 'inferred' : 'ambiguous'
    for (const [refFile, refKind] of refFiles) {
      for (const [defFile, defKind] of defFiles) {
        if (refFile === defFile) continue
        edges.push({
          from: refFile,
          to: defFile,
          name,
          edgeType: deriveEdgeType(refKind, defKind),
          resolution,
          defFanout
        })
      }
    }
  }
  return edges
}

/**
 * Apply focus/priority boosts to pre-computed PageRank scores.
 * Pure function: takes ranks + boost config, returns new boosted Map.
 *
 * Boost multipliers:
 * - Focus files: 20x
 * - Priority files: 5x
 * - Files containing priority identifiers: 3x (matched case-insensitively against tag names)
 */
export function applyRankBoosts(
  ranks: Map<string, number>,
  focusFiles: string[],
  priorityFiles: string[],
  priorityIdentifiers: string[],
  tags: RepomapTag[]
): Map<string, number> {
  const boostedRanks = new Map(ranks)

  for (const file of focusFiles) {
    const current = boostedRanks.get(file) ?? 0
    boostedRanks.set(file, current * 20)
  }
  for (const file of priorityFiles) {
    const current = boostedRanks.get(file) ?? 0
    boostedRanks.set(file, current * 5)
  }

  if (priorityIdentifiers.length > 0) {
    const identifierSet = new Set(priorityIdentifiers.map((id) => id.toLowerCase()))
    for (const tag of tags) {
      if (identifierSet.has(tag.name.toLowerCase())) {
        const current = boostedRanks.get(tag.relFname) ?? 0
        boostedRanks.set(tag.relFname, current * 3)
      }
    }
  }

  return boostedRanks
}

/**
 * Filter and sort files by boosted rank descending.
 * When excludeUnranked is true, files with rank === 0 are removed.
 */
export function sortAndFilterByRank(
  boostedRanks: Map<string, number>,
  excludeUnranked: boolean
): Array<[string, number]> {
  return [...boostedRanks.entries()]
    .filter(([, rank]) => !excludeUnranked || rank > 0)
    .sort((a, b) => b[1] - a[1])
}

// ADDITIONAL_EXCLUDED_DIRS and isExcludedPath imported from ./code-graph-exclusions
// (extracted to a dependency-free module for testability)

class CodeGraphService extends EventEmitter {
  private indexingStates = new Map<string, CodeGraphIndexingState>()

  /** Cached subsystem detection — recomputing per graph_map call is wasteful. */
  private subsystemCache = new Map<
    string,
    { computedAt: number; communities: Community[]; godNodes: GodNode[] }
  >()
  private static readonly SUBSYSTEM_CACHE_MS = 5 * 60_000

  /** Track whether we've logged a diagnostic for this session */
  private diagnosticLogged = false

  /**
   * Wrap getTags with diagnostic logging on first failure.
   * getTagsRaw in repomap-mcp has 4 silent return-[] paths:
   *   1. filenameToLang(fname) → null
   *   2. loadLanguage(lang) throws → caught, returns []
   *   3. loadQuery(language, lang) → null
   *   4. readFileSync(fname) throws → caught, returns []
   * Plus parser.setLanguage() is NOT in a try/catch — throws propagate.
   */
  private async getTagsWithDiagnostics(
    getTags: typeof import('repomap-mcp/dist/tags.js').getTags,
    fname: string,
    relFname: string,
    filenameToLang: (f: string) => string | null
  ): Promise<RepomapTag[]> {
    try {
      const tags = await getTags(fname, relFname, null, false)
      if (tags.length > 0 && this.diagnosticLogged) {
        log.info(`[CodeGraph] ✓ Parsing recovered — got ${tags.length} tags from ${relFname}`)
        this.diagnosticLogged = false
      }
      return tags
    } catch (error) {
      // getTags threw — this means parser.setLanguage() or query.captures() failed
      if (!this.diagnosticLogged) {
        const lang = filenameToLang(fname)
        log.error(
          `[CodeGraph] getTags threw for ${relFname} (lang=${lang}): ${(error as Error).message}`
        )
        log.error(
          `[CodeGraph] Stack: ${(error as Error).stack?.split('\n').slice(0, 3).join('\n')}`
        )
        this.diagnosticLogged = true
      }
      return []
    }
  }

  /**
   * Parse one file, preferring the subtype-preserving extractor.
   *
   * `extractTypedTags` returns `null` when typed extraction cannot run (grammar
   * or query missing, WASM failure, kill switch) — in that case we fall back to
   * repomap-mcp's `getTags`, which yields the same tags without `symbolKind`.
   * Edges from untyped tags degrade to `edgeType: 'references'`, never to zero.
   *
   * `typed` reports which path ran so callers can count fallbacks: a silent
   * 100% fallback rate is indistinguishable from success in the output alone.
   */
  private async parseFileTags(
    getTags: typeof import('repomap-mcp/dist/tags.js').getTags,
    fname: string,
    relFname: string,
    filenameToLang: (f: string) => string | null
  ): Promise<{ tags: RepomapTag[]; typed: boolean }> {
    const typed = await extractTypedTags(fname, relFname, filenameToLang)
    if (typed !== null) return { tags: typed, typed: true }
    return {
      tags: await this.getTagsWithDiagnostics(getTags, fname, relFname, filenameToLang),
      typed: false
    }
  }

  /**
   * Full workspace indexing — called when toggle is enabled or "Re-index" clicked.
   * Phases: discover files → parse tags → build edges → PageRank → persist
   */
  async indexWorkspace(workspaceId: string, workspacePath: string): Promise<void> {
    const { getTags, initParser } =
      (await import('repomap-mcp/dist/tags.js')) as typeof import('repomap-mcp/dist/tags.js')
    const { isSupportedFile, filenameToLang } =
      (await import('repomap-mcp/dist/languages.js')) as typeof import('repomap-mcp/dist/languages.js')

    const state: CodeGraphIndexingState = {
      workspaceId,
      status: 'scanning',
      totalFiles: 0,
      processedFiles: 0,
      totalTags: 0,
      totalEdges: 0,
      currentFile: ''
    }
    this.indexingStates.set(workspaceId, state)
    this.emitProgress(state)

    try {
      await safeInitParser(initParser)

      // Phase 1: Discover files with a PRUNING walker.
      // Excluded directories (bin, obj, packages, BuildSystem, Tools,
      // ThirdParty, ...) plus .gitignore/.atelierignore rules are applied at
      // the directory level, so vendored trees are never traversed at all.
      const discovery = discoverSrcFiles(workspacePath, isSupportedFile)
      const allFiles = discovery.files
      log.info(
        `[CodeGraph] Discovery: ${allFiles.length} files, ${discovery.prunedDirs} directories pruned, ` +
          `${discovery.oversizeSkipped} oversize files skipped`
      )

      // ── Health check: verify tree-sitter parsing works ──
      // getTagsRaw silently returns [] on failure. Test with a known file
      // to catch Electron-specific WASM issues before processing all files.
      try {
        const testFile = allFiles[0]
        if (testFile) {
          const testRelFname = toPosixRel(testFile, workspacePath)
          const testTags = await getTags(testFile, testRelFname, null, false)
          if (testTags.length === 0) {
            const lang = filenameToLang(testFile)
            log.warn(
              `[CodeGraph] ⚠ Health check: 0 tags from ${testRelFname} (lang=${lang}). ` +
                `Tree-sitter parsing may be broken in this runtime.`
            )

            // Try a step-by-step diagnostic
            try {
              const tagsModule = (await import('repomap-mcp/dist/tags.js')) as Record<
                string,
                unknown
              >
              if (typeof tagsModule.getTagsRaw === 'function') {
                const rawTags = await (
                  tagsModule.getTagsRaw as (f: string, r: string) => Promise<RepomapTag[]>
                )(testFile, testRelFname)
                log.warn(`[CodeGraph] ⚠ getTagsRaw returned ${rawTags.length} tags`)
              } else {
                log.warn('[CodeGraph] ⚠ getTagsRaw not exported — cannot run deeper diagnostic')
              }
            } catch (rawErr) {
              log.error(`[CodeGraph] ⚠ getTagsRaw threw: ${(rawErr as Error).message}`)
            }
          } else {
            log.info(
              `[CodeGraph] ✓ Health check passed: ${testTags.length} tags from ${testRelFname}`
            )
          }
        }
      } catch (healthErr) {
        log.error(`[CodeGraph] ⚠ Health check failed: ${(healthErr as Error).message}`)
      }
      state.totalFiles = allFiles.length
      state.status = 'parsing'
      this.emitProgress(state)

      // Phase 2: Parse tags (with incremental support via mtime comparison)
      const existingMtimes = codeGraphTagRepository.getFileMtimes(workspaceId)
      const allTags: RepomapTag[] = []
      const fileMtimes = new Map<string, number>()

      // A v130 upgrade leaves every row with symbol_kind = NULL while mtimes still
      // match, so the incremental cache would keep serving untyped tags forever.
      // Detect that once and re-parse everything.
      const forceReparse = codeGraphTagRepository.hasUntypedIndex(workspaceId)
      if (forceReparse) {
        log.info(
          '[CodeGraph] Untyped index detected - re-parsing all files to populate symbol kinds'
        )
      }

      let markupDropped = 0
      let filesParsed = 0
      let typedFallbacks = 0
      const changedFiles: string[] = []
      for (const fname of allFiles) {
        const relFname = toPosixRel(fname, workspacePath)
        state.currentFile = relFname

        try {
          const stat = statSync(fname)
          const existingMtime = existingMtimes.get(relFname)
          fileMtimes.set(relFname, stat.mtimeMs)

          if (existingMtime && stat.mtimeMs === existingMtime && !forceReparse) {
            // File unchanged — load cached tags from DB
            const cachedTags = codeGraphTagRepository.findByFile(workspaceId, relFname)
            allTags.push(...cachedTags)
          } else {
            // File changed or new — parse with Tree-sitter
            changedFiles.push(relFname)
            const { tags, typed } = await this.parseFileTags(
              getTags,
              fname,
              relFname,
              filenameToLang
            )
            filesParsed++
            if (!typed) typedFallbacks++
            // Generated markup (NUnit HTML docs, doxygen output) parses to zero
            // tags but still costs a node + mtime row per file. Drop it: it can
            // never contribute an edge, only bloat.
            if (tags.length === 0 && isMarkupFile(fname)) {
              markupDropped++
              fileMtimes.delete(relFname)
            } else {
              allTags.push(...tags)
            }
          }
        } catch (error) {
          if (!this.diagnosticLogged) {
            log.warn(`[CodeGraph] Failed to parse ${relFname}: ${(error as Error).message}`)
            this.diagnosticLogged = true
          }
        }

        state.processedFiles++
        // Emit every 25 files to avoid flooding IPC
        if (state.processedFiles % 25 === 0) this.emitProgress(state)
      }

      state.totalTags = allTags.length
      this.emitProgress(state)

      // Phase 3-5: Build edge graph, PageRank, persist
      state.status = 'ranking'
      this.emitProgress(state)

      codeGraphTagRepository.upsertTags(workspaceId, allTags, fileMtimes)

      // Node set comes from the files we actually kept (POSIX-relative keys),
      // NOT from the raw discovery list — dropped markup must not become a
      // PageRank node it can never earn rank for.
      const allNodes = new Set(fileMtimes.keys())
      if (markupDropped > 0) {
        log.info(`[CodeGraph] Dropped ${markupDropped} zero-tag markup file(s)`)
      }
      const { totalEdges } = await this.buildAndPersistGraph(workspaceId, allTags, allNodes)
      state.totalEdges = totalEdges

      // ── Memory release ──
      // Capture counts before releasing for the log and diagnostics
      const fileCount = allFiles.length
      const tagCount = allTags.length
      memoryCheckpoint('PRE_CLEANUP', {
        tags: tagCount,
        edges: totalEdges,
        files: fileCount
      })
      // Truncate arrays to release backing storage immediately
      // (setting .length = 0 is faster than reassignment for GC)
      allTags.length = 0
      allFiles.length = 0
      fileMtimes.clear()

      state.status = 'complete'
      // A completed full rebuild clears any prior degradation.
      state.degraded = false
      state.degradedReason = undefined
      // Typed extraction failing wholesale still produces a usable index, just an
      // untyped one, which looks identical from the outside. Say so out loud.
      if (filesParsed > 0 && typedFallbacks === filesParsed) {
        state.degraded = true
        state.degradedReason =
          'Typed tag extraction unavailable - edges fall back to untyped `references`. ' +
          'Check the tree-sitter query pack in the packaged app.'
      }
      log.info(
        `[CodeGraph] Indexing complete: ${fileCount} files, ${tagCount} tags, ${totalEdges} edges` +
          (typedFallbacks > 0
            ? `, ${typedFallbacks}/${filesParsed} file(s) fell back to untyped tags`
            : '')
      )
      this.emitProgress(state)
      this.mineRationales(workspaceId, workspacePath, changedFiles)
      this.postIndexCleanup(workspaceId)
    } catch (error) {
      state.status = 'error'
      state.error = (error as Error).message
      log.error('[CodeGraph] Indexing failed:', error)
      this.emitProgress(state)
      this.postIndexCleanup(workspaceId)
    }
  }

  /**
   * Build edge graph from all tags, compute PageRank, persist everything.
   * Shared by both indexWorkspace() and reindexFiles().
   */
  private async buildAndPersistGraph(
    workspaceId: string,
    allTags: RepomapTag[],
    allNodes?: Set<string>
  ): Promise<{ totalEdges: number }> {
    const { pagerank } =
      (await import('repomap-mcp/dist/pagerank.js')) as typeof import('repomap-mcp/dist/pagerank.js')

    // Build edges using extracted pure function
    const edges = buildEdgesFromTags(allTags)

    // PageRank — use provided nodes or derive from tags
    const nodes = allNodes ?? new Set(allTags.map((t) => t.relFname))
    const ranks = pagerank(nodes, edges)

    // Persist edges and ranks.
    // Use batched upsert to keep the UI responsive — inserts in chunks of 5K
    // with setImmediate() yields between batches. For large repos (5.5M edges),
    // a single synchronous transaction would freeze the main thread for seconds.
    const mappedEdges = edges.map((e) => ({
      workspaceId,
      sourceFile: e.from,
      sourceSymbol: e.name,
      targetFile: e.to,
      targetSymbol: e.name,
      edgeType: e.edgeType,
      pageRank: ranks.get(e.to) ?? 0,
      resolution: e.resolution,
      defFanout: e.defFanout
    }))
    await codeGraphEdgeRepository.upsertEdgesBatched(workspaceId, mappedEdges)
    codeGraphRankRepository.upsertRanks(workspaceId, ranks)

    // Capture count before releasing, then release large intermediate arrays.
    // At this point edges, mappedEdges, and ranks are fully persisted to SQLite.
    const totalEdges = edges.length
    mappedEdges.length = 0
    edges.length = 0
    ranks.clear()

    // Truncate the WAL after the largest write in the app. Without this the
    // journal stays saturated at journal_size_limit (256 MB), which is exactly
    // the 268 MB WAL observed during the freeze — checkpoint starvation under
    // continuous batched writes.
    try {
      const { getDatabase } = await import('../db')
      getDatabase().pragma('wal_checkpoint(TRUNCATE)')
    } catch (err) {
      log.warn(`[CodeGraph] WAL checkpoint after graph build failed: ${(err as Error).message}`)
    }

    return { totalEdges }
  }

  /**
   * Large-workspace threshold: when a workspace has more than this many tags,
   * skip the full graph rebuild on incremental file changes. The full rebuild
   * (DELETE + INSERT all edges) is O(tags²) and blocks the main thread for
   * seconds at 50K+ tags. Users can still trigger a full rebuild via "Re-index".
   */
  private static readonly LARGE_WORKSPACE_TAG_THRESHOLD = 50_000

  /**
   * Incremental re-index: re-parse only specified files, then rebuild
   * the full edge graph + PageRank from ALL persisted tags.
   * ~100ms for a few files vs ~3-8s for full workspace.
   *
   * For large workspaces (>50K tags), skips the full graph rebuild to avoid
   * multi-second main-thread freezes on every file save. The existing edge
   * graph remains valid enough for queries; a full rebuild is deferred to
   * the explicit "Re-index" button.
   */
  async reindexFiles(
    workspaceId: string,
    workspacePath: string,
    changedRelPaths: string[]
  ): Promise<void> {
    const { getTags, initParser } =
      (await import('repomap-mcp/dist/tags.js')) as typeof import('repomap-mcp/dist/tags.js')
    const { isSupportedFile, filenameToLang } =
      (await import('repomap-mcp/dist/languages.js')) as typeof import('repomap-mcp/dist/languages.js')
    await safeInitParser(initParser)

    // 1. Re-parse only changed files
    const newTags: RepomapTag[] = []
    const fileMtimes = new Map<string, number>()

    for (const relPath of changedRelPaths) {
      if (isExcludedPath(relPath)) continue
      const absPath = join(workspacePath, relPath)
      if (!isSupportedFile(absPath)) continue
      try {
        const stat = statSync(absPath)
        fileMtimes.set(relPath, stat.mtimeMs)
        const { tags } = await this.parseFileTags(getTags, absPath, relPath, filenameToLang)
        newTags.push(...tags)
      } catch (error) {
        const msg = (error as Error).message
        if (msg.includes('ENOENT') || msg.includes('no such file')) {
          // File deleted — remove its tags
          codeGraphTagRepository.deleteByFile(workspaceId, relPath)
        } else {
          log.warn(`[CodeGraph] reindexFiles: parse failed for ${relPath}: ${msg}`)
        }
      }
    }

    // 2. Upsert changed file tags
    if (newTags.length > 0) {
      codeGraphTagRepository.upsertTags(workspaceId, newTags, fileMtimes)
    }

    // 3. Check workspace size before full graph rebuild
    const totalTags = codeGraphTagRepository.countByWorkspace(workspaceId)
    if (totalTags > CodeGraphService.LARGE_WORKSPACE_TAG_THRESHOLD) {
      // Large workspace: skip full graph rebuild on incremental changes.
      // The DELETE + INSERT of millions of edges would freeze the main thread.
      // Tags are up-to-date; edge graph uses the prior full index.
      // User can trigger a full rebuild via the "Re-index" button.
      log.warn(
        `[CodeGraph] Large workspace (${totalTags} tags) — skipping full graph rebuild. ` +
          `Use Re-index for a complete refresh.`
      )
      // Surface the degradation instead of failing silently. A frozen graph
      // that still reports "healthy" is what made the last incident so hard
      // to diagnose.
      const degradedState: CodeGraphIndexingState = {
        ...(this.indexingStates.get(workspaceId) ?? {
          workspaceId,
          status: 'complete',
          totalFiles: 0,
          processedFiles: 0,
          totalTags,
          totalEdges: 0,
          currentFile: ''
        }),
        status: 'complete',
        totalTags,
        degraded: true,
        degradedReason:
          `Workspace has ${totalTags.toLocaleString()} tags (limit ` +
          `${CodeGraphService.LARGE_WORKSPACE_TAG_THRESHOLD.toLocaleString()}). ` +
          `The dependency graph is frozen at its last full build. ` +
          `Add vendored/generated directories to .atelierignore, then Re-index.`
      }
      this.indexingStates.set(workspaceId, degradedState)
      this.emitProgress(degradedState)
      return
    }

    // Small/medium workspace: full rebuild is fast enough
    const allTags = codeGraphTagRepository.findAllByWorkspace(workspaceId)
    await this.buildAndPersistGraph(workspaceId, allTags)
    allTags.length = 0  // release after persist

    log.info(`[CodeGraph] Incremental: ${changedRelPaths.length} files, ${newTags.length} new tags`)

    this.mineRationales(workspaceId, workspacePath, changedRelPaths)

    // Clean up after incremental reindex too
    this.postIndexCleanup(workspaceId)
  }

  /**
   * Mine `// WHY:` / `// HACK:` / ADR citations out of the files we just parsed
   * and hand them to the memory system. Fire-and-forget: indexing must never
   * fail or stall because rationale capture did.
   *
   * The miner is imported lazily so the standalone code-graph MCP server, which
   * loads this service, never pulls the memory engine into its process.
   */
  private mineRationales(workspaceId: string, workspacePath: string, relPaths: string[]): void {
    if (relPaths.length === 0) return
    void import('./rationale-miner.service')
      .then(({ rationaleMinerService }) =>
        rationaleMinerService.mineFiles(workspaceId, workspacePath, relPaths)
      )
      .catch((error) => log.warn(`[CodeGraph] Rationale mining failed: ${error.message}`))
  }

  /**
   * Generate a repo map from persisted data — NO filesystem walk, NO PageRank recomputation.
   * This is what the MCP tool calls instead of RepoMap.getRepoMap().
   */
  async getRepoMap(
    workspaceId: string,
    workspacePath: string,
    options: {
      focusFiles?: string[]
      priorityFiles?: string[]
      priorityIdentifiers?: string[]
      mapTokens?: number
      excludeUnranked?: boolean
    }
  ): Promise<{ map: string; report: object }> {
    const { renderTreeContext } =
      (await import('repomap-mcp/dist/tree-context.js')) as typeof import('repomap-mcp/dist/tree-context.js')
    const { countTokens } =
      (await import('repomap-mcp/dist/token-counter.js')) as typeof import('repomap-mcp/dist/token-counter.js')

    const mapTokens = options.mapTokens ?? 8192
    const focusFiles = options.focusFiles ?? []
    const priorityFiles = options.priorityFiles ?? []
    const priorityIdentifiers = options.priorityIdentifiers ?? []

    // Load pre-computed ranks from DB
    const ranks = codeGraphRankRepository.findByWorkspace(workspaceId)
    const tags = codeGraphTagRepository.findDefsByWorkspace(workspaceId)

    // Apply focus/priority boosts using extracted pure function
    const boostedRanks = applyRankBoosts(
      ranks,
      focusFiles,
      priorityFiles,
      priorityIdentifiers,
      tags
    )

    // Sort and filter using extracted pure function
    const rankedFiles = sortAndFilterByRank(boostedRanks, options.excludeUnranked ?? false)

    // Group definition tags by file
    const tagsByFile = new Map<string, RepomapTag[]>()
    for (const tag of tags) {
      let arr = tagsByFile.get(tag.relFname)
      if (!arr) {
        arr = []
        tagsByFile.set(tag.relFname, arr)
      }
      arr.push(tag)
    }

    // Render tree context for top-ranked files, fitting within token budget
    const lines: string[] = []
    let totalTokens = 0
    let filesIncluded = 0

    for (const [relFname] of rankedFiles) {
      const fileTags = tagsByFile.get(relFname)
      if (!fileTags || fileTags.length === 0) continue

      const absPath = `${workspacePath}/${relFname}`
      let code: string
      try {
        code = readFileSync(absPath, 'utf-8')
      } catch {
        continue // File may have been deleted since indexing
      }

      // Guard stale line refs — tags may reference lines beyond current file length
      const totalLines = code.split('\n').length
      const linesOfInterest = fileTags
        .map((t) => t.line)
        .filter((line) => line >= 1 && line <= totalLines)

      if (linesOfInterest.length === 0) continue // All tags were stale — skip file

      let rendered: string
      try {
        rendered = renderTreeContext(code, linesOfInterest)
      } catch (err) {
        log.warn(`[CodeGraph] renderTreeContext failed for ${relFname}:`, err)
        continue // Skip this file, don't crash the whole map
      }
      const entry = `${relFname}:\n${rendered}\n`
      const entryTokens = countTokens(entry)

      if (totalTokens + entryTokens > mapTokens && filesIncluded > 0) break

      lines.push(entry)
      totalTokens += entryTokens
      filesIncluded++
    }

    return {
      map: lines.join('\n'),
      report: {
        totalFilesConsidered: rankedFiles.length,
        filesIncluded,
        totalTokens,
        definitionTags: tags.length
      }
    }
  }

  /**
   * Detect subsystems (communities) and god nodes over the file dependency graph.
   * Cached for five minutes — the graph only changes on re-index.
   */
  getSubsystems(workspaceId: string): { communities: Community[]; godNodes: GodNode[] } {
    const cached = this.subsystemCache.get(workspaceId)
    if (cached && Date.now() - cached.computedAt < CodeGraphService.SUBSYSTEM_CACHE_MS) {
      return { communities: cached.communities, godNodes: cached.godNodes }
    }

    const pairs = codeGraphEdgeRepository.findFilePairs(workspaceId)
    const communities = detectCommunities(pairs)
    const godNodes = findGodNodes(pairs)
    this.subsystemCache.set(workspaceId, { computedAt: Date.now(), communities, godNodes })
    return { communities, godNodes }
  }

  /**
   * Search identifiers from DB — NO filesystem walk. Instant.
   */
  async searchIdentifiers(
    workspaceId: string,
    workspacePath: string,
    query: string,
    options?: {
      maxResults?: number
      includeDefinitions?: boolean
      includeReferences?: boolean
      /** Restrict to Tree-sitter capture subtypes, e.g. ['function', 'method']. */
      symbolKinds?: string[]
    }
  ): Promise<
    Array<{
      file: string
      line: number
      name: string
      kind: 'def' | 'ref'
      symbolKind: string | null
      context: string
    }>
  > {
    const { renderTreeContext } =
      (await import('repomap-mcp/dist/tree-context.js')) as typeof import('repomap-mcp/dist/tree-context.js')

    const matchingTags = codeGraphTagRepository.searchByName(workspaceId, query, {
      maxResults: options?.maxResults ?? 50,
      includeDefinitions: options?.includeDefinitions ?? true,
      includeReferences: options?.includeReferences ?? true,
      symbolKinds: options?.symbolKinds
    })

    const results: Array<{
      file: string
      line: number
      name: string
      kind: 'def' | 'ref'
      symbolKind: string | null
      context: string
    }> = []

    for (const tag of matchingTags) {
      const absPath = `${workspacePath}/${tag.relFname}`
      let context = ''
      try {
        const code = readFileSync(absPath, 'utf-8')
        context = renderTreeContext(code, [tag.line])
      } catch {
        // File may have been deleted — still return the match without context
      }

      results.push({
        file: tag.relFname,
        line: tag.line,
        name: tag.name,
        kind: tag.kind,
        symbolKind: tag.symbolKind ?? null,
        context
      })
    }

    return results
  }

  /**
   * Find potentially dead code — definitions with no cross-file references.
   * Wraps repository query with workspace validation and formatting.
   */
  async findDeadCode(
    workspaceId: string,
    workspacePath: string,
    options?: { path?: string; maxResults?: number; excludeSymbolKinds?: string[] }
  ): Promise<
    Array<{ file: string; line: number; name: string; symbolKind: string | null; context: string }>
  > {
    const { renderTreeContext } =
      (await import('repomap-mcp/dist/tree-context.js')) as typeof import('repomap-mcp/dist/tree-context.js')

    const deadDefs = codeGraphTagRepository.findDeadCode(workspaceId, options)

    const results: Array<{
      file: string
      line: number
      name: string
      symbolKind: string | null
      context: string
    }> = []

    for (const tag of deadDefs) {
      const absPath = `${workspacePath}/${tag.relFname}`
      let context = ''
      try {
        const code = readFileSync(absPath, 'utf-8')
        context = renderTreeContext(code, [tag.line])
      } catch {
        // File may have been deleted
      }

      results.push({
        file: tag.relFname,
        line: tag.line,
        name: tag.name,
        symbolKind: tag.symbolKind ?? null,
        context
      })
    }

    return results
  }

  /**
   * Get top-ranked files for decompose() — replaces prefetchRankedFiles().
   * Optionally boosts focus files by placing them first.
   */
  async getTopRankedFiles(
    workspaceId: string,
    focusFiles: string[],
    limit: number
  ): Promise<string[]> {
    const topFiles = codeGraphRankRepository.getTopRanked(workspaceId, limit + focusFiles.length)

    // Merge: focus files first, then top-ranked (deduplicated)
    const seen = new Set<string>()
    const result: string[] = []

    for (const file of focusFiles) {
      if (!seen.has(file)) {
        result.push(file)
        seen.add(file)
      }
    }

    for (const file of topFiles) {
      if (result.length >= limit) break
      if (!seen.has(file)) {
        result.push(file)
        seen.add(file)
      }
    }

    return result
  }

  /**
   * Check whether a persisted index exists for a workspace.
   */
  hasPersistedIndex(workspaceId: string): boolean {
    return codeGraphTagRepository.countByWorkspace(workspaceId) > 0
  }

  /**
   * Get current indexing state for a workspace.
   *
   * After an app restart the in-memory map is empty, but the DB may still
   * hold a fully-indexed graph from a previous session. When that's the case
   * we return a synthetic 'complete' state with real counts so the UI can
   * display stats immediately without requiring a re-index.
   */
  getIndexingState(workspaceId: string): CodeGraphIndexingState {
    const inMemory = this.indexingStates.get(workspaceId)
    if (inMemory) return inMemory

    // No in-memory state (e.g. after app restart) — check persisted DB
    const tagCount = codeGraphTagRepository.countByWorkspace(workspaceId)
    if (tagCount > 0) {
      const edgeCount = codeGraphEdgeRepository.countByWorkspace(workspaceId)
      // Use rank count for totalFiles — PageRank is computed over ALL discovered
      // source files (not just files with tags), so this matches what indexWorkspace
      // reports during indexing. fileMtimes.size would only count files with tags.
      const fileCount = codeGraphRankRepository.countByWorkspace(workspaceId)
      return {
        workspaceId,
        status: 'complete',
        totalFiles: fileCount,
        processedFiles: fileCount,
        totalTags: tagCount,
        totalEdges: edgeCount,
        currentFile: ''
      }
    }

    return {
      workspaceId,
      status: 'idle',
      totalFiles: 0,
      processedFiles: 0,
      totalTags: 0,
      totalEdges: 0,
      currentFile: ''
    }
  }

  /**
   * Detect circular file-level dependencies via DFS cycle detection.
   * Returns an array of cycles, each being an array of file paths forming the cycle.
   */
  findCircularDependencies(
    workspaceId: string,
    opts?: { path?: string; maxCycles?: number }
  ): string[][] {
    const edges = codeGraphEdgeRepository.findByWorkspace(workspaceId)
    const maxCycles = opts?.maxCycles ?? 20

    // Build adjacency list at file level
    const adj = new Map<string, Set<string>>()
    for (const edge of edges) {
      if (edge.sourceFile === edge.targetFile) continue
      if (opts?.path) {
        if (!edge.sourceFile.startsWith(opts.path) && !edge.targetFile.startsWith(opts.path))
          continue
      }
      const targets = adj.get(edge.sourceFile) ?? new Set()
      targets.add(edge.targetFile)
      adj.set(edge.sourceFile, targets)
    }

    // DFS-based cycle detection
    const visited = new Set<string>()
    const inStack = new Set<string>()
    const cycles: string[][] = []

    const dfs = (node: string, path: string[]): void => {
      if (cycles.length >= maxCycles) return
      visited.add(node)
      inStack.add(node)
      path.push(node)

      for (const neighbor of adj.get(node) ?? []) {
        if (cycles.length >= maxCycles) return
        if (inStack.has(neighbor)) {
          // Found a cycle — extract it from the path
          const cycleStart = path.indexOf(neighbor)
          if (cycleStart !== -1) {
            const cycle = path.slice(cycleStart)
            cycle.push(neighbor) // close the cycle
            // Normalize: start from lexicographically smallest path
            const minIdx = cycle
              .slice(0, -1)
              .reduce((mi, _v, i, arr) => (arr[i] < arr[mi] ? i : mi), 0)
            const normalized = [
              ...cycle.slice(minIdx, -1),
              ...cycle.slice(0, minIdx),
              cycle[minIdx]
            ]
            // Deduplicate by key
            const key = normalized.join(' → ')
            if (!cycles.some((c) => c.join(' → ') === key)) {
              cycles.push(normalized)
            }
          }
        } else if (!visited.has(neighbor)) {
          dfs(neighbor, path)
        }
      }

      path.pop()
      inStack.delete(node)
    }

    for (const node of adj.keys()) {
      if (!visited.has(node) && cycles.length < maxCycles) {
        dfs(node, [])
      }
    }

    return cycles
  }

  // ── Co-Change Mining ──────────────────────────────────────────────────────

  /**
   * Mine git history to find files that are frequently committed together.
   * Reveals logical coupling invisible to the import graph.
   */
  findCoChangePairs(
    workspacePath: string,
    options: {
      maxCommits?: number
      minCoChanges?: number
      path?: string
      filePath?: string
      maxResults?: number
    } = {}
  ): { fileA: string; fileB: string; coChangeCount: number; commitsAnalyzed: number }[] {
    const maxCommits = Math.min(options.maxCommits ?? 200, 500)
    const minCoChanges = options.minCoChanges ?? 3
    const maxResults = options.maxResults ?? 30

    let gitOutput: string
    try {
      gitOutput = execSync(`git log --name-only --format=%H -n ${maxCommits}`, {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: 15_000,
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true
      }).trim()
    } catch {
      return []
    }

    // Parse commits: split on blank lines, each block = hash + file list
    const commitBlocks = gitOutput.split(/\n\n+/)
    const pairCounts = new Map<string, number>()
    let commitCount = 0

    for (const block of commitBlocks) {
      const lines = block.split('\n').filter(Boolean)
      if (lines.length < 2) continue
      commitCount++

      let files = lines.slice(1)

      if (options.path) {
        files = files.filter((f) => f.startsWith(options.path!))
      }

      // Skip commits with too many files (merges) or too few
      if (files.length < 2 || files.length > 30) continue

      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
          const key = files[i] < files[j] ? `${files[i]}\0${files[j]}` : `${files[j]}\0${files[i]}`
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)
        }
      }
    }

    let pairs = Array.from(pairCounts.entries())
      .filter(([, count]) => count >= minCoChanges)
      .map(([key, count]) => {
        const [fileA, fileB] = key.split('\0')
        return { fileA, fileB, coChangeCount: count, commitsAnalyzed: commitCount }
      })

    if (options.filePath) {
      pairs = pairs.filter(
        (p) => p.fileA === options.filePath || p.fileB === options.filePath
      )
    }

    return pairs
      .sort((a, b) => b.coChangeCount - a.coChangeCount)
      .slice(0, maxResults)
  }

  // ── Hotspot Scoring ────────────────────────────────────────────────────────

  /**
   * Composite risk ranking: coupling (reference count) × git churn.
   * Surfaces the most dangerous files to touch during refactoring.
   */
  findHotspots(
    workspaceId: string,
    workspacePath: string,
    options: { maxResults?: number; path?: string } = {}
  ): {
    file: string
    referenceCount: number
    gitChurn: number
    hotspotScore: number
  }[] {
    const maxResults = options.maxResults ?? 20

    // 1. Get per-file reference counts from symbol hotspots
    const symbolHotspots = codeGraphTagRepository.findSymbolHotspots(workspaceId, {
      maxResults: 500,
      path: options.path
    })

    const fileRefCounts = new Map<string, number>()
    for (const h of symbolHotspots) {
      const file = (h as { file?: string }).file ?? ''
      if (!file) continue
      fileRefCounts.set(file, (fileRefCounts.get(file) ?? 0) + ((h as { refCount?: number }).refCount ?? 1))
    }

    // 2. Get git churn per file
    const churnMap = new Map<string, number>()
    try {
      const churnOutput = execSync(
        `git log --format= --name-only -n 500 | sort | uniq -c | sort -rn | head -200`,
        {
          cwd: workspacePath,
          encoding: 'utf-8',
          timeout: 15_000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true
        }
      ).trim()

      for (const line of churnOutput.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/)
        if (match) {
          churnMap.set(match[2], parseInt(match[1], 10))
        }
      }
    } catch {
      // Git not available — churn stays at 0
    }

    // 3. Compute hotspot score
    const allFiles = new Set([...fileRefCounts.keys(), ...churnMap.keys()])
    const hotspots: {
      file: string
      referenceCount: number
      gitChurn: number
      hotspotScore: number
    }[] = []

    for (const file of allFiles) {
      if (options.path && !file.startsWith(options.path)) continue
      const refCount = fileRefCounts.get(file) ?? 0
      const churn = churnMap.get(file) ?? 0
      const score = refCount * (1 + Math.log2(churn + 1))
      if (score > 0) {
        hotspots.push({
          file,
          referenceCount: refCount,
          gitChurn: churn,
          hotspotScore: Math.round(score * 100) / 100
        })
      }
    }

    return hotspots
      .sort((a, b) => b.hotspotScore - a.hotspotScore)
      .slice(0, maxResults)
  }

  // ── Code Clone Detection ──────────────────────────────────────────────────

  /**
   * Detect structurally duplicated code via normalized source hashing.
   * Uses the code_chunks table (requires semantic search indexing).
   * Normalizes identifiers, literals, and comments, then groups by SHA-256.
   */
  findCodeClones(
    workspaceId: string,
    _workspacePath: string,
    options: { minBodyLines?: number; path?: string; maxResults?: number } = {}
  ): { hash: string; clones: { file: string; symbol: string; line: number; lines: number }[] }[] {
    const minBodyLines = options.minBodyLines ?? 5
    const maxResults = options.maxResults ?? 20

    // Use code_chunks table which has body text + line ranges
    let chunks: { filePath: string; symbolName: string; startLine: number; endLine: number; body: string }[]
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { codeChunkRepository } = require('../db/repositories') as {
        codeChunkRepository: { db: () => import('better-sqlite3').Database }
      }
      const db = codeChunkRepository.db()
      const rows = db
        .prepare(
          `SELECT file_path, symbol_name, start_line, end_line, body
           FROM code_chunks
           WHERE workspace_id = ? AND (end_line - start_line) >= ?`
        )
        .all(workspaceId, minBodyLines) as {
          file_path: string; symbol_name: string; start_line: number; end_line: number; body: string
        }[]
      chunks = rows.map((r) => ({
        filePath: r.file_path,
        symbolName: r.symbol_name,
        startLine: r.start_line,
        endLine: r.end_line,
        body: r.body
      }))
    } catch {
      return [] // code_chunks table not available or empty
    }

    if (options.path) {
      chunks = chunks.filter((c) => c.filePath.startsWith(options.path!))
    }

    const hashGroups = new Map<string, { file: string; symbol: string; line: number; lines: number }[]>()

    for (const chunk of chunks) {
      const lineCount = chunk.endLine - chunk.startLine + 1
      if (lineCount < minBodyLines) continue

      const normalized = this.normalizeForCloneDetection(chunk.body)
      if (normalized.length < 20) continue

      const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 16)

      const entry = hashGroups.get(hash) ?? []
      entry.push({
        file: chunk.filePath,
        symbol: chunk.symbolName,
        line: chunk.startLine,
        lines: lineCount
      })
      hashGroups.set(hash, entry)
    }

    return Array.from(hashGroups.entries())
      .filter(([, group]) => group.length >= 2)
      .map(([hash, clones]) => ({ hash, clones }))
      .sort((a, b) => b.clones.length - a.clones.length)
      .slice(0, maxResults)
  }

  /**
   * Normalize source code for structural clone detection.
   * Strips comments, replaces literals and identifiers, collapses whitespace.
   */
  private normalizeForCloneDetection(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/`[^`]*`/g, 'STR')
      .replace(/"(?:[^"\\]|\\.)*"/g, 'STR')
      .replace(/'(?:[^'\\]|\\.)*'/g, 'STR')
      .replace(/\b0x[0-9a-fA-F]+\b/g, 'NUM')
      .replace(/\b\d+\.\d+\b/g, 'NUM')
      .replace(/\b\d+\b/g, 'NUM')
      .replace(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g, 'IDENT')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /**
   * Release memory after indexing. V8 on Windows doesn't aggressively GC
   * large allocations when system RAM is plentiful — we need to nudge it.
   */
  private postIndexCleanup(workspaceId: string): void {
    // 1. Clear the completed indexing state after a delay
    //    (keep it briefly so the UI can read the final status)
    setTimeout(() => {
      const state = this.indexingStates.get(workspaceId)
      if (state?.status === 'complete' || state?.status === 'error') {
        this.indexingStates.delete(workspaceId)
      }
    }, 30_000)

    // 2. Subsystem detection is derived from the edge table — a rebuild invalidates it
    this.subsystemCache.delete(workspaceId)

    // 3. Release the tree-sitter WASM parser — it allocated memory outside
    //    V8's heap that the GC cannot see. Will be re-initialized on next index.
    initParserPromise = null
    releaseTypedParser()

    // 4. Shrink SQLite page cache after the heavy write burst
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy to avoid a load-time circular import
      const { getDatabase } = require('../db')
      getDatabase().pragma('shrink_memory')
    } catch { /* best-effort */ }

    // 5. Nudge V8 GC (available when Electron runs with --expose-gc,
    //    already used by vector-search.service.ts)
    if (typeof global.gc === 'function') {
      global.gc()
    }

    memoryCheckpoint('POST_INDEX_CLEANUP')
  }

  private emitProgress(state: CodeGraphIndexingState): void {
    this.emit('progress', state)
  }
}

export const codeGraphService = new CodeGraphService()
