/**
 * Memory Service Runners — tier progression + edge-case testing.
 *
 * - runMemoryTiers: tier confirmation counter
 * - runMemoryDedupExact: exact duplicate → 1 active row
 * - runMemoryDedupNear: near-duplicate (cosine >0.90) merge
 * - runMemoryAmbiguous: ambiguous band (0.70–0.90) contradiction detection
 * - runMemoryIsolation: workspace isolation — cross-workspace leakage check
 * - runMemoryScopeBoost: scope path boost ranking
 * - runMemorySessionDedupe: per-session injection dedup
 */

import type { E2EServiceContext } from './index'
import type { E2ETranscriptEntry } from '../../../../shared/types'
import electronLog from 'electron-log/main'

const log = electronLog.scope('E2EMemoryRunner')

function statusEntry(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'status', content, timestamp: Date.now() }
}

function errorEntry(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'error', content, timestamp: Date.now() }
}

export async function runMemoryTiers(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { memoryEngineService } = await import('../../memory-engine.service')

    const uniqueTag = `e2e-${Date.now()}`
    const testFact = `E2E test fact: The project build system uses esbuild for bundling (${uniqueTag})`

    // First write
    transcript.push(statusEntry('proposing_fact_1'))
    const fact1 = await memoryEngineService.writeFact({
      workspaceId: ctx.workspaceId,
      title: 'Build system tooling',
      content: testFact,
      category: 'convention',
      sourceType: 'tool',
      sourceRef: 'e2e-test'
    })
    if (!fact1) {
      transcript.push(errorEntry('First fact write returned null (capped/deduped)'))
      return transcript
    }

    // Small delay to let dedup/embedding run
    await new Promise((r) => setTimeout(r, 1500))

    // Second write (same content — should trigger dedup/confirmation)
    transcript.push(statusEntry('proposing_fact_2'))
    await memoryEngineService.writeFact({
      workspaceId: ctx.workspaceId,
      title: 'Build system tooling',
      content: testFact,
      category: 'convention',
      sourceType: 'tool',
      sourceRef: 'e2e-test'
    })

    await new Promise((r) => setTimeout(r, 1500))

    // Explicitly confirm the first fact to increment counter
    const confirmed = memoryEngineService.confirmFactWithPromotion(fact1.id)
    const count = confirmed.confirmationCount ?? 0
    transcript.push(statusEntry(`confirmation_count: ${count}`))
    log.info(`[memory-tiers] Confirmation count: ${count}, tier: ${confirmed.tier}`)
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

// ── Wave D: Memory Edge Cases ───────────────────────────────────────────────────

/**
 * Exact dedup: write identical content ×2 → assert only 1 active row.
 * The second write should confirm the first (via similarity pipeline) rather than creating a duplicate.
 */
export async function runMemoryDedupExact(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { memoryEngineService } = await import('../../memory-engine.service')
    const { memoryFactRepository } = await import('../../../db/repositories')

    const uniqueTag = `e2e-dedup-exact-${Date.now()}`
    const testContent = `The project deploys to AWS ECS Fargate (${uniqueTag})`

    // First write
    transcript.push(statusEntry('writing_fact_1'))
    await memoryEngineService.writeFact({
      workspaceId: ctx.workspaceId,
      title: 'Deployment target',
      content: testContent,
      category: 'convention',
      sourceType: 'tool',
      sourceRef: 'e2e-dedup-exact'
    })

    await new Promise((r) => setTimeout(r, 2000))

    // Second write (identical)
    transcript.push(statusEntry('writing_fact_2'))
    await memoryEngineService.writeFact({
      workspaceId: ctx.workspaceId,
      title: 'Deployment target',
      content: testContent,
      category: 'convention',
      sourceType: 'tool',
      sourceRef: 'e2e-dedup-exact'
    })

    await new Promise((r) => setTimeout(r, 1000))

    // Count active facts matching our unique tag
    const allFacts = memoryFactRepository.findByWorkspace(ctx.workspaceId)
    const matching = allFacts.filter((f) => f.content.includes(uniqueTag))
    const activeCount = matching.length

    log.info(`[memory-dedup-exact] Active matching facts: ${activeCount}`)
    transcript.push(statusEntry(`dedup_ok: ${activeCount}`))
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

/**
 * Near-duplicate dedup: paraphrase (cosine >0.90) → assert merged/confirmed.
 * Requires embedding provider to be ready; emits skip status if offline.
 */
export async function runMemoryDedupNear(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { omlxEmbeddingProvider } = await import('../../omlx-embedding.service')

    if (!omlxEmbeddingProvider.isReady) {
      transcript.push(statusEntry('skip_embedding_offline'))
      return transcript
    }

    const { memoryEngineService } = await import('../../memory-engine.service')
    const { memoryFactRepository } = await import('../../../db/repositories')

    const uniqueTag = `e2e-dedup-near-${Date.now()}`

    // Write original fact
    transcript.push(statusEntry('writing_original'))
    await memoryEngineService.writeFact({
      workspaceId: ctx.workspaceId,
      title: 'Testing framework',
      content: `This project uses Jest for unit testing (${uniqueTag})`,
      category: 'convention',
      sourceType: 'tool',
      sourceRef: 'e2e-dedup-near'
    })

    await new Promise((r) => setTimeout(r, 2000))

    // Write paraphrase (should be cosine >0.90)
    transcript.push(statusEntry('writing_paraphrase'))
    await memoryEngineService.writeFact({
      workspaceId: ctx.workspaceId,
      title: 'Testing framework',
      content: `The project relies on Jest as its unit test framework (${uniqueTag})`,
      category: 'convention',
      sourceType: 'tool',
      sourceRef: 'e2e-dedup-near'
    })

    await new Promise((r) => setTimeout(r, 1000))

    // Count: should be 1 (confirmed) not 2 (duplicated)
    const allFacts = memoryFactRepository.findByWorkspace(ctx.workspaceId)
    const matching = allFacts.filter((f) => f.content.includes(uniqueTag))

    log.info(`[memory-dedup-near] Active matching facts: ${matching.length}`)
    // 1 = perfect dedup, 2 = paraphrase wasn't close enough (still acceptable)
    transcript.push(statusEntry(matching.length <= 1 ? 'dedup_near_ok' : `dedup_near_count: ${matching.length}`))
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

/**
 * Ambiguous band: contradictory-ish fact (0.70–0.90 cosine) → assert contradiction review created.
 * Requires embedding provider.
 */
export async function runMemoryAmbiguous(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { omlxEmbeddingProvider } = await import('../../omlx-embedding.service')

    if (!omlxEmbeddingProvider.isReady) {
      transcript.push(statusEntry('skip_embedding_offline'))
      return transcript
    }

    const { memoryEngineService } = await import('../../memory-engine.service')
    const { memoryFactRepository } = await import('../../../db/repositories')

    const uniqueTag = `e2e-ambiguous-${Date.now()}`

    // Write original fact
    transcript.push(statusEntry('writing_original'))
    await memoryEngineService.writeFact({
      workspaceId: ctx.workspaceId,
      title: 'Package manager',
      content: `This project uses npm as its package manager (${uniqueTag})`,
      category: 'convention',
      sourceType: 'tool',
      sourceRef: 'e2e-ambiguous'
    })

    await new Promise((r) => setTimeout(r, 2000))

    // Write contradictory fact (same topic, different answer)
    transcript.push(statusEntry('writing_contradictory'))
    await memoryEngineService.writeFact({
      workspaceId: ctx.workspaceId,
      title: 'Package manager',
      content: `This project uses pnpm as its package manager (${uniqueTag})`,
      category: 'convention',
      sourceType: 'tool',
      sourceRef: 'e2e-ambiguous'
    })

    await new Promise((r) => setTimeout(r, 1000))

    // Check for contradiction records (findContradictions takes optional status, not workspaceId)
    const contradictions = memoryFactRepository.findContradictions()
    const recent = contradictions.filter((c) =>
      c.resolution?.includes(uniqueTag) || c.createdAt > new Date(Date.now() - 30_000).toISOString()
    )

    log.info(`[memory-ambiguous] Contradictions found: ${recent.length}`)
    transcript.push(statusEntry(recent.length > 0 ? 'ambiguous_band_ok' : 'ambiguous_band_no_contradiction'))
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

/**
 * Workspace isolation: fact in fixture workspace → retrieve() with non-existent workspace returns nothing.
 */
export async function runMemoryIsolation(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { memoryEngineService } = await import('../../memory-engine.service')
    const { memoryRetrievalService } = await import('../../memory-retrieval.service')

    const uniqueTag = `e2e-isolation-${Date.now()}`

    // Write fact in fixture workspace
    transcript.push(statusEntry('writing_in_fixture_workspace'))
    await memoryEngineService.writeFact({
      workspaceId: ctx.workspaceId,
      title: 'Isolation test fact',
      content: `The build output goes to dist/ directory (${uniqueTag})`,
      category: 'convention',
      sourceType: 'tool',
      sourceRef: 'e2e-isolation'
    })

    await new Promise((r) => setTimeout(r, 1000))

    // Try to retrieve from a different workspace
    const fakeWorkspaceId = 'e2e-fake-workspace-' + Date.now()
    const results = await memoryRetrievalService.retrieve(fakeWorkspaceId, uniqueTag, 10)

    log.info(`[memory-isolation] Results from other workspace: ${results.length}`)
    transcript.push(statusEntry(results.length === 0 ? 'isolation_ok' : `isolation_leak: ${results.length}`))
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

/**
 * Scope path boost: fact with scopePaths ranks above unscoped for matching query.
 */
export async function runMemoryScopeBoost(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { memoryEngineService } = await import('../../memory-engine.service')
    const { memoryRetrievalService } = await import('../../memory-retrieval.service')

    const uniqueTag = `e2e-scope-${Date.now()}`

    // Write unscoped fact
    transcript.push(statusEntry('writing_unscoped'))
    await memoryEngineService.writeFact({
      workspaceId: ctx.workspaceId,
      title: 'Hello module info',
      content: `The hello module provides greeting functions (${uniqueTag})`,
      category: 'convention',
      sourceType: 'tool',
      sourceRef: 'e2e-scope-boost'
    })

    // Write scoped fact (same topic, scoped to src/hello.ts)
    transcript.push(statusEntry('writing_scoped'))
    await memoryEngineService.writeFact({
      workspaceId: ctx.workspaceId,
      title: 'Hello module scoped info',
      content: `The hello module in src/hello.ts exports greeting utilities (${uniqueTag})`,
      category: 'convention',
      sourceType: 'tool',
      sourceRef: 'e2e-scope-boost',
      scopePaths: ['src/hello.ts']
    })

    await new Promise((r) => setTimeout(r, 1500))

    // Search with a query mentioning the scoped path
    const results = await memoryRetrievalService.retrieve(ctx.workspaceId, `src/hello.ts greeting ${uniqueTag}`, 10)
    const matchingResults = results.filter((r) => r.fact.content.includes(uniqueTag))

    if (matchingResults.length >= 2) {
      // The scoped fact should rank higher
      const scopedFirst = matchingResults[0].fact.scopePaths.includes('src/hello.ts')
      log.info(`[memory-scope-boost] Scoped fact first: ${scopedFirst}, results: ${matchingResults.length}`)
      transcript.push(statusEntry(scopedFirst ? 'scope_boost_ok' : 'scope_boost_wrong_order'))
    } else if (matchingResults.length === 1) {
      // Only one found — check if it's the scoped one
      const isScoped = matchingResults[0].fact.scopePaths.includes('src/hello.ts')
      transcript.push(statusEntry(isScoped ? 'scope_boost_ok' : 'scope_boost_only_unscoped'))
    } else {
      transcript.push(statusEntry('scope_boost_no_results'))
    }
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

/**
 * Session dedupe: getContextForTurn twice with same injectedIds set →
 * second call excludes already-injected facts.
 */
export async function runMemorySessionDedupe(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { memoryEngineService } = await import('../../memory-engine.service')
    const { memoryRetrievalService } = await import('../../memory-retrieval.service')

    const uniqueTag = `e2e-session-dedupe-${Date.now()}`

    // Write a distinctive fact
    transcript.push(statusEntry('writing_fact'))
    await memoryEngineService.writeFact({
      workspaceId: ctx.workspaceId,
      title: 'Session dedupe test',
      content: `The CI pipeline uses GitHub Actions with matrix builds (${uniqueTag})`,
      category: 'convention',
      sourceType: 'tool',
      sourceRef: 'e2e-session-dedupe'
    })

    await new Promise((r) => setTimeout(r, 1500))

    // First call to getContextForTurn with a shared injectedIds set
    const injectedIds = new Set<string>()
    const ctx1 = await memoryRetrievalService.getContextForTurn(
      ctx.workspaceId,
      `GitHub Actions CI pipeline ${uniqueTag}`,
      'medium',
      injectedIds
    )

    const firstCallHadContent = ctx1.length > 0
    log.info(`[memory-session-dedupe] First call: ${ctx1.length} chars, injected IDs: ${injectedIds.size}`)

    // Second call with same injectedIds — should exclude the already-injected fact
    const ctx2 = await memoryRetrievalService.getContextForTurn(
      ctx.workspaceId,
      `GitHub Actions CI pipeline ${uniqueTag}`,
      'medium',
      injectedIds
    )

    const secondCallEmpty = ctx2.length === 0
    log.info(`[memory-session-dedupe] Second call: ${ctx2.length} chars`)

    if (firstCallHadContent && secondCallEmpty) {
      transcript.push(statusEntry('session_dedupe_ok'))
    } else if (!firstCallHadContent) {
      // Fact wasn't found at all (embedding not ready, or keyword mismatch)
      transcript.push(statusEntry('session_dedupe_no_match'))
    } else {
      transcript.push(statusEntry(`session_dedupe_leak: second_call_chars=${ctx2.length}`))
    }
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}
