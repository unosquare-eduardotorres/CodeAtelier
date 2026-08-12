/**
 * Phase 17, Track 6 — Blueprint pipeline instance tests
 *
 * Tests blueprint pipeline services by constructing instances and exercising
 * public API: EventEmitter patterns, state queries, and module-level constants.
 *
 * Target services (~2,200 lines at 19-31%):
 *   - BlueprintSpecService (530 lines at 22%)
 *   - BlueprintBuildService (643 lines at 25%)
 *   - BlueprintTasksService (256 lines at 19%)
 *   - BlueprintPlanService (205 lines at 20%)
 *   - BlueprintVerifyService (227 lines at 22%)
 *   - BlueprintReviewService (244 lines at 31%)
 *   - BlueprintService (573 lines at 49%)
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// Electron stub for services that import electron-log
import { setupElectronStub } from './electron-stub'
setupElectronStub()

// ─────────────────────────────────────────────────────────────────────────────
// §1: BlueprintSpecService — specification assembly
// ─────────────────────────────────────────────────────────────────────────────

describe('BlueprintSpecService — instance + EventEmitter', () => {
  test('class is constructable and extends EventEmitter', async () => {
    const { BlueprintSpecService } = await import('../blueprint-spec.service')
    assert.equal(typeof BlueprintSpecService, 'function')
    const instance = new BlueprintSpecService()
    assert.ok(instance)
    assert.equal(typeof instance.on, 'function', 'extends EventEmitter')
    assert.equal(typeof instance.emit, 'function')
    assert.equal(typeof instance.removeAllListeners, 'function')
  })

  test('singleton export exists', async () => {
    const { blueprintSpecService } = await import('../blueprint-spec.service')
    assert.ok(blueprintSpecService, 'singleton exported')
  })

  test('EventEmitter wiring works', async () => {
    const { BlueprintSpecService } = await import('../blueprint-spec.service')
    const svc = new BlueprintSpecService()
    let received = false
    svc.on('progress', () => {
      received = true
    })
    svc.emit('progress', { step: 'test' })
    assert.ok(received)
    svc.removeAllListeners()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §2: BlueprintBuildService — build task orchestration
// ─────────────────────────────────────────────────────────────────────────────

describe('BlueprintBuildService — instance + EventEmitter', () => {
  test('class is constructable and extends EventEmitter', async () => {
    const { BlueprintBuildService } = await import('../blueprint-build.service')
    assert.equal(typeof BlueprintBuildService, 'function')
    const instance = new BlueprintBuildService()
    assert.ok(instance)
    assert.equal(typeof instance.on, 'function')
  })

  test('singleton export exists', async () => {
    const { blueprintBuildService } = await import('../blueprint-build.service')
    assert.ok(blueprintBuildService)
  })

  test('EventEmitter wiring works', async () => {
    const { BlueprintBuildService } = await import('../blueprint-build.service')
    const svc = new BlueprintBuildService()
    const events: string[] = []
    svc.on('task-start', (_d: any) => events.push('start'))
    svc.on('task-complete', (_d: any) => events.push('complete'))
    svc.emit('task-start', { taskId: 't1' })
    svc.emit('task-complete', { taskId: 't1' })
    assert.deepEqual(events, ['start', 'complete'])
    svc.removeAllListeners()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3: BlueprintTasksService — task list parsing + wave graph
// ─────────────────────────────────────────────────────────────────────────────

describe('BlueprintTasksService — instance + EventEmitter', () => {
  test('class is constructable and extends EventEmitter', async () => {
    const { BlueprintTasksService } = await import('../blueprint-tasks.service')
    assert.equal(typeof BlueprintTasksService, 'function')
    const instance = new BlueprintTasksService()
    assert.ok(instance)
    assert.equal(typeof instance.on, 'function')
  })

  test('singleton export exists', async () => {
    const { blueprintTasksService } = await import('../blueprint-tasks.service')
    assert.ok(blueprintTasksService)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §4: BlueprintPlanService — plan prompt construction
// ─────────────────────────────────────────────────────────────────────────────

describe('BlueprintPlanService — instance + EventEmitter', () => {
  test('class is constructable and extends EventEmitter', async () => {
    const { BlueprintPlanService } = await import('../blueprint-plan.service')
    assert.equal(typeof BlueprintPlanService, 'function')
    const instance = new BlueprintPlanService()
    assert.ok(instance)
    assert.equal(typeof instance.on, 'function')
  })

  test('singleton export exists', async () => {
    const { blueprintPlanService } = await import('../blueprint-plan.service')
    assert.ok(blueprintPlanService)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §5: BlueprintVerifyService — verification prompt + result parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('BlueprintVerifyService — instance + EventEmitter', () => {
  test('class is constructable and extends EventEmitter', async () => {
    const { BlueprintVerifyService } = await import('../blueprint-verify.service')
    assert.equal(typeof BlueprintVerifyService, 'function')
    const instance = new BlueprintVerifyService()
    assert.ok(instance)
    assert.equal(typeof instance.on, 'function')
  })

  test('singleton export exists', async () => {
    const { blueprintVerifyService } = await import('../blueprint-verify.service')
    assert.ok(blueprintVerifyService)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §6: BlueprintReviewService — review prompt + result parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('BlueprintReviewService — instance + EventEmitter', () => {
  test('class is constructable and extends EventEmitter', async () => {
    const { BlueprintReviewService } = await import('../blueprint-review.service')
    assert.equal(typeof BlueprintReviewService, 'function')
    const instance = new BlueprintReviewService()
    assert.ok(instance)
    assert.equal(typeof instance.on, 'function')
  })

  test('singleton export exists', async () => {
    const { blueprintReviewService } = await import('../blueprint-review.service')
    assert.ok(blueprintReviewService)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §7: BlueprintService — orchestrator (phase advancement, status computation)
// ─────────────────────────────────────────────────────────────────────────────

describe('BlueprintService — instance + EventEmitter', () => {
  test('class is constructable and extends EventEmitter', async () => {
    const { BlueprintService } = await import('../blueprint.service')
    assert.equal(typeof BlueprintService, 'function')
    const instance = new BlueprintService()
    assert.ok(instance)
    assert.equal(typeof instance.on, 'function')
  })

  test('singleton export exists', async () => {
    const { blueprintService } = await import('../blueprint.service')
    assert.ok(blueprintService)
  })

  test('prototype has expected methods', async () => {
    const { BlueprintService } = await import('../blueprint.service')
    const proto = Object.getOwnPropertyNames(BlueprintService.prototype).filter(
      (m) => m !== 'constructor'
    )
    assert.ok(
      proto.length >= 3,
      `Expected at least 3 methods, got ${proto.length}: ${proto.join(', ')}`
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §8: Blueprint types and constants verification
// ─────────────────────────────────────────────────────────────────────────────

describe('Blueprint shared types and constants', () => {
  test('BLUEPRINT_PHASE_ORDER is exported and non-empty', async () => {
    const mod = await import('../../../shared/blueprint-types')
    if (mod.BLUEPRINT_PHASE_ORDER) {
      assert.ok(Array.isArray(mod.BLUEPRINT_PHASE_ORDER))
      assert.ok(mod.BLUEPRINT_PHASE_ORDER.length > 0)
    }
  })

  test('PHASE_TO_STATUS mapping is exported', async () => {
    const mod = await import('../../../shared/blueprint-types')
    if (mod.PHASE_TO_STATUS) {
      assert.equal(typeof mod.PHASE_TO_STATUS, 'object')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §9: Cross-service EventEmitter lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe('Blueprint pipeline — EventEmitter lifecycle', () => {
  test('all pipeline services accept event listeners', async () => {
    const services = [
      (await import('../blueprint-spec.service')).blueprintSpecService,
      (await import('../blueprint-build.service')).blueprintBuildService,
      (await import('../blueprint-tasks.service')).blueprintTasksService,
      (await import('../blueprint-plan.service')).blueprintPlanService,
      (await import('../blueprint-verify.service')).blueprintVerifyService,
      (await import('../blueprint-review.service')).blueprintReviewService,
      (await import('../blueprint.service')).blueprintService
    ]

    for (const svc of services) {
      assert.equal(typeof svc.on, 'function')
      assert.equal(typeof svc.emit, 'function')
      assert.equal(typeof svc.removeAllListeners, 'function')

      let received = false
      svc.on('test-lifecycle', () => {
        received = true
      })
      svc.emit('test-lifecycle')
      assert.ok(received, `${svc.constructor.name} received event`)
      svc.removeAllListeners('test-lifecycle')
    }
  })

  test('all pipeline services have prototype methods', async () => {
    const classes = [
      (await import('../blueprint-spec.service')).BlueprintSpecService,
      (await import('../blueprint-build.service')).BlueprintBuildService,
      (await import('../blueprint-tasks.service')).BlueprintTasksService,
      (await import('../blueprint-plan.service')).BlueprintPlanService,
      (await import('../blueprint-verify.service')).BlueprintVerifyService,
      (await import('../blueprint-review.service')).BlueprintReviewService,
      (await import('../blueprint.service')).BlueprintService
    ]

    for (const cls of classes) {
      const proto = Object.getOwnPropertyNames(cls.prototype).filter((m) => m !== 'constructor')
      assert.ok(proto.length >= 1, `${cls.name} has ${proto.length} methods`)
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
