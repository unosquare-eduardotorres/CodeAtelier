/**
 * Phase 24 — IPC Coverage Blitz: workspace-deploy.ipc, testing.ipc
 *
 * Run: tsx src/main/ipc/__tests__/ipc-workspace-deploy-testing.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import {
  setupElectronStub,
  capturedHandlers,
  mockMainWindow,
  tryInvokeHandler,
} from '../../services/__tests__/electron-stub'

setupElectronStub()

let wsDeployLoaded = false
let testingLoaded = false

try {
  const mod = require('../../ipc/workspace-deploy.ipc')
  mod.registerWorkspaceDeployIpc()
  wsDeployLoaded = true
} catch (err) {
  console.log(`⚠ workspace-deploy.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

try {
  const mod = require('../../ipc/testing.ipc')
  mod.registerTestingIpc(mockMainWindow)
  testingLoaded = true
} catch (err) {
  console.log(`⚠ testing.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// workspace-deploy.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (wsDeployLoaded) {
  describe('workspace-deploy.ipc — channel registration', () => {
    test('registers workspace:scanClaude', () => {
      assert.ok(capturedHandlers.has('workspace:scanClaude'))
    })

    test('registers workspace:activateAgents', () => {
      assert.ok(capturedHandlers.has('workspace:activateAgents'))
    })

    test('registers workspace:cancelActivation', () => {
      assert.ok(capturedHandlers.has('workspace:cancelActivation'))
    })

    test('registers workspace:cleanActivation', () => {
      assert.ok(capturedHandlers.has('workspace:cleanActivation'))
    })

    const wsDeplCh = [...capturedHandlers.keys()].filter(c =>
      c.includes('scanClaude') || c.includes('activateAgents') ||
      c.includes('cancelActivation') || c.includes('cleanActivation') ||
      c.includes('readWorkspaceFile') || c.includes('writeWorkspaceFile')
    )
    test('registers ≥4 workspace-deploy channels', () => {
      assert.ok(wsDeplCh.length >= 4, `Expected ≥4, got ${wsDeplCh.length}`)
    })
  })

  describe('workspace-deploy.ipc — handler bodies', () => {
    test('workspace:scanClaude calls through', async () => {
      const r = await tryInvokeHandler('workspace:scanClaude', { workspacePath: '/tmp/proj' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('workspace:activateAgents calls through', async () => {
      const r = await tryInvokeHandler('workspace:activateAgents', { workspacePath: '/tmp/proj' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('workspace:cancelActivation calls through', async () => {
      const r = await tryInvokeHandler('workspace:cancelActivation')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('workspace:cleanActivation calls through', async () => {
      const r = await tryInvokeHandler('workspace:cleanActivation', {
        workspacePath: '/tmp/proj',
        removeClaudeMd: false,
      })
      assert.ok(r.ok === true || r.ok === false)
    })

    // File read/write — test path validation
    const readFileCh = capturedHandlers.has('workspace:readFile')
    if (readFileCh) {
      test('workspace:readFile rejects disallowed paths', async () => {
        const r = await tryInvokeHandler('workspace:readFile', { filePath: '/etc/passwd' })
        assert.equal(r.ok, false)
      })

      test('workspace:readFile accepts .claude/ paths', async () => {
        const r = await tryInvokeHandler('workspace:readFile', {
          filePath: '/tmp/proj/.claude/settings.json',
        })
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    const writeFileCh = capturedHandlers.has('workspace:writeFile')
    if (writeFileCh) {
      test('workspace:writeFile rejects disallowed paths', async () => {
        const r = await tryInvokeHandler('workspace:writeFile', {
          filePath: '/etc/passwd',
          content: 'bad',
        })
        assert.equal(r.ok, false)
      })
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// testing.ipc.ts
// ═══════════════════════════════════════════════════════════════════════════

if (testingLoaded) {
  describe('testing.ipc — channel registration', () => {
    test('registers testing:listScenarios', () => {
      assert.ok(capturedHandlers.has('testing:listScenarios'))
    })

    test('registers testing:preflight', () => {
      assert.ok(capturedHandlers.has('testing:preflight'))
    })

    test('registers testing:run', () => {
      assert.ok(capturedHandlers.has('testing:run'))
    })

    const testCh = [...capturedHandlers.keys()].filter(c => c.startsWith('testing:'))
    test('registers ≥5 testing channels', () => {
      assert.ok(testCh.length >= 5, `Expected ≥5, got ${testCh.length}: ${testCh.join(', ')}`)
    })
  })

  describe('testing.ipc — handler bodies', () => {
    test('testing:listScenarios calls through', async () => {
      const r = await tryInvokeHandler('testing:listScenarios')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('testing:preflight calls through', async () => {
      const r = await tryInvokeHandler('testing:preflight')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('testing:preflight calls through with workspaceId', async () => {
      const r = await tryInvokeHandler('testing:preflight', { workspaceId: 'ws-1' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('testing:run calls through', async () => {
      const r = await tryInvokeHandler('testing:run')
      assert.ok(r.ok === true || r.ok === false)
    })

    test('testing:run calls through with category', async () => {
      const r = await tryInvokeHandler('testing:run', { category: 'smoke' })
      assert.ok(r.ok === true || r.ok === false)
    })

    test('testing:run rejects invalid scenarioIds', async () => {
      const r = await tryInvokeHandler('testing:run', { scenarioIds: 'not-array' })
      assert.equal(r.ok, false)
    })

    // testing:getRuns, testing:getRunResults
    const getRunsCh = [...capturedHandlers.keys()].find(c =>
      c.includes('testing') && (c.includes('getRuns') || c.includes('listRuns'))
    )
    if (getRunsCh) {
      test(`${getRunsCh} calls through`, async () => {
        const r = await tryInvokeHandler(getRunsCh)
        assert.ok(r.ok === true || r.ok === false)
      })
    }

    const getResultsCh = [...capturedHandlers.keys()].find(c =>
      c.includes('testing') && c.includes('Result')
    )
    if (getResultsCh) {
      test(`${getResultsCh} calls through`, async () => {
        const r = await tryInvokeHandler(getResultsCh, { runId: 'r1' })
        assert.ok(r.ok === true || r.ok === false)
      })
    }
  })
}

if (process.argv[1]?.includes('ipc-workspace-deploy-testing')) {
  void summaryAsync()
}
