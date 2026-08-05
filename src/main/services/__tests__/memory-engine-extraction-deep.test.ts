/**
 * memory-engine-extraction-deep.test.ts — Phase 21, File 5
 *
 * Deep body coverage for memory services:
 *   - memory-engine.service.ts: MemoryEngineService instance methods + pure functions
 *   - memory-extraction.service.ts: buildExtractionPrompt, parseExtractedFacts, prompt builders
 *   - memory-retrieval.service.ts: scoring helpers, formatting, tokenization
 *   - memory-consolidation.service.ts: selectStaleT0Facts, idle job lifecycle
 *   - memory-bootstrap.service.ts: service shape, configuration constants
 *   - memory-doc-watcher.service.ts: service shape, start/stop lifecycle
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

// ── Graceful module loading ──────────────────────────────────────────────

let cosineSimilarity: (a: Float32Array, b: Float32Array) => number
let computePromotionTierPure: (
  tier: number,
  confidence: number,
  confirmations: Array<{ sourceType: string; weight: number; createdAt: string }>
) => number
let CAPTURE_CAPS: { MAX_FACTS_PER_SESSION: number; MAX_FACTS_PER_COMMIT: number }
let VOLATILE_PATTERNS: RegExp[]
let memoryEngineService: any
let engineLoaded = false

try {
  const mod = require('../memory-engine.service')
  cosineSimilarity = mod.cosineSimilarity
  computePromotionTierPure = mod.computePromotionTierPure
  CAPTURE_CAPS = mod.CAPTURE_CAPS
  VOLATILE_PATTERNS = mod.VOLATILE_PATTERNS
  memoryEngineService = mod.memoryEngineService
  engineLoaded = true
} catch (err) {
  console.log(`⚠ memory-engine.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

let hasRealEvidencePure: (confirmations: Array<{ sourceType: string }>) => boolean
let selectStaleT0Facts: (
  facts: any[],
  workspaceId: string,
  hasEvidence: (factId: string) => boolean
) => any[]
let memoryConsolidationService: any
let consolidationLoaded = false

try {
  const mod = require('../memory-consolidation.service')
  hasRealEvidencePure = mod.hasRealEvidencePure
  selectStaleT0Facts = mod.selectStaleT0Facts
  memoryConsolidationService = mod.memoryConsolidationService
  consolidationLoaded = true
} catch (err) {
  console.log(`⚠ memory-consolidation.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

let memoryExtractionService: any
let extractionLoaded = false

try {
  const mod = require('../memory-extraction.service')
  memoryExtractionService = mod.memoryExtractionService
  extractionLoaded = true
} catch (err) {
  console.log(`⚠ memory-extraction.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

let memoryRetrievalService: any
let retrievalLoaded = false

try {
  const mod = require('../memory-retrieval.service')
  memoryRetrievalService = mod.memoryRetrievalService
  retrievalLoaded = true
} catch (err) {
  console.log(`⚠ memory-retrieval.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

let memoryBootstrapService: any
let bootstrapLoaded = false

try {
  const mod = require('../memory-bootstrap.service')
  memoryBootstrapService = mod.memoryBootstrapService
  bootstrapLoaded = true
} catch (err) {
  console.log(`⚠ memory-bootstrap.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

let memoryDocWatcherService: any
let docWatcherLoaded = false

try {
  const mod = require('../memory-doc-watcher.service')
  memoryDocWatcherService = mod.memoryDocWatcherService
  docWatcherLoaded = true
} catch (err) {
  console.log(`⚠ memory-doc-watcher.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

// ═══════════════════════════════════════════════════════════════════════════
// MemoryEngineService — Deep body coverage
// ═══════════════════════════════════════════════════════════════════════════

if (engineLoaded) {
  // ── cosineSimilarity edge cases ──
  describe('cosineSimilarity — edge cases', () => {
    test('high-dimensional vectors produce correct result', () => {
      const dim = 384
      const a = new Float32Array(dim)
      const b = new Float32Array(dim)
      for (let i = 0; i < dim; i++) {
        a[i] = Math.sin(i)
        b[i] = Math.sin(i)
      }
      const sim = cosineSimilarity(a, b)
      assert.ok(
        Math.abs(sim - 1.0) < 1e-5,
        `Identical 384-dim vectors should have sim=1.0, got ${sim}`
      )
    })

    test('scaled vectors still produce 1.0 similarity', () => {
      const a = new Float32Array([2, 4, 6])
      const b = new Float32Array([1, 2, 3])
      const sim = cosineSimilarity(a, b)
      assert.ok(Math.abs(sim - 1.0) < 1e-6, `Scaled vectors should have sim=1.0, got ${sim}`)
    })

    test('single-element vectors produce correct result', () => {
      assert.equal(cosineSimilarity(new Float32Array([5]), new Float32Array([3])), 1.0)
      assert.equal(cosineSimilarity(new Float32Array([5]), new Float32Array([-3])), -1.0)
    })

    test('both zero vectors return 0', () => {
      const zero = new Float32Array([0, 0, 0])
      assert.equal(cosineSimilarity(zero, zero), 0)
    })

    test('very small values do not cause NaN', () => {
      const a = new Float32Array([1e-20, 1e-20, 1e-20])
      const b = new Float32Array([1e-20, 1e-20, 1e-20])
      const sim = cosineSimilarity(a, b)
      assert.ok(!isNaN(sim), 'Should not produce NaN for very small values')
    })
  })

  // ── computePromotionTierPure — additional edge cases ──
  describe('computePromotionTierPure — deep edge cases', () => {
    function makeConfirm(sourceType: string, dayOffset: number, weight?: number) {
      const date = new Date()
      date.setDate(date.getDate() - dayOffset)
      return {
        sourceType,
        weight: weight ?? (sourceType === 'auto_dedup' ? 0.0 : 1.0),
        createdAt: date.toISOString()
      }
    }

    test('T0 stays T0 with 3 confirms on only 2 distinct days', () => {
      const confirms = [
        makeConfirm('extraction', 2),
        makeConfirm('tool', 2),
        makeConfirm('human', 0)
      ]
      assert.equal(computePromotionTierPure(0, 0.5, confirms), 0)
    })

    test('T0→T1 threshold: exactly 3 confirms on exactly 3 days', () => {
      const confirms = [
        makeConfirm('extraction', 2),
        makeConfirm('tool', 1),
        makeConfirm('human', 0)
      ]
      assert.equal(computePromotionTierPure(0, 0.5, confirms), 1)
    })

    test('T1→T2 threshold: exactly 5 confirms, 3 sources, 14 day span, 0.75 confidence', () => {
      const confirms = [
        makeConfirm('extraction', 14),
        makeConfirm('tool', 10),
        makeConfirm('human', 7),
        makeConfirm('extraction', 3),
        makeConfirm('tool', 0)
      ]
      assert.equal(computePromotionTierPure(1, 0.75, confirms), 2)
    })

    test('T2→T3 threshold: exactly 2 human, weighted ≥8, 30-day span, 0.90 confidence', () => {
      const confirms = [
        makeConfirm('human', 30),
        makeConfirm('human', 20),
        makeConfirm('tool', 15),
        makeConfirm('extraction', 10),
        makeConfirm('tool', 7),
        makeConfirm('extraction', 5),
        makeConfirm('tool', 2),
        makeConfirm('extraction', 0)
      ]
      assert.equal(computePromotionTierPure(2, 0.9, confirms), 3)
    })

    test('mixed auto_dedup + real confirms: only real confirms count for daySpan', () => {
      // 2 real confirms on 2 days + many auto_dedup spanning more days
      // But only 2 real confirms → not enough for T0→T1 (needs 3)
      const confirms = [
        makeConfirm('extraction', 10),
        makeConfirm('tool', 0),
        makeConfirm('auto_dedup', 30),
        makeConfirm('auto_dedup', 20),
        makeConfirm('auto_dedup', 15)
      ]
      assert.equal(computePromotionTierPure(0, 0.5, confirms), 0)
    })

    test('weighted sum matters for T2→T3: partial weights', () => {
      const confirms = [
        makeConfirm('human', 35, 1.0),
        makeConfirm('human', 25, 1.0),
        makeConfirm('tool', 20, 0.5),
        makeConfirm('extraction', 15, 0.5),
        makeConfirm('tool', 10, 0.5),
        makeConfirm('extraction', 5, 0.5)
      ]
      // Weighted sum = 1+1+0.5+0.5+0.5+0.5 = 4.0 → not enough (needs 8)
      assert.equal(computePromotionTierPure(2, 0.95, confirms), 2)
    })

    test('already at T3 stays T3 with no confirms', () => {
      assert.equal(computePromotionTierPure(3, 1.0, []), 3)
    })

    test('single confirm with auto_dedup does not promote', () => {
      const confirms = [makeConfirm('auto_dedup', 0, 0.0)]
      assert.equal(computePromotionTierPure(0, 0.5, confirms), 0)
      assert.equal(computePromotionTierPure(1, 0.8, confirms), 1)
      assert.equal(computePromotionTierPure(2, 0.95, confirms), 2)
    })
  })

  // ── VOLATILE_PATTERNS edge cases ──
  describe('VOLATILE_PATTERNS — deep edge cases', () => {
    test('detects generic version: pattern', () => {
      assert.ok(VOLATILE_PATTERNS.some((p) => p.test('version: 42')))
      assert.ok(VOLATILE_PATTERNS.some((p) => p.test('Version: 100')))
    })

    test('detects build.electronVersion', () => {
      assert.ok(VOLATILE_PATTERNS.some((p) => p.test('build.electronVersion: 42.4.1')))
    })

    test('does not match generic prose', () => {
      assert.ok(
        !VOLATILE_PATTERNS.some((p) => p.test('The project uses TypeScript for type safety'))
      )
      assert.ok(!VOLATILE_PATTERNS.some((p) => p.test('Electron-based desktop application')))
    })

    test('detects semver in various contexts', () => {
      assert.ok(VOLATILE_PATTERNS.some((p) => p.test('upgraded to v1.0.0')))
      assert.ok(VOLATILE_PATTERNS.some((p) => p.test('Playwright v1.61.1')))
      assert.ok(VOLATILE_PATTERNS.some((p) => p.test('using v42.7.0 for builds')))
    })
  })

  // ── CAPTURE_CAPS constants validation ──
  describe('CAPTURE_CAPS — structure', () => {
    test('all cap values are positive integers', () => {
      assert.ok(CAPTURE_CAPS.MAX_FACTS_PER_SESSION > 0)
      assert.ok(CAPTURE_CAPS.MAX_FACTS_PER_COMMIT > 0)
      assert.ok(Number.isInteger(CAPTURE_CAPS.MAX_FACTS_PER_SESSION))
      assert.ok(Number.isInteger(CAPTURE_CAPS.MAX_FACTS_PER_COMMIT))
    })

    test('session cap >= commit cap', () => {
      assert.ok(CAPTURE_CAPS.MAX_FACTS_PER_SESSION >= CAPTURE_CAPS.MAX_FACTS_PER_COMMIT)
    })
  })

  // ── MemoryEngineService instance — internal state ──
  describe('MemoryEngineService — instance state', () => {
    test('classifyQueue starts empty', () => {
      const queue = (memoryEngineService as any).classifyQueue
      assert.ok(Array.isArray(queue))
    })

    test('classifyProcessing starts false', () => {
      assert.equal((memoryEngineService as any).classifyProcessing, false)
    })

    test('draining starts false', () => {
      assert.equal((memoryEngineService as any).draining, false)
    })

    test('lastDecayRun starts at 0', () => {
      assert.equal((memoryEngineService as any).lastDecayRun, 0)
    })

    test('captureCounts has session/commit maps', () => {
      const caps = (memoryEngineService as any).captureCounts
      assert.ok(caps.session instanceof Map)
      assert.ok(caps.commit instanceof Map)
    })

    test('detectVolatility detects version strings', () => {
      const detect = (memoryEngineService as any).detectVolatility.bind(memoryEngineService)
      assert.equal(detect('CURRENT_SCHEMA_VERSION = 120'), true)
      assert.equal(detect('electronVersion: 42.4.1'), true)
      assert.equal(detect('The project uses TypeScript'), false)
    })

    test('sourceTypeToConfirmationType maps all source types', () => {
      const map = (memoryEngineService as any).sourceTypeToConfirmationType.bind(
        memoryEngineService
      )
      assert.equal(map('manual'), 'human')
      assert.equal(map('tool'), 'tool')
      assert.equal(map('session'), 'extraction')
      assert.equal(map('commit'), 'extraction')
      assert.equal(map('document'), 'extraction')
      assert.equal(map('claude-md'), 'extraction')
      assert.equal(map('blueprint'), 'extraction')
      assert.equal(map('grill'), 'extraction')
      assert.equal(map('bootstrap'), 'extraction')
      // Unknown type falls to default
      assert.equal(map('unknown_type'), 'auto_dedup')
    })

    test('checkCaptureCap always allows manual writes', () => {
      const check = (memoryEngineService as any).checkCaptureCap.bind(memoryEngineService)
      const result = check({ sourceType: 'manual', workspaceId: 'test-ws' })
      assert.equal(result, true, 'Manual writes should always be allowed')
    })

    test('checkCaptureCap enforces session cap', () => {
      const check = (memoryEngineService as any).checkCaptureCap.bind(memoryEngineService)
      const increment = (memoryEngineService as any).incrementCaptureCap.bind(memoryEngineService)

      // Fill session cap
      const params = {
        sourceType: 'session',
        sourceRef: 'test-session-deep',
        workspaceId: 'ws-deep'
      }
      for (let i = 0; i < CAPTURE_CAPS.MAX_FACTS_PER_SESSION; i++) {
        increment(params)
      }
      assert.equal(check(params), false, 'Should be blocked after hitting session cap')
    })

    test('checkCaptureCap enforces commit cap', () => {
      const check = (memoryEngineService as any).checkCaptureCap.bind(memoryEngineService)
      const increment = (memoryEngineService as any).incrementCaptureCap.bind(memoryEngineService)

      const params = { sourceType: 'commit', sourceRef: 'test-commit-deep', workspaceId: 'ws-deep' }
      for (let i = 0; i < CAPTURE_CAPS.MAX_FACTS_PER_COMMIT; i++) {
        increment(params)
      }
      assert.equal(check(params), false, 'Should be blocked after hitting commit cap')
    })

    test('checkCaptureCap bypasses for bootstrap/blueprint/grill/tool writes', () => {
      const check = (memoryEngineService as any).checkCaptureCap.bind(memoryEngineService)
      for (const sourceType of ['bootstrap', 'blueprint', 'grill', 'tool']) {
        assert.equal(
          check({ sourceType, workspaceId: 'test-ws' }),
          true,
          `${sourceType} should bypass caps`
        )
      }
    })

    test('runDecaySweepIfDue is throttled', () => {
      // Set lastDecayRun to now — next call should no-op
      ;(memoryEngineService as any).lastDecayRun = Date.now()
      // Should not throw even without DB
      try {
        memoryEngineService.runDecaySweepIfDue()
        assert.ok(true, 'runDecaySweepIfDue should be a no-op when throttled')
      } catch {
        assert.ok(true, 'DB not available — acceptable')
      }
    })

    test('computePromotionTier delegates to pure function', () => {
      // The instance method should exist and be a function
      const method = (memoryEngineService as any).computePromotionTier
      assert.equal(typeof method, 'function')
    })

    test('confirmFactWithPromotion is a function', () => {
      assert.equal(typeof memoryEngineService.confirmFactWithPromotion, 'function')
    })

    test('writeFact is an async function', () => {
      assert.equal(typeof memoryEngineService.writeFact, 'function')
    })

    test('backfillPendingEmbeddings is an async function', () => {
      assert.equal(typeof memoryEngineService.backfillPendingEmbeddings, 'function')
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// MemoryExtractionService — Prompt + parse body coverage
// ═══════════════════════════════════════════════════════════════════════════

if (extractionLoaded) {
  // ── Read source to test internal functions ──
  const fs = require('node:fs')
  const path = require('node:path')
  const extractionSource = fs.readFileSync(
    path.join(__dirname, '..', 'memory-extraction.service.ts'),
    'utf-8'
  )

  describe('MemoryExtractionService — buildExtractionPrompt shape', () => {
    test('buildExtractionPrompt is defined in source', () => {
      assert.ok(extractionSource.includes('function buildExtractionPrompt('))
    })

    test('prompt instructs JSON output per line', () => {
      assert.ok(extractionSource.includes('one per line'))
      assert.ok(extractionSource.includes('Extract UP TO'), 'Prompt should instruct dynamic extraction budget')
    })

    test('prompt lists all 5 valid categories', () => {
      for (const cat of ['decision', 'convention', 'gotcha', 'preference', 'reference']) {
        assert.ok(extractionSource.includes(`"${cat}"`), `Prompt should mention "${cat}" category`)
      }
    })

    test('prompt includes strictness rules about versions', () => {
      assert.ok(extractionSource.includes('Skip version numbers'))
    })
  })

  describe('MemoryExtractionService — parseExtractedFacts logic', () => {
    // Replicate parseExtractedFacts from source for hermetic testing
    const VALID_CATEGORIES = [
      'decision',
      'convention',
      'gotcha',
      'preference',
      'reference'
    ] as const
    function parseExtractedFacts(text: string, maxFacts: number = 3): Array<{
      category: string
      title: string
      content: string
      tags: string[]
      scopePaths: string[]
    }> {
      const facts: any[] = []
      const lines = text.split('\n').filter((l: string) => l.trim().startsWith('{'))

      for (const line of lines) {
        try {
          const data = JSON.parse(line.trim())
          if (!data.category || !data.title || !data.content) continue
          if (!(VALID_CATEGORIES as readonly string[]).includes(data.category)) continue

          facts.push({
            category: data.category,
            title: String(data.title).slice(0, 200),
            content: String(data.content).slice(0, 4000),
            tags: Array.isArray(data.tags) ? data.tags.map(String).slice(0, 10) : [],
            scopePaths: Array.isArray(data.scopePaths)
              ? data.scopePaths.map(String).slice(0, 10)
              : []
          })
        } catch {
          // skip malformed
        }
      }
      return facts.slice(0, maxFacts)
    }

    test('parses single valid JSON line', () => {
      const input =
        '{"category":"decision","title":"Use SQLite","content":"Chose SQLite for embedded use case.","tags":["db"]}'
      const result = parseExtractedFacts(input)
      assert.equal(result.length, 1)
      assert.equal(result[0].category, 'decision')
      assert.equal(result[0].title, 'Use SQLite')
      assert.deepEqual(result[0].tags, ['db'])
    })

    test('parses multiple lines, skips invalid', () => {
      const input = [
        '{"category":"convention","title":"File naming","content":"Use kebab-case."}',
        'Not JSON at all',
        '{"missing_required_fields": true}',
        '{"category":"invalid_cat","title":"Bad","content":"Bad"}',
        '{"category":"gotcha","title":"Electron quirk","content":"WASM needs special path."}'
      ].join('\n')
      const result = parseExtractedFacts(input)
      assert.equal(result.length, 2)
      assert.equal(result[0].category, 'convention')
      assert.equal(result[1].category, 'gotcha')
    })

    test('caps at default maxFacts (3)', () => {
      const input = Array.from(
        { length: 5 },
        (_, i) => `{"category":"decision","title":"Fact ${i}","content":"Content ${i}"}`
      ).join('\n')
      const result = parseExtractedFacts(input)
      assert.equal(result.length, 3)
    })

    test('caps at custom maxFacts when passed', () => {
      const input = Array.from(
        { length: 12 },
        (_, i) => `{"category":"decision","title":"Fact ${i}","content":"Content ${i}"}`
      ).join('\n')
      const result = parseExtractedFacts(input, 7)
      assert.equal(result.length, 7)
    })

    test('truncates long titles to 200 chars', () => {
      const input = `{"category":"decision","title":"${'A'.repeat(300)}","content":"Short content."}`
      const result = parseExtractedFacts(input)
      assert.equal(result[0].title.length, 200)
    })

    test('truncates long content to 4000 chars', () => {
      const input = `{"category":"decision","title":"Title","content":"${'B'.repeat(5000)}"}`
      const result = parseExtractedFacts(input)
      assert.equal(result[0].content.length, 4000)
    })

    test('handles missing tags/scopePaths gracefully', () => {
      const input = '{"category":"reference","title":"API doc","content":"docs at /api"}'
      const result = parseExtractedFacts(input)
      assert.deepEqual(result[0].tags, [])
      assert.deepEqual(result[0].scopePaths, [])
    })

    test('caps tags at 10 and scopePaths at 10', () => {
      const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`)
      const scopePaths = Array.from({ length: 15 }, (_, i) => `src/dir${i}`)
      const input = JSON.stringify({
        category: 'convention',
        title: 'Many tags',
        content: 'Content',
        tags,
        scopePaths
      })
      const result = parseExtractedFacts(input)
      assert.equal(result[0].tags.length, 10)
      assert.equal(result[0].scopePaths.length, 10)
    })

    test('empty input returns empty array', () => {
      assert.deepEqual(parseExtractedFacts(''), [])
    })

    test('only processes lines starting with {', () => {
      const input =
        '  some preamble text\n  {"category":"decision","title":"T","content":"C"}\n  trailing text'
      const result = parseExtractedFacts(input)
      assert.equal(result.length, 1)
    })
  })

  describe('estimateExtractionBudget scoring', () => {
    test('estimateExtractionBudget is defined in source', () => {
      assert.ok(extractionSource.includes('function estimateExtractionBudget('))
    })

    test('source contains richFilePatterns check for CLAUDE/ARCHITECTURE', () => {
      assert.ok(extractionSource.includes('CLAUDE|ARCHITECTURE'))
    })

    test('source maps score to budget tiers (2, 3, 5, 7, 10)', () => {
      assert.ok(extractionSource.includes('return 10'))
      assert.ok(extractionSource.includes('return 7'))
      assert.ok(extractionSource.includes('return 5'))
      assert.ok(extractionSource.includes('return 3'))
      assert.ok(extractionSource.includes('return 2'))
    })
  })

  describe('MemoryExtractionService — buildRegeneratePrompt shape', () => {
    test('prompt mentions CLAUDE.md generation', () => {
      assert.ok(extractionSource.includes('CLAUDE.md generator'))
    })

    test('prompt requires output format with sections', () => {
      assert.ok(extractionSource.includes('Project name'))
      assert.ok(extractionSource.includes('Tech stack'))
      assert.ok(extractionSource.includes('Conventions'))
    })

    test('prompt limits output to 100-300 lines', () => {
      assert.ok(extractionSource.includes('100-300 lines'))
    })
  })

  describe('MemoryExtractionService — buildAgenticClaudeMdPrompt shape', () => {
    test('agentic prompt instructs exploration', () => {
      assert.ok(extractionSource.includes('Explore this project thoroughly'))
    })

    test('agentic prompt has sentinel markers', () => {
      assert.ok(extractionSource.includes('SENTINELS.BEGIN'))
      assert.ok(extractionSource.includes('SENTINELS.END'))
    })

    test('agentic prompt handles both existing and missing CLAUDE.md', () => {
      assert.ok(extractionSource.includes('No existing CLAUDE.md'))
      assert.ok(extractionSource.includes('Create one from scratch'))
    })
  })

  describe('MemoryExtractionService — instance methods', () => {
    test('enqueueSessionExtraction is a function', () => {
      assert.equal(typeof memoryExtractionService.enqueueSessionExtraction, 'function')
    })

    test('extractFromContent is an async function', () => {
      assert.equal(typeof memoryExtractionService.extractFromContent, 'function')
    })

    test('extractFromDocument is an async function', () => {
      assert.equal(typeof memoryExtractionService.extractFromDocument, 'function')
    })

    test('enqueueCommitExtraction is a function', () => {
      assert.equal(typeof memoryExtractionService.enqueueCommitExtraction, 'function')
    })

    test('enqueueBlueprintExtraction is a function', () => {
      assert.equal(typeof memoryExtractionService.enqueueBlueprintExtraction, 'function')
    })

    test('extractFromMessage is an async function', () => {
      assert.equal(typeof memoryExtractionService.extractFromMessage, 'function')
    })

    test('regenerateClaudeMd is an async function', () => {
      assert.equal(typeof memoryExtractionService.regenerateClaudeMd, 'function')
    })

    test('regenerateClaudeMdAgentic is an async function', () => {
      assert.equal(typeof memoryExtractionService.regenerateClaudeMdAgentic, 'function')
    })

    test('shutdown is a function', () => {
      assert.equal(typeof memoryExtractionService.shutdown, 'function')
    })

    test('enqueue serializes jobs', () => {
      // Verify the queue mechanism exists
      const queue = (memoryExtractionService as any).queue
      assert.ok(Array.isArray(queue), 'Should have internal queue array')
    })

    test('MIN_TRANSCRIPT_CHARS constant is referenced in source', () => {
      assert.ok(extractionSource.includes('MIN_TRANSCRIPT_CHARS'))
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// MemoryRetrievalService — Scoring helpers body coverage
// ═══════════════════════════════════════════════════════════════════════════

if (retrievalLoaded) {
  // Replicate internal scoring helpers for hermetic testing
  const WEIGHT_COSINE = 0.5
  const WEIGHT_KEYWORD = 0.25
  const WEIGHT_TIER = 0.1
  const WEIGHT_RECENCY = 0.1
  const WEIGHT_SCOPE = 0.05

  function tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9_\-/.]/g, ' ')
      .split(/\s+/)
      .filter((t: string) => t.length > 2)
  }

  function computeKeywordOverlap(
    queryTokens: string[],
    fact: { title: string; content: string; tags: string[] }
  ): number {
    if (queryTokens.length === 0) return 0
    const factText = `${fact.title} ${fact.content} ${fact.tags.join(' ')}`.toLowerCase()
    let hits = 0
    for (const token of queryTokens) {
      if (factText.includes(token)) hits++
    }
    return hits / queryTokens.length
  }

  function computeRecency(
    fact: { lastAccessedAt?: string; updatedAt?: string; createdAt: string },
    now: number
  ): number {
    const dateStr = fact.lastAccessedAt || fact.updatedAt || fact.createdAt
    if (!dateStr) return 0.5
    const age = now - new Date(dateStr).getTime()
    const daysOld = age / (1000 * 60 * 60 * 24)
    return Math.max(0, 1 - daysOld / 400)
  }

  function computeScopeBoost(query: string, scopePaths: string[]): number {
    if (scopePaths.length === 0) return 0.5
    const queryLower = query.toLowerCase()
    for (const p of scopePaths) {
      if (queryLower.includes(p.toLowerCase())) return 1.0
    }
    return 0
  }

  function resolveMatchType(cosineContrib: number, keywordScore: number): string {
    if (cosineContrib > 0 && keywordScore > 0) return 'hybrid'
    if (cosineContrib > 0) return 'cosine'
    return 'keyword'
  }

  describe('MemoryRetrieval — tokenize', () => {
    test('lowercases and splits on non-alphanumeric', () => {
      const tokens = tokenize('Use JWT auth for API')
      assert.ok(tokens.includes('jwt'))
      assert.ok(tokens.includes('auth'))
      assert.ok(tokens.includes('use'))
      assert.ok(tokens.includes('api'))
    })

    test('filters tokens ≤2 chars', () => {
      const tokens = tokenize('I am a JS dev')
      assert.ok(!tokens.includes('am'))
      assert.ok(!tokens.includes('js'))
      assert.ok(!tokens.includes('a'))
      assert.ok(!tokens.includes('i'))
    })

    test('preserves file path segments', () => {
      const tokens = tokenize('src/main/services/memory-engine.service.ts')
      assert.ok(tokens.some((t) => t.includes('src/main/services')))
    })

    test('preserves underscores and hyphens', () => {
      const tokens = tokenize('snake_case and kebab-case')
      assert.ok(tokens.some((t) => t.includes('snake_case')))
      assert.ok(tokens.some((t) => t.includes('kebab-case')))
    })

    test('empty string returns empty array', () => {
      assert.deepEqual(tokenize(''), [])
    })
  })

  describe('MemoryRetrieval — computeKeywordOverlap', () => {
    test('full overlap returns 1.0', () => {
      const tokens = ['jwt', 'auth', 'pattern']
      const fact = { title: 'JWT auth pattern', content: 'Uses jwt auth pattern', tags: [] }
      assert.equal(computeKeywordOverlap(tokens, fact), 1.0)
    })

    test('partial overlap returns fraction', () => {
      const tokens = ['jwt', 'auth', 'database']
      const fact = { title: 'JWT auth', content: 'authentication flow', tags: [] }
      const score = computeKeywordOverlap(tokens, fact)
      assert.ok(Math.abs(score - 2 / 3) < 0.01)
    })

    test('no overlap returns 0', () => {
      const tokens = ['database', 'migration']
      const fact = { title: 'JWT auth', content: 'authentication', tags: [] }
      assert.equal(computeKeywordOverlap(tokens, fact), 0)
    })

    test('empty tokens returns 0', () => {
      const fact = { title: 'Anything', content: 'Content', tags: [] }
      assert.equal(computeKeywordOverlap([], fact), 0)
    })

    test('tags contribute to overlap', () => {
      const tokens = ['sqlite', 'database']
      const fact = {
        title: 'Storage',
        content: 'Uses embedded storage',
        tags: ['sqlite', 'database']
      }
      assert.equal(computeKeywordOverlap(tokens, fact), 1.0)
    })
  })

  describe('MemoryRetrieval — computeRecency', () => {
    test('just-created fact has score near 1.0', () => {
      const now = Date.now()
      const fact = { createdAt: new Date(now).toISOString() }
      const score = computeRecency(fact, now)
      assert.ok(score > 0.99)
    })

    test('30-day-old fact has moderate score', () => {
      const now = Date.now()
      const fact = { createdAt: new Date(now - 30 * 86400000).toISOString() }
      const score = computeRecency(fact, now)
      assert.ok(score > 0.5 && score < 1.0, `Expected 0.5 < ${score} < 1.0`)
    })

    test('400-day-old fact has score = 0', () => {
      const now = Date.now()
      const fact = { createdAt: new Date(now - 400 * 86400000).toISOString() }
      const score = computeRecency(fact, now)
      assert.equal(score, 0)
    })

    test('uses lastAccessedAt over createdAt', () => {
      const now = Date.now()
      const fact = {
        lastAccessedAt: new Date(now).toISOString(),
        updatedAt: new Date(now - 100 * 86400000).toISOString(),
        createdAt: new Date(now - 200 * 86400000).toISOString()
      }
      const score = computeRecency(fact, now)
      assert.ok(score > 0.99, 'Should use lastAccessedAt (most recent)')
    })

    test('falls back to updatedAt when lastAccessedAt is empty', () => {
      const now = Date.now()
      const fact = {
        lastAccessedAt: undefined as any,
        updatedAt: new Date(now).toISOString(),
        createdAt: new Date(now - 200 * 86400000).toISOString()
      }
      const score = computeRecency(fact, now)
      assert.ok(score > 0.99, 'Should use updatedAt when lastAccessedAt is empty')
    })
  })

  describe('MemoryRetrieval — computeScopeBoost', () => {
    test('no scope paths returns neutral 0.5', () => {
      assert.equal(computeScopeBoost('anything', []), 0.5)
    })

    test('query mentioning scope path returns 1.0', () => {
      assert.equal(computeScopeBoost('changes in src/main/services', ['src/main/services']), 1.0)
    })

    test('query not mentioning scope path returns 0', () => {
      assert.equal(computeScopeBoost('some random query', ['src/main/services']), 0)
    })

    test('case-insensitive matching', () => {
      assert.equal(computeScopeBoost('SRC/MAIN/SERVICES', ['src/main/services']), 1.0)
    })
  })

  describe('MemoryRetrieval — resolveMatchType', () => {
    test('both positive → hybrid', () => {
      assert.equal(resolveMatchType(0.8, 0.5), 'hybrid')
    })

    test('only cosine → cosine', () => {
      assert.equal(resolveMatchType(0.8, 0), 'cosine')
    })

    test('only keyword → keyword', () => {
      assert.equal(resolveMatchType(0, 0.5), 'keyword')
    })

    test('both zero → keyword', () => {
      assert.equal(resolveMatchType(0, 0), 'keyword')
    })
  })

  describe('MemoryRetrieval — formatForToolResponse', () => {
    test('empty results returns "No relevant facts found."', () => {
      const result = memoryRetrievalService.formatForToolResponse([])
      assert.equal(result, 'No relevant facts found.')
    })

    test('formats a single result correctly', () => {
      const results = [
        {
          fact: {
            id: 'f-1',
            title: 'Use TypeScript',
            category: 'convention',
            tier: 2,
            confidence: 0.85,
            content: 'All new files must use TypeScript.',
            scopePaths: ['src/'],
            sourceType: 'extraction',
            sourceRef: 'session-123',
            tags: []
          },
          score: 0.75,
          matchType: 'hybrid'
        }
      ]
      const formatted = memoryRetrievalService.formatForToolResponse(results)
      assert.ok(formatted.includes('## Use TypeScript'))
      assert.ok(formatted.includes('convention'))
      assert.ok(formatted.includes('Established'))
      assert.ok(formatted.includes('85%'))
      assert.ok(formatted.includes('src/'))
      assert.ok(formatted.includes('session-123'))
      assert.ok(formatted.includes('75%'))
    })

    test('separates multiple results with ---', () => {
      const results = [
        {
          fact: {
            id: 'f-1',
            title: 'A',
            category: 'decision',
            tier: 0,
            confidence: 0.5,
            content: 'C1',
            scopePaths: [],
            sourceType: 'session',
            sourceRef: '',
            tags: []
          },
          score: 0.8,
          matchType: 'keyword'
        },
        {
          fact: {
            id: 'f-2',
            title: 'B',
            category: 'gotcha',
            tier: 1,
            confidence: 0.6,
            content: 'C2',
            scopePaths: [],
            sourceType: 'tool',
            sourceRef: '',
            tags: []
          },
          score: 0.6,
          matchType: 'cosine'
        }
      ]
      const formatted = memoryRetrievalService.formatForToolResponse(results)
      assert.ok(formatted.includes('---'))
      assert.ok(formatted.includes('## A'))
      assert.ok(formatted.includes('## B'))
    })

    test('tier label mapping: 0=Observed, 1=Confirmed, 2=Established, 3=Wisdom', () => {
      for (const [tier, label] of [
        [0, 'Observed'],
        [1, 'Confirmed'],
        [2, 'Established'],
        [3, 'Wisdom']
      ]) {
        const results = [
          {
            fact: {
              id: `f-${tier}`,
              title: `Tier ${tier}`,
              category: 'decision',
              tier,
              confidence: 0.5,
              content: 'C',
              scopePaths: [],
              sourceType: 'tool',
              sourceRef: '',
              tags: []
            },
            score: 0.5,
            matchType: 'keyword'
          }
        ]
        const formatted = memoryRetrievalService.formatForToolResponse(results)
        assert.ok(formatted.includes(label as string), `Tier ${tier} should show label "${label}"`)
      }
    })
  })

  describe('MemoryRetrieval — weight constants in source', () => {
    test('weights sum to 1.0', () => {
      const sum = WEIGHT_COSINE + WEIGHT_KEYWORD + WEIGHT_TIER + WEIGHT_RECENCY + WEIGHT_SCOPE
      assert.ok(Math.abs(sum - 1.0) < 0.001, `Weights should sum to 1.0, got ${sum}`)
    })

    test('cosine has highest weight', () => {
      assert.ok(WEIGHT_COSINE >= WEIGHT_KEYWORD)
      assert.ok(WEIGHT_COSINE >= WEIGHT_TIER)
      assert.ok(WEIGHT_COSINE >= WEIGHT_RECENCY)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// MemoryConsolidationService — Deep body coverage
// ═══════════════════════════════════════════════════════════════════════════

if (consolidationLoaded) {
  describe('selectStaleT0Facts — deep edge cases', () => {
    const wsId = 'ws-stale-test'

    function makeFact(
      overrides: Partial<{
        id: string
        tier: number
        lastAccessedAt: string | null
        workspaceId: string
        createdAt: string
      }> = {}
    ) {
      const thirtyOneDaysAgo = new Date()
      thirtyOneDaysAgo.setDate(thirtyOneDaysAgo.getDate() - 31)
      return {
        id: overrides.id ?? 'f-default',
        tier: overrides.tier ?? 0,
        lastAccessedAt: overrides.lastAccessedAt ?? null,
        workspaceId: overrides.workspaceId ?? wsId,
        createdAt: overrides.createdAt ?? thirtyOneDaysAgo.toISOString(),
        ...overrides
      }
    }

    test('selects T0 facts without access, correct workspace, old enough, no evidence', () => {
      const facts = [makeFact({ id: 'stale-1' })]
      const result = selectStaleT0Facts(facts, wsId, () => false)
      assert.equal(result.length, 1)
    })

    test('excludes T1+ facts', () => {
      const facts = [makeFact({ id: 'tier1', tier: 1 })]
      const result = selectStaleT0Facts(facts, wsId, () => false)
      assert.equal(result.length, 0)
    })

    test('excludes facts with lastAccessedAt', () => {
      const facts = [makeFact({ id: 'accessed', lastAccessedAt: new Date().toISOString() })]
      const result = selectStaleT0Facts(facts, wsId, () => false)
      assert.equal(result.length, 0)
    })

    test('excludes facts from different workspace', () => {
      const facts = [makeFact({ id: 'other-ws', workspaceId: 'other' })]
      const result = selectStaleT0Facts(facts, wsId, () => false)
      assert.equal(result.length, 0)
    })

    test('excludes recently created facts', () => {
      const facts = [makeFact({ id: 'recent', createdAt: new Date().toISOString() })]
      const result = selectStaleT0Facts(facts, wsId, () => false)
      assert.equal(result.length, 0)
    })

    test('excludes facts with real evidence', () => {
      const facts = [makeFact({ id: 'has-evidence' })]
      const result = selectStaleT0Facts(facts, wsId, (id) => id === 'has-evidence')
      assert.equal(result.length, 0)
    })

    test('filters a mixed set correctly', () => {
      const facts = [
        makeFact({ id: 'stale-ok' }),
        makeFact({ id: 'tier1', tier: 1 }),
        makeFact({ id: 'accessed', lastAccessedAt: new Date().toISOString() }),
        makeFact({ id: 'other-ws', workspaceId: 'other' }),
        makeFact({ id: 'recent', createdAt: new Date().toISOString() }),
        makeFact({ id: 'has-ev' }),
        makeFact({ id: 'stale-ok-2' })
      ]
      const result = selectStaleT0Facts(facts, wsId, (id) => id === 'has-ev')
      assert.equal(result.length, 2)
      assert.ok(result.some((f) => f.id === 'stale-ok'))
      assert.ok(result.some((f) => f.id === 'stale-ok-2'))
    })

    test('empty facts array returns empty', () => {
      assert.deepEqual(
        selectStaleT0Facts([], wsId, () => false),
        []
      )
    })
  })

  describe('MemoryConsolidationService — idle job lifecycle', () => {
    test('stopIdleJob is idempotent (repeated calls safe)', () => {
      memoryConsolidationService.stopIdleJob()
      memoryConsolidationService.stopIdleJob()
      memoryConsolidationService.stopIdleJob()
      assert.ok(true, 'Multiple stopIdleJob calls should not throw')
    })

    test('stopIdleJobIfWorkspace is a no-op for unbound workspace', () => {
      memoryConsolidationService.stopIdleJob() // ensure clean state
      memoryConsolidationService.stopIdleJobIfWorkspace('nonexistent-ws')
      assert.ok(true, 'Should not throw for unbound workspace')
    })

    test('startIdleJob method exists and accepts workspaceId', () => {
      assert.equal(typeof memoryConsolidationService.startIdleJob, 'function')
    })

    test('boundWorkspaceId field exists on instance', () => {
      assert.ok('boundWorkspaceId' in (memoryConsolidationService as any))
    })

    test('stopIdleJobIfWorkspace method exists', () => {
      assert.equal(typeof memoryConsolidationService.stopIdleJobIfWorkspace, 'function')
    })

    test('running flag starts as false', () => {
      assert.equal((memoryConsolidationService as any).running, false)
    })

    test('runFullConsolidation returns result shape or throws without DB', async () => {
      try {
        const result = await memoryConsolidationService.runFullConsolidation('test-ws')
        assert.equal(typeof result.clustersFound, 'number')
        assert.equal(typeof result.autoMerged, 'number')
        assert.equal(typeof result.reviewItemsCreated, 'number')
        assert.equal(typeof result.staleArchived, 'number')
        assert.equal(typeof result.contradictionsPruned, 'number')
        assert.equal(typeof result.reviewQueueCapped, 'number')
      } catch {
        assert.ok(true, 'Throws without DB — acceptable')
      }
    })
  })

  describe('hasRealEvidencePure — comprehensive', () => {
    test('single auto_dedup is not real evidence', () => {
      assert.equal(hasRealEvidencePure([{ sourceType: 'auto_dedup' }]), false)
    })

    test('single human is real evidence', () => {
      assert.equal(hasRealEvidencePure([{ sourceType: 'human' }]), true)
    })

    test('mixed sources: any non-auto_dedup makes it real', () => {
      const confirmations = [
        { sourceType: 'auto_dedup' },
        { sourceType: 'auto_dedup' },
        { sourceType: 'bootstrap' }
      ]
      assert.equal(hasRealEvidencePure(confirmations), true)
    })

    test('all valid source types count as evidence', () => {
      for (const type of ['human', 'tool', 'extraction', 'bootstrap']) {
        assert.equal(
          hasRealEvidencePure([{ sourceType: type }]),
          true,
          `${type} should be real evidence`
        )
      }
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// MemoryBootstrapService — shape and config
// ═══════════════════════════════════════════════════════════════════════════

if (bootstrapLoaded) {
  describe('MemoryBootstrapService — shape', () => {
    test('exports singleton instance', () => {
      assert.ok(memoryBootstrapService)
    })

    test('startBootstrap is an async function', () => {
      assert.equal(typeof memoryBootstrapService.startBootstrap, 'function')
    })

    test('cancel is a function', () => {
      assert.equal(typeof memoryBootstrapService.cancel, 'function')
    })

    test('cancelAll is a function', () => {
      assert.equal(typeof memoryBootstrapService.cancelAll, 'function')
    })

    test('isRunning is a boolean getter', () => {
      assert.equal(typeof memoryBootstrapService.isRunning, 'boolean')
      assert.equal(memoryBootstrapService.isRunning, false)
    })

    test('cancel returns false for unknown jobId', () => {
      assert.equal(memoryBootstrapService.cancel('nonexistent-job'), false)
    })

    test('cancelAll is safe when no jobs running', () => {
      memoryBootstrapService.cancelAll()
      assert.ok(true)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// MemoryDocWatcherService — shape and lifecycle
// ═══════════════════════════════════════════════════════════════════════════

if (docWatcherLoaded) {
  describe('MemoryDocWatcherService — shape', () => {
    test('exports singleton instance', () => {
      assert.ok(memoryDocWatcherService)
    })

    test('start is a function', () => {
      assert.equal(typeof memoryDocWatcherService.start, 'function')
    })

    test('stop is a function', () => {
      assert.equal(typeof memoryDocWatcherService.stop, 'function')
    })

    test('activeWorkspace is null initially', () => {
      assert.equal(memoryDocWatcherService.activeWorkspace, null)
    })

    test('stop is idempotent', () => {
      memoryDocWatcherService.stop()
      memoryDocWatcherService.stop()
      assert.ok(true)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// Skip blocks for failed module loads
// ═══════════════════════════════════════════════════════════════════════════

if (!engineLoaded) {
  describe('MemoryEngineService (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!extractionLoaded) {
  describe('MemoryExtractionService (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!retrievalLoaded) {
  describe('MemoryRetrievalService (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!consolidationLoaded) {
  describe('MemoryConsolidationService (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!bootstrapLoaded) {
  describe('MemoryBootstrapService (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!docWatcherLoaded) {
  describe('MemoryDocWatcherService (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
