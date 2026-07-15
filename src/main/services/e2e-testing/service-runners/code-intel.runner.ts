/**
 * Code Intelligence Service Runners — indexing, embeddings, semantic search.
 */

import type { E2EServiceContext } from './index'
import type { E2ETranscriptEntry } from '../../../../shared/types'
import { OMLX_DEFAULT_PORT } from '../../../../shared/constants'
import electronLog from 'electron-log/main'

const log = electronLog.scope('E2ECodeIntelRunner')

function statusEntry(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'status', content, timestamp: Date.now() }
}

// ── Code Graph Indexing ──

export async function runCodeGraphIndex(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { codeGraphService } = await import('../../code-graph.service')

    transcript.push(statusEntry('indexing_started'))
    log.info(`[code-graph-index] Starting indexing for workspace: ${ctx.workspaceId}`)

    await codeGraphService.indexWorkspace(ctx.workspaceId, ctx.workspacePath)

    // Poll for completion (indexing is async)
    let attempts = 0
    const maxAttempts = 60
    while (attempts < maxAttempts) {
      const state = codeGraphService.getIndexingState(ctx.workspaceId)
      if (state && (state as { status?: string }).status === 'complete') {
        const totalFiles = (state as { totalFiles?: number }).totalFiles ?? 0
        transcript.push(statusEntry(`indexing_complete: totalFiles=${totalFiles}`))
        log.info(`[code-graph-index] Indexing complete: ${totalFiles} files`)
        break
      }
      await new Promise((r) => setTimeout(r, 1000))
      attempts++
      if (ctx.signal.aborted) break
    }

    if (attempts >= maxAttempts) {
      transcript.push(statusEntry('indexing_timeout'))
    }
  } catch (err) {
    transcript.push({ role: 'system', type: 'error', content: (err as Error).message, timestamp: Date.now() })
  }

  return transcript
}

// ── Embedding Generation ──

export async function runEmbeddingGeneration(_ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { omlxEmbeddingProvider } = await import('../../omlx-embedding.service')

    transcript.push(statusEntry('embedding_initializing'))
    const baseUrl = `http://127.0.0.1:${OMLX_DEFAULT_PORT}`

    await omlxEmbeddingProvider.initialize(baseUrl)

    if (!omlxEmbeddingProvider.isReady) {
      transcript.push(statusEntry('embedding_not_ready'))
      return transcript
    }

    const vectors = await omlxEmbeddingProvider.embed(['hello world', 'test embedding'])
    const dim = vectors.length > 0 ? vectors[0].length : 0

    log.info(`[embedding-gen] Generated ${vectors.length} vectors, dim=${dim}`)
    transcript.push(statusEntry(`embedding_ok: vectors=${vectors.length}, dim=${dim}`))
  } catch (err) {
    transcript.push({ role: 'system', type: 'error', content: (err as Error).message, timestamp: Date.now() })
  }

  return transcript
}

// ── Semantic Search ──

export async function runSemanticSearch(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { codeGraphService } = await import('../../code-graph.service')

    // Ensure index exists
    const state = codeGraphService.getIndexingState(ctx.workspaceId)
    if (!state || (state as { status?: string }).status !== 'complete') {
      transcript.push(statusEntry('indexing_required'))
      await codeGraphService.indexWorkspace(ctx.workspaceId, ctx.workspacePath)

      // Wait for completion
      let attempts = 0
      while (attempts < 60) {
        const s = codeGraphService.getIndexingState(ctx.workspaceId)
        if (s && (s as { status?: string }).status === 'complete') break
        await new Promise((r) => setTimeout(r, 1000))
        attempts++
        if (ctx.signal.aborted) break
      }
    }

    // Try semantic search via the identifiers search
    const results = await codeGraphService.searchIdentifiers(ctx.workspaceId, ctx.workspacePath, 'hello', { maxResults: 10 })

    if (results && results.length > 0) {
      const hasHello = results.some((r) => r.name.toLowerCase().includes('hello'))
      transcript.push(statusEntry(`search_results_found: count=${results.length}, hasHello=${hasHello}`))
      log.info(`[semantic-search] Found ${results.length} results, hasHello=${hasHello}`)
    } else {
      transcript.push(statusEntry('search_results_found: count=0'))
    }
  } catch (err) {
    transcript.push({ role: 'system', type: 'error', content: (err as Error).message, timestamp: Date.now() })
  }

  return transcript
}
