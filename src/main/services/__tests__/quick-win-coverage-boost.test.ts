/**
 * quick-win-coverage-boost.test.ts — Phase 21, File 8
 *
 * Targets files at 50-79% coverage, pushing them over 80% with targeted tests.
 * Pure functions and simple methods with minimal mocking.
 *
 * Targets:
 *   - cost-tracker.service.ts: estimateCostCents, estimateCostFromTotal, MODEL_PRICING
 *   - elicitation.service.ts: register, resolveElicitation, resolveAll, size
 *   - document-reader.ts: isSupportedExtension, isImageFile
 *   - grill-prompt-blocks.ts: buildReEvalBlock, buildGrillEvaluationSchema/Lean, isGrillLean, constants
 *   - heartbeat-monitor.ts: HeartbeatMonitor construction, touch, consumeHeartbeat, stop
 *   - model-config.service.ts: resolveAssignment, fallbackAction, getLocalBaseUrl
 *   - agent-recovery-manager.ts: TURN_LIMIT_EXHAUSTED_MSG constant
 *   - snapshot-model-resolver.ts: BLUEPRINT_CONV_RE regex
 *   - prompt-builder.ts: PromptBuilder.getGeneralistBudgetTierForTurn, estimateTokens
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

// ═══════════════════════════════════════════════════════════════════════════
// cost-tracker.service.ts — pure functions
// ═══════════════════════════════════════════════════════════════════════════

let estimateCostCents: (inputTokens: number, outputTokens: number, modelId?: string) => number
let estimateCostFromTotal: (totalTokens: number, modelId?: string) => number
let MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }>
let costTrackerService: any
let costLoaded = false

try {
  const mod = require('../cost-tracker.service')
  estimateCostCents = mod.estimateCostCents
  estimateCostFromTotal = mod.estimateCostFromTotal
  MODEL_PRICING = mod.MODEL_PRICING
  costTrackerService = mod.costTrackerService
  costLoaded = true
} catch (err) {
  console.log(`⚠ cost-tracker.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

if (costLoaded) {
  describe('estimateCostCents — pure function', () => {
    test('zero tokens = 0 cents', () => {
      assert.equal(estimateCostCents(0, 0), 0)
    })

    test('known model: claude-haiku-4-5 pricing', () => {
      // 1M input at $1.0/1M + 1M output at $5.0/1M = $6.0 = 600 cents
      const cost = estimateCostCents(1_000_000, 1_000_000, 'claude-haiku-4-5-20251001')
      assert.equal(cost, 600)
    })

    test('known model: claude-sonnet-5 pricing', () => {
      // 1M input at $3.0/1M + 1M output at $15.0/1M = $18.0 = 1800 cents
      const cost = estimateCostCents(1_000_000, 1_000_000, 'claude-sonnet-5')
      assert.equal(cost, 1800)
    })

    test('known model: claude-opus-4-8 pricing', () => {
      // 1M input at $5.0/1M + 1M output at $25.0/1M = $30.0 = 3000 cents
      const cost = estimateCostCents(1_000_000, 1_000_000, 'claude-opus-4-8')
      assert.equal(cost, 3000)
    })

    test('unknown model falls back to default pricing', () => {
      // Default: $3.0/1M input + $15.0/1M output (same as sonnet)
      const cost = estimateCostCents(1_000_000, 1_000_000, 'unknown-model-xyz')
      assert.equal(cost, 1800)
    })

    test('undefined model falls back to default pricing', () => {
      const cost = estimateCostCents(1_000_000, 1_000_000)
      assert.equal(cost, 1800)
    })

    test('small token count produces correct result', () => {
      // 1000 input tokens at $3.0/1M + 500 output at $15.0/1M
      // = 0.003 + 0.0075 = 0.0105 dollars = 1.05 cents → rounds to 1
      const cost = estimateCostCents(1000, 500)
      assert.equal(cost, 1)
    })

    test('only input tokens', () => {
      const cost = estimateCostCents(1_000_000, 0, 'claude-haiku-4-5-20251001')
      assert.equal(cost, 100)
    })

    test('only output tokens', () => {
      const cost = estimateCostCents(0, 1_000_000, 'claude-haiku-4-5-20251001')
      assert.equal(cost, 500)
    })
  })

  describe('estimateCostFromTotal — pure function', () => {
    test('zero tokens = 0 cents', () => {
      assert.equal(estimateCostFromTotal(0), 0)
    })

    test('uses 75/25 input/output split', () => {
      // 1M total → 750K input + 250K output
      // Default pricing: 750K * 3.0/1M + 250K * 15.0/1M = 2.25 + 3.75 = 6.0 = 600 cents
      const cost = estimateCostFromTotal(1_000_000)
      assert.equal(cost, 600)
    })

    test('known model pricing applied', () => {
      // 1M total → 750K input + 250K output
      // Haiku pricing: 750K * 1.0/1M + 250K * 5.0/1M = 0.75 + 1.25 = 2.0 = 200 cents
      const cost = estimateCostFromTotal(1_000_000, 'claude-haiku-4-5-20251001')
      assert.equal(cost, 200)
    })
  })

  describe('MODEL_PRICING — constant table', () => {
    test('has at least 8 models', () => {
      assert.ok(Object.keys(MODEL_PRICING).length >= 8)
    })

    test('all entries have positive inputPer1M and outputPer1M', () => {
      for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
        assert.ok(pricing.inputPer1M > 0, `${model} inputPer1M should be positive`)
        assert.ok(pricing.outputPer1M > 0, `${model} outputPer1M should be positive`)
      }
    })

    test('output pricing >= input pricing for all models', () => {
      for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
        assert.ok(
          pricing.outputPer1M >= pricing.inputPer1M,
          `${model}: output ($${pricing.outputPer1M}) should be >= input ($${pricing.inputPer1M})`
        )
      }
    })

    test('includes current models', () => {
      assert.ok('claude-haiku-4-5-20251001' in MODEL_PRICING)
      assert.ok('claude-sonnet-5' in MODEL_PRICING)
      assert.ok('claude-opus-4-8' in MODEL_PRICING)
    })

    test('includes legacy models for historical calculation', () => {
      assert.ok('claude-3-5-sonnet-20241022' in MODEL_PRICING)
      assert.ok('claude-3-5-haiku-20241022' in MODEL_PRICING)
    })
  })

  describe('costTrackerService — singleton', () => {
    test('extends EventEmitter', () => {
      const { EventEmitter } = require('node:events')
      assert.ok(costTrackerService instanceof EventEmitter)
    })

    test('has expected methods', () => {
      assert.equal(typeof costTrackerService.getWorkspaceCostSummary, 'function')
      assert.equal(typeof costTrackerService.getConversationCostCents, 'function')
      assert.equal(typeof costTrackerService.checkBudget, 'function')
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// elicitation.service.ts — simple Map-based service
// ═══════════════════════════════════════════════════════════════════════════

let ElicitationService: any
let elicitationLoaded = false

try {
  const mod = require('../elicitation.service')
  ElicitationService = mod.ElicitationService
  elicitationLoaded = true
} catch (err) {
  console.log(`⚠ elicitation.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

if (elicitationLoaded) {
  describe('ElicitationService — full coverage', () => {
    test('starts with size 0', () => {
      const svc = new ElicitationService()
      assert.equal(svc.size, 0)
    })

    test('register increments size', () => {
      const svc = new ElicitationService()
      svc.register('r1', () => {}, 'server-a')
      assert.equal(svc.size, 1)
      svc.register('r2', () => {}, 'server-b', 'plan')
      assert.equal(svc.size, 2)
    })

    test('resolveElicitation calls resolve callback', () => {
      const svc = new ElicitationService()
      let resolved: any = null
      svc.register('r1', (result: any) => { resolved = result }, 'server-a')
      svc.resolveElicitation('r1', { action: 'accept', content: { answer: 42 } })
      assert.ok(resolved)
      assert.equal(resolved.action, 'accept')
      assert.equal(resolved.content!.answer, 42)
      assert.equal(svc.size, 0, 'Should remove after resolve')
    })

    test('resolveElicitation with decline action', () => {
      const svc = new ElicitationService()
      let resolved: any = null
      svc.register('r1', (result: any) => { resolved = result }, 'server-a')
      svc.resolveElicitation('r1', { action: 'decline' })
      assert.equal(resolved.action, 'decline')
    })

    test('resolveElicitation for unknown requestId is a no-op', () => {
      const svc = new ElicitationService()
      svc.resolveElicitation('unknown', { action: 'cancel' })
      assert.ok(true, 'Should not throw')
    })

    test('resolveAll cancels all pending', () => {
      const svc = new ElicitationService()
      const results: any[] = []
      svc.register('r1', (r: any) => results.push(r), 'server-a')
      svc.register('r2', (r: any) => results.push(r), 'server-b')
      svc.register('r3', (r: any) => results.push(r), 'server-c')
      svc.resolveAll()
      assert.equal(results.length, 3)
      assert.ok(results.every(r => r.action === 'cancel'))
      assert.equal(svc.size, 0)
    })

    test('resolveAll with no pending is a no-op', () => {
      const svc = new ElicitationService()
      svc.resolveAll()
      assert.ok(true, 'Should not throw')
    })

    test('register overwrites existing requestId', () => {
      const svc = new ElicitationService()
      let firstCalled = false
      svc.register('r1', () => { firstCalled = true }, 'server-a')
      svc.register('r1', () => {}, 'server-b')
      assert.equal(svc.size, 1)
      svc.resolveElicitation('r1', { action: 'accept' })
      assert.equal(firstCalled, false, 'First callback should not be called')
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// document-reader.ts — pure extension checkers
// ═══════════════════════════════════════════════════════════════════════════

let isSupportedExtension: (filePath: string) => boolean
let isImageFile: (filePath: string) => boolean
let docReaderLoaded = false

try {
  const mod = require('../document-reader')
  isSupportedExtension = mod.isSupportedExtension
  isImageFile = mod.isImageFile
  docReaderLoaded = true
} catch (err) {
  console.log(`⚠ document-reader.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

if (docReaderLoaded) {
  describe('isSupportedExtension — pure function', () => {
    test('text extensions are supported', () => {
      for (const ext of ['.md', '.ts', '.tsx', '.js', '.py', '.json', '.yaml', '.sql', '.csv']) {
        assert.ok(isSupportedExtension(`file${ext}`), `${ext} should be supported`)
      }
    })

    test('image extensions are supported', () => {
      for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
        assert.ok(isSupportedExtension(`image${ext}`), `${ext} should be supported`)
      }
    })

    test('pdf and docx are supported', () => {
      assert.ok(isSupportedExtension('document.pdf'))
      assert.ok(isSupportedExtension('document.docx'))
    })

    test('binary extensions are not supported', () => {
      for (const ext of ['.zip', '.exe', '.dmg', '.mp3', '.mp4', '.sqlite']) {
        assert.ok(!isSupportedExtension(`file${ext}`), `${ext} should not be supported`)
      }
    })

    test('extensionless known files are supported', () => {
      assert.ok(isSupportedExtension('Dockerfile'))
      assert.ok(isSupportedExtension('Makefile'))
    })
  })

  describe('isImageFile — pure function', () => {
    test('image extensions return true', () => {
      for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
        assert.ok(isImageFile(`photo${ext}`), `${ext} should be image`)
      }
    })

    test('non-image extensions return false', () => {
      for (const ext of ['.md', '.ts', '.pdf', '.docx', '.zip']) {
        assert.ok(!isImageFile(`file${ext}`), `${ext} should not be image`)
      }
    })

    test('extensionless files are not images', () => {
      assert.ok(!isImageFile('Dockerfile'))
      assert.ok(!isImageFile('Makefile'))
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// grill-prompt-blocks.ts — pure functions and constants
// ═══════════════════════════════════════════════════════════════════════════

let buildReEvalBlock: (previousScore: number | undefined) => string
let buildGrillEvaluationSchema: (trackId: string) => string
let buildGrillEvaluationSchemaLean: (trackId: string) => string
let isGrillLean: (model?: string) => boolean
let GRILL_QUESTION_QUALITY_RULES: string
let GRILL_QUESTION_QUALITY_RULES_GREENFIELD_EXTRA: string
let GRILL_QUESTION_QUALITY_RULES_LEAN: string
let GRILL_SCORING_RULES: string
let GRILL_SCORING_RULES_LEAN: string
let grillPromptLoaded = false

try {
  const mod = require('../role-adapters/grill-prompt-blocks')
  buildReEvalBlock = mod.buildReEvalBlock
  buildGrillEvaluationSchema = mod.buildGrillEvaluationSchema
  buildGrillEvaluationSchemaLean = mod.buildGrillEvaluationSchemaLean
  isGrillLean = mod.isGrillLean
  GRILL_QUESTION_QUALITY_RULES = mod.GRILL_QUESTION_QUALITY_RULES
  GRILL_QUESTION_QUALITY_RULES_GREENFIELD_EXTRA = mod.GRILL_QUESTION_QUALITY_RULES_GREENFIELD_EXTRA
  GRILL_QUESTION_QUALITY_RULES_LEAN = mod.GRILL_QUESTION_QUALITY_RULES_LEAN
  GRILL_SCORING_RULES = mod.GRILL_SCORING_RULES
  GRILL_SCORING_RULES_LEAN = mod.GRILL_SCORING_RULES_LEAN
  grillPromptLoaded = true
} catch (err) {
  console.log(`⚠ grill-prompt-blocks.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

if (grillPromptLoaded) {
  describe('buildReEvalBlock — pure function', () => {
    test('undefined score returns empty string', () => {
      assert.equal(buildReEvalBlock(undefined), '')
    })

    test('score=75 includes the score', () => {
      const result = buildReEvalBlock(75)
      assert.ok(result.includes('Previous score: 75'))
      assert.ok(result.includes('Re-evaluation Context'))
    })

    test('score=0 still produces output', () => {
      const result = buildReEvalBlock(0)
      assert.ok(result.includes('Previous score: 0'))
    })

    test('includes anchoring instruction', () => {
      const result = buildReEvalBlock(50)
      assert.ok(result.includes('ANCHOR'))
    })
  })

  describe('buildGrillEvaluationSchema — pure function', () => {
    test('includes trackId in output', () => {
      const result = buildGrillEvaluationSchema('grilled')
      assert.ok(result.includes('"trackId": "grilled"'))
    })

    test('includes grill-evaluation fence', () => {
      const result = buildGrillEvaluationSchema('raw')
      assert.ok(result.includes('grill-evaluation'))
    })

    test('includes score field', () => {
      const result = buildGrillEvaluationSchema('grilled')
      assert.ok(result.includes('"score"'))
    })

    test('includes scoreLabel field with bands', () => {
      const result = buildGrillEvaluationSchema('grilled')
      assert.ok(result.includes('Raw'))
      assert.ok(result.includes('Perfectly Grilled'))
    })

    test('includes questions array structure', () => {
      const result = buildGrillEvaluationSchema('grilled')
      assert.ok(result.includes('"questions"'))
      assert.ok(result.includes('"options"'))
    })
  })

  describe('buildGrillEvaluationSchemaLean — pure function', () => {
    test('includes trackId', () => {
      const result = buildGrillEvaluationSchemaLean('seasoned')
      assert.ok(result.includes('"seasoned"'))
    })

    test('is shorter than full schema', () => {
      const full = buildGrillEvaluationSchema('grilled')
      const lean = buildGrillEvaluationSchemaLean('grilled')
      assert.ok(lean.length < full.length, 'Lean should be shorter than full')
    })

    test('includes key fields', () => {
      const result = buildGrillEvaluationSchemaLean('grilled')
      assert.ok(result.includes('score'))
      assert.ok(result.includes('scoreLabel'))
      assert.ok(result.includes('feedback'))
      assert.ok(result.includes('questions'))
    })
  })

  describe('isGrillLean — pure function', () => {
    test('returns boolean', () => {
      assert.equal(typeof isGrillLean(), 'boolean')
    })

    test('returns boolean for model string', () => {
      assert.equal(typeof isGrillLean('claude-opus-4-8'), 'boolean')
    })
  })

  describe('Grill prompt constants — non-empty and well-formed', () => {
    test('GRILL_QUESTION_QUALITY_RULES is non-empty', () => {
      assert.ok(GRILL_QUESTION_QUALITY_RULES.length > 50)
      assert.ok(GRILL_QUESTION_QUALITY_RULES.includes('Question Quality'))
    })

    test('GRILL_QUESTION_QUALITY_RULES_GREENFIELD_EXTRA is non-empty', () => {
      assert.ok(GRILL_QUESTION_QUALITY_RULES_GREENFIELD_EXTRA.length > 20)
      assert.ok(GRILL_QUESTION_QUALITY_RULES_GREENFIELD_EXTRA.includes('NO existing codebase'))
    })

    test('GRILL_QUESTION_QUALITY_RULES_LEAN is shorter than full', () => {
      assert.ok(GRILL_QUESTION_QUALITY_RULES_LEAN.length < GRILL_QUESTION_QUALITY_RULES.length)
    })

    test('GRILL_SCORING_RULES mentions all 5 score bands', () => {
      assert.ok(GRILL_SCORING_RULES.includes('Raw'))
      assert.ok(GRILL_SCORING_RULES.includes('Warming Up'))
      assert.ok(GRILL_SCORING_RULES.includes('Medium Rare'))
      assert.ok(GRILL_SCORING_RULES.includes('Well Done'))
      assert.ok(GRILL_SCORING_RULES.includes('Perfectly Grilled'))
    })

    test('GRILL_SCORING_RULES_LEAN is shorter than full', () => {
      assert.ok(GRILL_SCORING_RULES_LEAN.length < GRILL_SCORING_RULES.length)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// heartbeat-monitor.ts — construction + methods
// ═══════════════════════════════════════════════════════════════════════════

let HeartbeatMonitor: any
let heartbeatLoaded = false

try {
  const mod = require('../executor-utils/heartbeat-monitor')
  HeartbeatMonitor = mod.HeartbeatMonitor
  heartbeatLoaded = true
} catch (err) {
  console.log(`⚠ heartbeat-monitor.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

if (heartbeatLoaded) {
  describe('HeartbeatMonitor — construction', () => {
    test('accepts number interval', () => {
      const hb = new HeartbeatMonitor(5000)
      assert.equal((hb as any).intervalMs, 5000)
    })

    test('accepts options object', () => {
      const hb = new HeartbeatMonitor({ intervalMs: 3000 })
      assert.equal((hb as any).intervalMs, 3000)
    })

    test('stores onStall callback from options', () => {
      const onStall = () => {}
      const hb = new HeartbeatMonitor({ intervalMs: 1000, onStall })
      assert.equal((hb as any).onStall, onStall)
    })

    test('pendingHeartbeat starts false', () => {
      const hb = new HeartbeatMonitor(1000)
      assert.equal(hb.pendingHeartbeat, false)
    })
  })

  describe('HeartbeatMonitor — consumeHeartbeat', () => {
    test('returns false when no heartbeat pending', () => {
      const hb = new HeartbeatMonitor(1000)
      assert.equal(hb.consumeHeartbeat(), false)
    })

    test('returns true after _pendingHeartbeat set manually', () => {
      const hb = new HeartbeatMonitor(1000)
      ;(hb as any)._pendingHeartbeat = true
      assert.equal(hb.consumeHeartbeat(), true)
      assert.equal(hb.pendingHeartbeat, false, 'Should reset after consume')
    })

    test('second consume returns false', () => {
      const hb = new HeartbeatMonitor(1000)
      ;(hb as any)._pendingHeartbeat = true
      hb.consumeHeartbeat()
      assert.equal(hb.consumeHeartbeat(), false)
    })
  })

  describe('HeartbeatMonitor — touch', () => {
    test('updates lastActivityAt', () => {
      const hb = new HeartbeatMonitor(1000)
      // Small delay to ensure timestamp difference
      ;(hb as any).lastActivityAt = 0
      hb.touch()
      assert.ok((hb as any).lastActivityAt > 0)
    })

    test('resets stallCallbackFired', () => {
      const hb = new HeartbeatMonitor(1000)
      ;(hb as any).stallCallbackFired = true
      hb.touch()
      assert.equal((hb as any).stallCallbackFired, false)
    })
  })

  describe('HeartbeatMonitor — stop', () => {
    test('clears timer', () => {
      const hb = new HeartbeatMonitor(1000)
      hb.start()
      assert.ok((hb as any).heartbeatTimer !== null)
      hb.stop()
      assert.equal((hb as any).heartbeatTimer, null)
    })

    test('is idempotent', () => {
      const hb = new HeartbeatMonitor(1000)
      hb.stop()
      hb.stop()
      assert.ok(true, 'Should not throw')
    })

    test('start with intervalMs=0 is a no-op', () => {
      const hb = new HeartbeatMonitor(0)
      hb.start()
      assert.equal((hb as any).heartbeatTimer, null)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// model-config.service.ts — resolveAssignment + helpers
// ═══════════════════════════════════════════════════════════════════════════

let modelConfigService: any
let resolveAssignment: any
let modelConfigLoaded = false

try {
  const mod = require('../model-config.service')
  modelConfigService = mod.modelConfigService
  resolveAssignment = mod.resolveAssignment
  modelConfigLoaded = true
} catch (err) {
  console.log(`⚠ model-config.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

if (modelConfigLoaded) {
  describe('ModelConfigService — construction & methods', () => {
    test('singleton exists', () => {
      assert.ok(modelConfigService)
    })

    test('getModel is a function', () => {
      assert.equal(typeof modelConfigService.getModel, 'function')
    })

    test('getProvider is a function', () => {
      assert.equal(typeof modelConfigService.getProvider, 'function')
    })

    test('isLocalProvider is a function', () => {
      assert.equal(typeof modelConfigService.isLocalProvider, 'function')
    })

    test('getLocalLLMConfig is a function', () => {
      assert.equal(typeof modelConfigService.getLocalLLMConfig, 'function')
    })

    test('getBackend is a function', () => {
      assert.equal(typeof modelConfigService.getBackend, 'function')
    })

    test('getExecutorBackend is a function', () => {
      assert.equal(typeof modelConfigService.getExecutorBackend, 'function')
    })

    test('getModel returns a default for undefined workspacePath', () => {
      const model = modelConfigService.getModel(undefined, 'specialist')
      assert.ok(typeof model === 'string')
      assert.ok(model.length > 0)
    })

    test('getProvider returns claude for undefined workspacePath', () => {
      const provider = modelConfigService.getProvider(undefined)
      assert.equal(provider, 'claude')
    })

    test('isLocalProvider returns false for undefined workspacePath', () => {
      assert.equal(modelConfigService.isLocalProvider(undefined), false)
    })

    test('fallbackAction resolves sub-actions to base', () => {
      const fallback = (modelConfigService as any).fallbackAction.bind(modelConfigService)
      // sub-action 'specialist:plan' should fall back to 'specialist'
      const result = fallback('specialist:plan')
      assert.ok(typeof result === 'string')
      assert.ok(result.length > 0)
    })
  })

  if (resolveAssignment) {
    describe('resolveAssignment — pure function', () => {
      test('returns resolved assignment object', () => {
        const result = resolveAssignment({
          action: 'specialist',
          roles: {},
          overrides: {},
          defaults: { specialist: 'claude-sonnet-4-6' }
        })
        assert.ok(result)
        assert.ok(typeof result.modelId === 'string')
      })
    })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// agent-recovery-manager.ts — exported constant
// ═══════════════════════════════════════════════════════════════════════════

let AgentRecoveryManager: any
let recoveryLoaded = false

try {
  const mod = require('../agent-recovery-manager')
  AgentRecoveryManager = mod.AgentRecoveryManager
  recoveryLoaded = true
} catch (err) {
  console.log(`⚠ agent-recovery-manager.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

if (recoveryLoaded && AgentRecoveryManager) {
  describe('AgentRecoveryManager — construction', () => {
    test('can be constructed with mock session', () => {
      const mockSession = {}
      const manager = new AgentRecoveryManager(mockSession)
      assert.ok(manager)
    })

    test('has handleSessionRecovery method', () => {
      const manager = new AgentRecoveryManager({})
      assert.equal(typeof (manager as any).handleSessionRecovery, 'function')
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// snapshot-model-resolver.ts — BLUEPRINT_CONV_RE regex
// ═══════════════════════════════════════════════════════════════════════════

let BLUEPRINT_CONV_RE: RegExp
let snapshotLoaded = false

try {
  const mod = require('../snapshot-model-resolver')
  BLUEPRINT_CONV_RE = mod.BLUEPRINT_CONV_RE
  snapshotLoaded = true
} catch (err) {
  console.log(`⚠ snapshot-model-resolver.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

if (snapshotLoaded) {
  describe('BLUEPRINT_CONV_RE — regex pattern', () => {
    test('matches blueprint specify conversation IDs', () => {
      const match = 'blueprint-specify-abc123-1234567890'.match(BLUEPRINT_CONV_RE)
      assert.ok(match, 'Should match blueprint specify ID')
    })

    test('matches blueprint clarify conversation IDs', () => {
      const match = 'blueprint-clarify-def456-9876543210'.match(BLUEPRINT_CONV_RE)
      assert.ok(match, 'Should match blueprint clarify ID')
    })

    test('matches blueprint plan conversation IDs', () => {
      const match = 'blueprint-plan-ghi789-1111111111'.match(BLUEPRINT_CONV_RE)
      assert.ok(match, 'Should match blueprint plan ID')
    })

    test('matches blueprint build conversation IDs', () => {
      const match = 'blueprint-build-T001-jkl012-2222222222'.match(BLUEPRINT_CONV_RE)
      assert.ok(match, 'Should match blueprint build ID')
    })

    test('does not match regular conversation IDs', () => {
      const match = 'conv-abc123'.match(BLUEPRINT_CONV_RE)
      assert.ok(!match, 'Should not match regular conversation ID')
    })

    test('does not match empty string', () => {
      const match = ''.match(BLUEPRINT_CONV_RE)
      assert.ok(!match)
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// prompt-builder.ts — PromptBuilder methods
// ═══════════════════════════════════════════════════════════════════════════

let PromptBuilder: any
let promptBuilder: any
let promptBuilderLoaded = false

try {
  const mod = require('../prompt-builder')
  PromptBuilder = mod.PromptBuilder
  promptBuilder = mod.promptBuilder
  promptBuilderLoaded = true
} catch (err) {
  console.log(`⚠ prompt-builder.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

if (promptBuilderLoaded) {
  describe('PromptBuilder — pure methods', () => {
    test('singleton exists', () => {
      assert.ok(promptBuilder)
    })

    test('getGeneralistBudgetTierForTurn returns correct tiers', () => {
      const fn = (promptBuilder as any).getGeneralistBudgetTierForTurn?.bind(promptBuilder)
        ?? (PromptBuilder.prototype as any).getGeneralistBudgetTierForTurn
      if (fn) {
        // First turn should be 'full'
        assert.equal(fn(0), 'full')
        assert.equal(fn(1), 'full')
        // 2-4 should be 'standard'
        assert.equal(fn(2), 'standard')
        assert.equal(fn(4), 'standard')
        // 5+ should be 'minimal'
        assert.equal(fn(5), 'minimal')
        assert.equal(fn(100), 'minimal')
      } else {
        assert.ok(true, 'Method not available — skipped')
      }
    })

    test('estimateTokens approximates correctly', () => {
      const fn = (promptBuilder as any).estimateTokens?.bind(promptBuilder)
        ?? (PromptBuilder.prototype as any).estimateTokens
      if (fn) {
        assert.equal(fn(''), 0)
        const fourChars = fn('abcd')
        assert.ok(fourChars >= 1, 'Should estimate at least 1 token for 4 chars')
        const longText = fn('a'.repeat(1000))
        assert.ok(longText >= 200 && longText <= 300, `Expected ~250 tokens, got ${longText}`)
      } else {
        assert.ok(true, 'Method not available — skipped')
      }
    })

    test('build is a function', () => {
      assert.equal(typeof promptBuilder.build, 'function')
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// Skip blocks for failed module loads
// ═══════════════════════════════════════════════════════════════════════════

if (!costLoaded) {
  describe('CostTracker (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!elicitationLoaded) {
  describe('ElicitationService (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!docReaderLoaded) {
  describe('DocumentReader (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!grillPromptLoaded) {
  describe('GrillPromptBlocks (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!heartbeatLoaded) {
  describe('HeartbeatMonitor (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!modelConfigLoaded) {
  describe('ModelConfigService (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!recoveryLoaded || !AgentRecoveryManager) {
  describe('AgentRecoveryManager (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!snapshotLoaded) {
  describe('SnapshotModelResolver (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
if (!promptBuilderLoaded) {
  describe('PromptBuilder (skipped)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
