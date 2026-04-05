import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import log from 'electron-log'

const MAX_FILES_DISCUSSED = 15
const PREFETCH_TIMEOUT_MS = 5000
const DEFAULT_MAP_TOKENS = 2048

/** A ranked file source for enrichFilesDiscussed. Extensible for future sources (semantic, etc). */
export interface FileSource {
  source: string // 'generalist' | 'repomap' | 'semantic'
  files: string[] // ordered by relevance within source
  priority: number // lower = higher precedence (0=generalist, 1=repomap, 2=semantic)
}

/** Parse file paths from repomap text output. Format: `path/file.ts:\n(Rank value: N)` */
export function parseRepomapFiles(mapText: string): string[] {
  const fileLineRegex = /^(\S.*):$/gm
  const files: string[] = []
  let match: RegExpExecArray | null
  while ((match = fileLineRegex.exec(mapText)) !== null) {
    const filePath = match[1]
    if (filePath.includes('/') || filePath.includes('.')) {
      files.push(filePath)
    }
  }
  return files
}

/**
 * Merge multiple ranked file sources into filesDiscussed.
 * Priority-ordered, deduplicated, capped. Returns contributions for logging.
 */
export function enrichFilesDiscussed(
  sources: FileSource[],
  maxFiles = MAX_FILES_DISCUSSED
): { files: string[]; contributions: Record<string, number> } {
  const sorted = [...sources].sort((a, b) => a.priority - b.priority)
  const seen = new Set<string>()
  const merged: string[] = []
  const contributions: Record<string, number> = {}

  for (const source of sorted) {
    let count = 0
    for (const file of source.files) {
      if (merged.length >= maxFiles) break
      const key = file.toLowerCase()
      if (!seen.has(key)) {
        merged.push(file)
        seen.add(key)
        count++
      }
    }
    contributions[source.source] = count
  }
  return { files: merged, contributions }
}

/**
 * @deprecated Use codeGraphMcpService from './code-graph.tool' and
 * codeGraphService from './code-graph.service' instead.
 * Kept temporarily for backward compatibility — will be removed in a future release.
 */
class McpServerService {
  private serverInstance: McpServer | null = null
  private initFailed: boolean = false

  /** @deprecated Use codeGraphMcpService.getMcpServersConfig() instead */
  getOrCreateServer(): McpServer | null {
    if (this.initFailed) return null
    if (this.serverInstance) return this.serverInstance
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createServer } = require('repomap-mcp/dist/server.js') as {
        createServer: () => McpServer
      }
      this.serverInstance = createServer()
      log.info('[MCP] Created in-process repomap MCP server')
      return this.serverInstance
    } catch (error) {
      this.initFailed = true
      log.error('[MCP] Failed to initialize repomap — code graph disabled:', error)
      return null
    }
  }

  /** @deprecated Use codeGraphMcpService.getMcpServersConfig() instead */
  getMcpServersConfig(): Record<string, McpServerConfig> | undefined {
    const server = this.getOrCreateServer()
    if (!server) return undefined
    return {
      repomap: { type: 'sdk' as const, name: 'repomap', instance: server }
    }
  }

  /** @deprecated Use codeGraphService.getTopRankedFiles() instead */
  async prefetchRankedFiles(
    workspacePath: string,
    focusFiles?: string[],
    mapTokens = DEFAULT_MAP_TOKENS
  ): Promise<string[]> {
    try {
      const { RepoMap } = (await import('repomap-mcp/dist/repomap.js')) as {
        RepoMap: new (
          root: string,
          opts?: { verbose?: boolean }
        ) => {
          getRepoMap: (opts: {
            root: string
            focusFiles?: string[]
            mapTokens?: number
            excludeUnranked?: boolean
          }) => Promise<{ map: string }>
        }
      }
      const repoMap = new RepoMap(workspacePath, { verbose: false })
      const result = await Promise.race([
        repoMap.getRepoMap({
          root: workspacePath,
          focusFiles,
          mapTokens,
          excludeUnranked: true
        }),
        new Promise<null>((resolve) =>
          setTimeout(() => {
            log.warn('[MCP] repomap prefetch timed out')
            resolve(null)
          }, PREFETCH_TIMEOUT_MS)
        )
      ])
      if (!result) return []
      return parseRepomapFiles(result.map)
    } catch (error) {
      log.error('[MCP] Failed to pre-fetch repomap:', error)
      return []
    }
  }

  async dispose(): Promise<void> {
    if (this.serverInstance) {
      try {
        await this.serverInstance.close()
      } catch (e) {
        log.warn('[MCP] Error closing server:', e)
      }
      this.serverInstance = null
    }
    this.initFailed = false
    log.info('[MCP] Disposed repomap MCP server')
  }
}

export const mcpServerService = new McpServerService()
