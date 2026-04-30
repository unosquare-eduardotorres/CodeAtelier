import { EventEmitter } from 'node:events'
import { statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import { codeGraphTagRepository } from '../db/repositories'
import { codeGraphEdgeRepository } from '../db/repositories'
import { codeGraphRankRepository } from '../db/repositories'
import type { RepomapTag } from '../db/repositories/code-graph-tag.repository'
import type { CodeGraphIndexingState } from '../../shared/types'

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
}

/**
 * Build edge list from defines/references tag maps.
 * Pure function: takes tags, returns edge list.
 * An edge is created from each reference file to each definition file for the same symbol,
 * excluding self-references (ref and def in same file).
 */
export function buildEdgesFromTags(tags: RepomapTag[]): GraphEdge[] {
  const defines = new Map<string, Set<string>>()
  const references = new Map<string, Set<string>>()
  for (const tag of tags) {
    const map = tag.kind === 'def' ? defines : references
    let set = map.get(tag.name)
    if (!set) {
      set = new Set()
      map.set(tag.name, set)
    }
    set.add(tag.relFname)
  }

  const edges: GraphEdge[] = []
  for (const [name, refFiles] of references) {
    const defFiles = defines.get(name)
    if (!defFiles) continue
    for (const refFile of refFiles) {
      for (const defFile of defFiles) {
        if (refFile !== defFile) edges.push({ from: refFile, to: defFile, name })
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

class CodeGraphService extends EventEmitter {
  private indexingStates = new Map<string, CodeGraphIndexingState>()

  /**
   * Full workspace indexing — called when toggle is enabled or "Re-index" clicked.
   * Phases: discover files → parse tags → build edges → PageRank → persist
   */
  async indexWorkspace(workspaceId: string, workspacePath: string): Promise<void> {
    const { getTags, initParser } =
      (await import('repomap-mcp/dist/tags.js')) as typeof import('repomap-mcp/dist/tags.js')
    const { findSrcFiles } =
      (await import('repomap-mcp/dist/file-discovery.js')) as typeof import('repomap-mcp/dist/file-discovery.js')
    const { isSupportedFile } =
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
      await initParser()

      // Phase 1: Discover files
      const allFiles = findSrcFiles(workspacePath).filter(isSupportedFile)
      state.totalFiles = allFiles.length
      state.status = 'parsing'
      this.emitProgress(state)

      // Phase 2: Parse tags (with incremental support via mtime comparison)
      const existingMtimes = codeGraphTagRepository.getFileMtimes(workspaceId)
      const allTags: RepomapTag[] = []
      const fileMtimes = new Map<string, number>()

      for (const fname of allFiles) {
        const relFname = fname.replace(workspacePath + '/', '')
        state.currentFile = relFname

        try {
          const stat = statSync(fname)
          const existingMtime = existingMtimes.get(relFname)
          fileMtimes.set(relFname, stat.mtimeMs)

          if (existingMtime && stat.mtimeMs === existingMtime) {
            // File unchanged — load cached tags from DB
            const cachedTags = codeGraphTagRepository.findByFile(workspaceId, relFname)
            allTags.push(...cachedTags)
          } else {
            // File changed or new — parse with Tree-sitter
            const tags = await getTags(fname, relFname, null, false)
            allTags.push(...tags)
          }
        } catch {
          // Skip unreadable files
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

      const allNodes = new Set(allFiles.map((f) => f.replace(workspacePath + '/', '')))
      const { totalEdges } = await this.buildAndPersistGraph(workspaceId, allTags, allNodes)
      state.totalEdges = totalEdges

      state.status = 'complete'
      log.info(
        `[CodeGraph] Indexing complete: ${allFiles.length} files, ${allTags.length} tags, ${totalEdges} edges`
      )
      this.emitProgress(state)
    } catch (error) {
      state.status = 'error'
      state.error = (error as Error).message
      log.error('[CodeGraph] Indexing failed:', error)
      this.emitProgress(state)
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

    // Persist edges and ranks
    codeGraphEdgeRepository.upsertEdges(
      workspaceId,
      edges.map((e) => ({
        workspaceId,
        sourceFile: e.from,
        sourceSymbol: e.name,
        targetFile: e.to,
        targetSymbol: e.name,
        edgeType: 'references' as const,
        pageRank: ranks.get(e.to) ?? 0
      }))
    )
    codeGraphRankRepository.upsertRanks(workspaceId, ranks)

    return { totalEdges: edges.length }
  }

  /**
   * Incremental re-index: re-parse only specified files, then rebuild
   * the full edge graph + PageRank from ALL persisted tags.
   * ~100ms for a few files vs ~3-8s for full workspace.
   */
  async reindexFiles(
    workspaceId: string,
    workspacePath: string,
    changedRelPaths: string[]
  ): Promise<void> {
    const { getTags, initParser } =
      (await import('repomap-mcp/dist/tags.js')) as typeof import('repomap-mcp/dist/tags.js')
    const { isSupportedFile } =
      (await import('repomap-mcp/dist/languages.js')) as typeof import('repomap-mcp/dist/languages.js')
    await initParser()

    // 1. Re-parse only changed files
    const newTags: RepomapTag[] = []
    const fileMtimes = new Map<string, number>()

    for (const relPath of changedRelPaths) {
      const absPath = join(workspacePath, relPath)
      if (!isSupportedFile(absPath)) continue
      try {
        const stat = statSync(absPath)
        fileMtimes.set(relPath, stat.mtimeMs)
        const tags = await getTags(absPath, relPath, null, false)
        newTags.push(...tags)
      } catch {
        // File deleted — remove its tags
        codeGraphTagRepository.deleteByFile(workspaceId, relPath)
      }
    }

    // 2. Upsert changed file tags
    if (newTags.length > 0) {
      codeGraphTagRepository.upsertTags(workspaceId, newTags, fileMtimes)
    }

    // 3. Rebuild full graph from ALL persisted tags
    const allTags = codeGraphTagRepository.findAllByWorkspace(workspaceId)
    await this.buildAndPersistGraph(workspaceId, allTags)

    log.info(`[CodeGraph] Incremental: ${changedRelPaths.length} files, ${newTags.length} new tags`)
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

      const linesOfInterest = fileTags.map((t) => t.line)
      const rendered = renderTreeContext(code, linesOfInterest)
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
    }
  ): Promise<
    Array<{
      file: string
      line: number
      name: string
      kind: 'def' | 'ref'
      context: string
    }>
  > {
    const { renderTreeContext } =
      (await import('repomap-mcp/dist/tree-context.js')) as typeof import('repomap-mcp/dist/tree-context.js')

    const matchingTags = codeGraphTagRepository.searchByName(workspaceId, query, {
      maxResults: options?.maxResults ?? 50,
      includeDefinitions: options?.includeDefinitions ?? true,
      includeReferences: options?.includeReferences ?? true
    })

    const results: Array<{
      file: string
      line: number
      name: string
      kind: 'def' | 'ref'
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
    options?: { pathPrefix?: string; maxResults?: number }
  ): Promise<Array<{ file: string; line: number; name: string; context: string }>> {
    const { renderTreeContext } =
      (await import('repomap-mcp/dist/tree-context.js')) as typeof import('repomap-mcp/dist/tree-context.js')

    const deadDefs = codeGraphTagRepository.findDeadCode(workspaceId, options)

    const results: Array<{ file: string; line: number; name: string; context: string }> = []

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
   */
  getIndexingState(workspaceId: string): CodeGraphIndexingState {
    return (
      this.indexingStates.get(workspaceId) ?? {
        workspaceId,
        status: 'idle',
        totalFiles: 0,
        processedFiles: 0,
        totalTags: 0,
        totalEdges: 0,
        currentFile: ''
      }
    )
  }

  /**
   * Detect circular file-level dependencies via DFS cycle detection.
   * Returns an array of cycles, each being an array of file paths forming the cycle.
   */
  findCircularDependencies(
    workspaceId: string,
    opts?: { pathPrefix?: string; maxCycles?: number }
  ): string[][] {
    const edges = codeGraphEdgeRepository.findByWorkspace(workspaceId)
    const maxCycles = opts?.maxCycles ?? 20

    // Build adjacency list at file level
    const adj = new Map<string, Set<string>>()
    for (const edge of edges) {
      if (edge.sourceFile === edge.targetFile) continue
      if (opts?.pathPrefix) {
        if (
          !edge.sourceFile.startsWith(opts.pathPrefix) &&
          !edge.targetFile.startsWith(opts.pathPrefix)
        )
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

  private emitProgress(state: CodeGraphIndexingState): void {
    this.emit('progress', state)
  }
}

export const codeGraphService = new CodeGraphService()
