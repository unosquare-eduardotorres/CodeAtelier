import { join } from 'node:path'
import log from 'electron-log/main'
import { fileWatcherService, type FilesChangedEvent } from './file-watcher.service'
import { codeGraphService } from './code-graph.service'
import { vectorSearchService } from './vector-search.service'
import { convertTagsToChunks } from './tag-to-chunk-adapter'
import { isExcludedPath, matchesSkipPattern } from './code-graph-exclusions'
import { loadAllIgnorePatterns } from './workspace-ignore'
import { workspaceRepository } from '../db/repositories'

/**
 * Initialize the file watcher handler — connects watcher events
 * to Code Graph and Semantic Search re-indexing.
 */
export function initFileWatcherHandler(): void {
  fileWatcherService.on('files-changed', async (event: FilesChangedEvent) => {
    const { workspaceId, workspacePath, changedFiles } = event

    log.info(`[FileWatcher] ${changedFiles.length} file(s) changed in workspace ${workspaceId}`)

    // Code Graph: bootstrap full index if none exists, then incremental re-index
    if (event.codeGraphEnabled) {
      if (!codeGraphService.hasPersistedIndex(workspaceId)) {
        // Bootstrap: no persisted index yet — run a full tree-sitter parse.
        // Cheap for small/medium repos; subsequent changes take the incremental path.
        try {
          log.info(
            `[FileWatcher] Code graph bootstrap: running full indexWorkspace for ${workspaceId}`
          )
          await codeGraphService.indexWorkspace(workspaceId, workspacePath)
        } catch (err) {
          log.error('[FileWatcher] Code graph bootstrap failed:', err)
        }
      } else {
        // Incremental re-index (fast, ~100ms)
        try {
          await codeGraphService.reindexFiles(workspaceId, workspacePath, changedFiles)
        } catch (err) {
          log.error('[FileWatcher] Code graph incremental re-index failed:', err)
        }
      }
    }

    // Semantic Search: re-index changed files only
    if (event.semanticSearchEnabled && vectorSearchService.hasIndex(workspaceId)) {
      try {
        await reindexSemanticSearch(workspaceId, workspacePath, changedFiles)
      } catch (err) {
        log.error('[FileWatcher] Semantic search incremental re-index failed:', err)
      }
    }
  })
}

async function reindexSemanticSearch(
  workspaceId: string,
  workspacePath: string,
  changedFiles: string[]
): Promise<void> {
  // Apply the same exclusions as full indexing. Without this, a `pod install`
  // or `npm install` re-introduces every vendored file the pruning walker
  // deliberately skipped.
  const ignorePatterns = loadAllIgnorePatterns(workspacePath)
  const indexable = changedFiles.filter(
    (rel) => !isExcludedPath(rel) && !matchesSkipPattern(rel, ignorePatterns)
  )
  if (indexable.length === 0) return

  const { getTags, initParser } =
    (await import('repomap-mcp/dist/tags.js')) as typeof import('repomap-mcp/dist/tags.js')
  await initParser()

  // Parse tags for changed files only
  const allTags: Array<{
    relFname: string
    fname: string
    line: number
    name: string
    kind: 'def' | 'ref'
  }> = []

  for (const relPath of indexable) {
    const absPath = join(workspacePath, relPath)
    try {
      const tags = await getTags(absPath, relPath, null, false)
      allTags.push(...tags)
    } catch (error) {
      const msg = (error as Error).message
      if (!msg.includes('ENOENT') && !msg.includes('no such file')) {
        log.warn(`[FileWatcher] getTags failed for ${relPath}: ${msg}`)
      }
    }
  }

  if (allTags.length === 0) return

  const { chunks, fileContents } = convertTagsToChunks(allTags, workspacePath)
  if (chunks.length === 0) return

  // Read workspace settings for description model
  const settings = workspaceRepository.getSettings(workspaceId)

  // Re-index only the changed chunks (upsert semantics)
  await vectorSearchService.reindexFiles(workspaceId, workspacePath, chunks, fileContents, {
    generateDescriptions: !!settings.semanticSearchDescriptions,
    descriptionModel: settings.descriptionModel || 'claude-haiku-4-5-20251001',
    skipPatterns: ignorePatterns
  })

  log.info(
    `[FileWatcher] Semantic search updated: ${chunks.length} chunks from ${indexable.length} files`
  )
}
