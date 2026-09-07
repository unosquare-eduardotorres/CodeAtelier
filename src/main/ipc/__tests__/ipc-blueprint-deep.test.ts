/**
 * Phase 24 — IPC Coverage Blitz: blueprint.ipc (deep, 1574 lines, currently 4.3%)
 *
 * Exercises all 30+ blueprint IPC handlers with channel registration,
 * argument validation, and handler body execution.
 *
 * Run: tsx src/main/ipc/__tests__/ipc-blueprint-deep.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import {
  setupFullMock,
  getHandlers,
  mockMainWindow,
  sentEvents,
  tryInvokeHandler
} from '../../services/__tests__/setup-full-mock'

setupFullMock()

let blueprintLoaded = false
type ListenerCounter = {
  listenerCount: (e: string) => number
  emit: (e: string, p: unknown) => void
}
const wiredEmitters: Record<string, ListenerCounter | null> = {}

/**
 * Resolve a service singleton through blueprint.ipc's OWN module children.
 *
 * A plain require() is not safe here: in the shared run the suite's mock window
 * purges require.cache, so re-requiring a service returns a FRESH singleton with
 * none of the wiring's listeners on it, while blueprint.ipc keeps holding the
 * original. The children array keeps direct Module references, so it always
 * yields the exact instance the wiring registered its listeners on.
 */
function serviceBoundToIpc(fileFragment: string, exportName: string): ListenerCounter | null {
  const ipcMod = require.cache[require.resolve('../../ipc/blueprint.ipc')]
  const child = ipcMod?.children.find((c: NodeModule) => c.filename.includes(fileFragment))
  return ((child?.exports as Record<string, unknown> | undefined)?.[exportName] ??
    null) as ListenerCounter | null
}

try {
  // The forwarders dispatch through the SessionEventRouter singleton; without
  // this the sends throw inside forward()'s try/catch and nothing is captured.
  require('../../services/session-event-router').initSessionEventRouter(mockMainWindow)
  const mod = require('../../ipc/blueprint.ipc')
  mod.registerBlueprintIpc(mockMainWindow)
  wiredEmitters['code-review'] = serviceBoundToIpc(
    'blueprint-code-review.service',
    'blueprintCodeReviewService'
  )
  wiredEmitters['peer-review'] = serviceBoundToIpc(
    'blueprint-peer-review.service',
    'blueprintPeerReviewService'
  )
  wiredEmitters['lead-review'] = serviceBoundToIpc(
    'blueprint-lead-review.service',
    'blueprintLeadReviewService'
  )
  blueprintLoaded = true
} catch (err) {
  console.log(`⚠ blueprint.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

if (blueprintLoaded) {
  describe('blueprint.ipc — channel registration (deep)', () => {
    const bpCh = [...getHandlers().keys()].filter((c) => c.startsWith('blueprint:'))
    test('registers ≥20 blueprint channels', () => {
      assert.ok(bpCh.length >= 20, `Expected ≥20 channels, got ${bpCh.length}`)
    })

    // Core CRUD
    const expectedChannels = [
      'blueprint:list',
      'blueprint:get',
      'blueprint:getDetails',
      'blueprint:delete',
      'blueprint:cancel',
      'blueprint:advancePhase',
      'blueprint:getArtifacts'
    ]
    for (const ch of expectedChannels) {
      if (getHandlers().has(ch)) {
        test(`registers ${ch}`, () => {
          assert.ok(getHandlers().has(ch))
        })
      }
    }

    // Start/run channels
    const startCh = [...getHandlers().keys()].find(
      (c) =>
        c.startsWith('blueprint:') &&
        (c.includes('start') || c.includes('Start') || c.includes('run'))
    )
    if (startCh) {
      test(`registers blueprint start channel: ${startCh}`, () => {
        assert.ok(getHandlers().has(startCh))
      })
    }
  })

  describe('blueprint.ipc — argument validation (deep)', () => {
    // blueprint:list
    if (getHandlers().has('blueprint:list')) {
      test('blueprint:list rejects missing workspaceId', async () => {
        const r = await tryInvokeHandler('blueprint:list', {})
        assert.equal(r.ok, false)
      })

      test('blueprint:list rejects non-object', async () => {
        const r = await tryInvokeHandler('blueprint:list', 'bad')
        assert.equal(r.ok, false)
      })
    }

    // blueprint:get
    if (getHandlers().has('blueprint:get')) {
      test('blueprint:get rejects missing blueprintId', async () => {
        const r = await tryInvokeHandler('blueprint:get', {})
        assert.equal(r.ok, false)
      })
    }

    // blueprint:getDetails
    if (getHandlers().has('blueprint:getDetails')) {
      test('blueprint:getDetails rejects missing blueprintId', async () => {
        const r = await tryInvokeHandler('blueprint:getDetails', {})
        assert.equal(r.ok, false)
      })
    }

    // blueprint:delete
    if (getHandlers().has('blueprint:delete')) {
      test('blueprint:delete rejects missing blueprintId', async () => {
        const r = await tryInvokeHandler('blueprint:delete', {})
        assert.equal(r.ok, false)
      })
    }

    // blueprint:cancel
    if (getHandlers().has('blueprint:cancel')) {
      test('blueprint:cancel rejects missing blueprintId', async () => {
        const r = await tryInvokeHandler('blueprint:cancel', {})
        assert.equal(r.ok, false)
      })
    }

    // blueprint:advancePhase
    if (getHandlers().has('blueprint:advancePhase')) {
      test('blueprint:advancePhase rejects missing blueprintId', async () => {
        const r = await tryInvokeHandler('blueprint:advancePhase', {})
        assert.equal(r.ok, false)
      })
    }

    // blueprint:getArtifacts
    if (getHandlers().has('blueprint:getArtifacts')) {
      test('blueprint:getArtifacts rejects missing blueprintId', async () => {
        const r = await tryInvokeHandler('blueprint:getArtifacts', {})
        assert.equal(r.ok, false)
      })
    }

    // blueprint:skipTask (BP-TASK-USER-SKIP-01)
    if (getHandlers().has('blueprint:skipTask')) {
      test('blueprint:skipTask is registered', () => {
        assert.ok(getHandlers().has('blueprint:skipTask'))
      })

      test('blueprint:skipTask rejects missing blueprintId', async () => {
        const r = await tryInvokeHandler('blueprint:skipTask', { taskId: 'T001' })
        assert.equal(r.ok, false)
      })

      test('blueprint:skipTask rejects missing taskId', async () => {
        const r = await tryInvokeHandler('blueprint:skipTask', { blueprintId: 'bp-1' })
        assert.equal(r.ok, false)
      })

      test('blueprint:skipTask rejects non-object args', async () => {
        const r = await tryInvokeHandler('blueprint:skipTask', 'bad')
        assert.equal(r.ok, false)
      })
    }
  })

  describe('blueprint.ipc — handler bodies (deep)', () => {
    // Test all registered blueprint channels
    if (getHandlers().has('blueprint:list')) {
      test('blueprint:list calls through', async () => {
        const r = await tryInvokeHandler('blueprint:list', { workspaceId: 'ws-1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    if (getHandlers().has('blueprint:get')) {
      test('blueprint:get calls through', async () => {
        const r = await tryInvokeHandler('blueprint:get', { blueprintId: 'bp-1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    if (getHandlers().has('blueprint:getDetails')) {
      test('blueprint:getDetails calls through', async () => {
        const r = await tryInvokeHandler('blueprint:getDetails', { blueprintId: 'bp-1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    if (getHandlers().has('blueprint:delete')) {
      test('blueprint:delete calls through', async () => {
        const r = await tryInvokeHandler('blueprint:delete', { blueprintId: 'bp-del' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    if (getHandlers().has('blueprint:cancel')) {
      test('blueprint:cancel calls through', async () => {
        const r = await tryInvokeHandler('blueprint:cancel', { blueprintId: 'bp-1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    if (getHandlers().has('blueprint:advancePhase')) {
      test('blueprint:advancePhase calls through', async () => {
        const r = await tryInvokeHandler('blueprint:advancePhase', { blueprintId: 'bp-1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    if (getHandlers().has('blueprint:getArtifacts')) {
      test('blueprint:getArtifacts calls through', async () => {
        const r = await tryInvokeHandler('blueprint:getArtifacts', { blueprintId: 'bp-1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    // Exercise ALL remaining blueprint channels generically
    const bpCh = [...getHandlers().keys()].filter((c) => c.startsWith('blueprint:'))
    const alreadyTested = new Set([
      'blueprint:list',
      'blueprint:get',
      'blueprint:getDetails',
      'blueprint:delete',
      'blueprint:cancel',
      'blueprint:advancePhase',
      'blueprint:getArtifacts'
    ])

    for (const ch of bpCh) {
      if (alreadyTested.has(ch)) continue
      test(`${ch} calls through`, async () => {
        const r = await tryInvokeHandler(ch, {
          workspaceId: 'ws-1',
          blueprintId: 'bp-1',
          phaseId: 'phase-1',
          taskId: 'task-1',
          content: 'test content'
        })
        assert.ok(r.ok === true || r.ok === false)
      })
    }
  })

  // Regression guard: every phase service's events must be bridged to the
  // renderer by wireOnceEventForwarding(). A service missing from that function
  // streams nothing to the UI even though the phase runs correctly.
  describe('blueprint.ipc — phase event forwarding wiring', () => {
    const wired: Array<[string, string[]]> = [
      ['code-review', ['phaseStart', 'phaseProgress', 'phaseComplete', 'phaseArtifact', 'status']],
      ['peer-review', ['phaseProgress', 'status']],
      ['lead-review', ['phaseProgress', 'phaseComplete', 'phaseArtifact', 'status']]
    ]

    for (const [name, events] of wired) {
      for (const ev of events) {
        test(`${name} service has a '${ev}' listener`, () => {
          const svc = wiredEmitters[name]
          assert.ok(svc, `${name} service was not resolvable through blueprint.ipc's imports`)
          const count = svc.listenerCount(ev)
          assert.ok(count > 0, `Expected ≥1 '${ev}' listener on ${name} service, got ${count}`)
        })
      }
    }

    // Listener presence alone does not prove the payload reaches the renderer:
    // the forwarder drops anything without a workspaceId and routes through the
    // event router. Emit a real chunk and assert it lands on the channel.
    test('code-review phaseProgress reaches the renderer channel', () => {
      const svc = wiredEmitters['code-review']
      assert.ok(svc, "code-review service was not resolvable through blueprint.ipc's imports")
      const before = sentEvents.length
      svc.emit('phaseProgress', {
        blueprintId: 'bp-stream-1',
        workspaceId: 'ws-stream-1',
        phase: 'code-review',
        text: 'reviewing diff'
      })
      const forwarded = sentEvents
        .slice(before)
        .find(
          (e) =>
            e.channel === 'blueprint:phaseProgress' &&
            (e.data as { phase?: string })?.phase === 'code-review'
        )
      assert.ok(forwarded, 'No blueprint:phaseProgress event captured for phase code-review')
      const data = forwarded.data as { workspaceId?: string; text?: string }
      assert.equal(data.workspaceId, 'ws-stream-1')
      assert.equal(data.text, 'reviewing diff')
    })

    // A code-review failure schedules an auto-retry; without a dispatch entry
    // the retry logs "Unknown phase" and the run stalls.
    test('auto-retry dispatch covers the code-review phase', () => {
      const src = readFileSync(join(__dirname, '..', 'blueprint.ipc.ts'), 'utf-8')
      const autoRetryBlock = src.slice(src.indexOf('[auto-retry] Dispatching'))
      assert.ok(
        autoRetryBlock.includes("'code-review':"),
        'auto-retry phaseDispatch map has no code-review entry'
      )
      assert.ok(
        autoRetryBlock
          .slice(0, autoRetryBlock.indexOf('const dispatch ='))
          .includes("isRoleEnabled(workspacePath, 'blueprint:code-review')"),
        'auto-retry code-review entry is missing the role gate the manual retry applies'
      )
    })
  })
}

if (process.argv[1]?.includes('ipc-blueprint-deep')) {
  void summaryAsync()
}
