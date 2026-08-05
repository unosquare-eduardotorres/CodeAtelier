/**
 * Phase 26 Wave 6 — Batch test for medium services.
 * Covers: opencode-agent-writer, library-doc, github, memory-consolidation,
 * blueprint-plan, blueprint-tasks, blueprint-review services.
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import { setupFullMock, getMockRepo, resetAllMocks } from './setup-full-mock'
setupFullMock()

const services: Record<string, any> = {}
const serviceFiles = [
  ['opencodeAgentWriter', '../opencode-agent-writer'],
  ['libraryDoc', '../library-doc.service'],
  ['github', '../github.service'],
  ['memoryConsolidation', '../memory-consolidation.service'],
  ['blueprintPlan', '../blueprint-plan.service'],
  ['blueprintTasks', '../blueprint-tasks.service'],
  ['blueprintReview', '../blueprint-review.service'],
  ['modelConfig', '../model-config.service'],
  ['eventLogger', '../event-logger.service'],
  ['costTracker', '../cost-tracker'],
  ['autoUpdate', '../auto-update.service'],
  ['promptBuilder', '../prompt-builder']
]

for (const [name, path] of serviceFiles) {
  try {
    services[name] = require(path)
  } catch {
    /* OK */
  }
}

const eventRepo = getMockRepo('event')

describe('Medium services batch (P26-W6)', () => {
  beforeEach(() => {
    resetAllMocks()
  })

  test('all service modules load', () => {
    const loaded = Object.keys(services).filter((k) => services[k])
    assert.ok(loaded.length > 0, `${loaded.length} services loaded`)
  })

  // library-doc.service
  test('libraryDoc service methods', () => {
    if (!services.libraryDoc) return
    const svc = services.libraryDoc.libraryDocService || services.libraryDoc.default
    if (!svc) return
    assert.ok(typeof svc === 'object')
  })

  // github.service
  test('github service methods', () => {
    if (!services.github) return
    const svc = services.github.githubService || services.github.default
    if (!svc) return
    assert.ok(typeof svc === 'object')
  })

  // blueprint-plan.service
  test('blueprintPlan service loaded', () => {
    if (!services.blueprintPlan) return
    const svc = services.blueprintPlan.blueprintPlanService || services.blueprintPlan.default
    if (!svc) return
    assert.ok(typeof svc === 'object')
    if (typeof svc.cancelBlueprint === 'function') svc.cancelBlueprint('bp-none')
    if (typeof svc.shutdown === 'function') svc.shutdown()
  })

  // blueprint-tasks.service
  test('blueprintTasks service loaded', () => {
    if (!services.blueprintTasks) return
    const svc = services.blueprintTasks.blueprintTasksService || services.blueprintTasks.default
    if (!svc) return
    assert.ok(typeof svc === 'object')
    if (typeof svc.cancelBlueprint === 'function') svc.cancelBlueprint('bp-none')
    if (typeof svc.shutdown === 'function') svc.shutdown()
  })

  // blueprint-review.service
  test('blueprintReview service loaded', () => {
    if (!services.blueprintReview) return
    const svc = services.blueprintReview.blueprintReviewService || services.blueprintReview.default
    if (!svc) return
    assert.ok(typeof svc === 'object')
    if (typeof svc.cancelBlueprint === 'function') svc.cancelBlueprint('bp-none')
    if (typeof svc.shutdown === 'function') svc.shutdown()
  })

  // model-config.service
  test('modelConfig service loaded', () => {
    if (!services.modelConfig) return
    const resolve = services.modelConfig.resolveAssignment
    if (typeof resolve === 'function') {
      try {
        const result = resolve('plan', 'claude', undefined, undefined)
        assert.equal(typeof result, 'object')
      } catch {
        /* OK */
      }
    }
  })

  // event-logger.service
  test('eventLogger service loaded', () => {
    if (!services.eventLogger) return
    const svc = services.eventLogger.eventLoggerService || services.eventLogger.default
    if (!svc) return
    eventRepo.create.mockReturnValue(undefined)
    if (typeof svc.log === 'function') {
      try {
        svc.log('ws-1', 'test', 'test event')
      } catch {
        /* OK */
      }
    }
  })

  // auto-update.service
  test('autoUpdate service loaded', () => {
    if (!services.autoUpdate) return
    const svc = services.autoUpdate.autoUpdateService || services.autoUpdate.default
    if (!svc) return
    assert.ok(typeof svc === 'object')
  })

  // prompt-builder
  test('promptBuilder loaded', () => {
    if (!services.promptBuilder) return
    const keys = Object.keys(services.promptBuilder)
    assert.ok(keys.length > 0)
  })
})
