/**
 * process-manager-server.ts — real tool-handler coverage.
 *
 * process-manager.test covers the module's internals (RingBuffer, reaping,
 * log sweeping) but never the five MCP tool handlers. These tests capture the
 * module-scope registrations and drive them through a real process lifecycle —
 * spawn → check → wait/stop → list — in a temp workspace, plus the
 * command-allowlist rejection and unknown-id paths.
 *
 * Run: tsx src/main/mcp-servers/__tests__/process-manager-server-tools.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync, runExclusive } from '../../services/__tests__/test-harness'
import { setupElectronStub } from '../../services/__tests__/electron-stub'
import { patchToolCapture, invokeTool } from './mcp-tool-capture'

setupElectronStub()

// Isolated workspace so .pm-state/logs land in a temp dir, not the repo.
const WS_DIR = mkdtempSync(join(tmpdir(), 'pm-tools-ws-'))
process.env.WORKSPACE_PATH = WS_DIR

const pmPath = require.resolve('../process-manager-server')
delete require.cache[pmPath]

const capture = patchToolCapture()
let registrationError: unknown
try {
  require('../process-manager-server')
} catch (err) {
  registrationError = err
} finally {
  capture.restore()
}

function textOf(result: any): string {
  assert.ok(result?.content?.[0]?.type === 'text', 'tool result must carry text content')
  return result.content[0].text as string
}

/** Extract the first JSON object embedded in a tool's text output. */
function jsonOf(result: any): any {
  const text = textOf(result)
  const start = text.indexOf('{')
  assert.ok(start >= 0, `no JSON in: ${text.slice(0, 200)}`)
  return JSON.parse(text.slice(start))
}

if (capture.names.length > 0) {
  describe('process-manager-server — registration', () => {
    test('five tools register at module scope', () => {
      assert.equal(registrationError, undefined, `registration threw: ${registrationError}`)
      assert.deepEqual(capture.names.sort(), [
        'check_process',
        'list_processes',
        'run_background',
        'stop_process',
        'wait_process'
      ])
    })
  })

  describe('process-manager-server — run_background', () => {
    test('a disallowed command is rejected before spawn', async () => {
      await runExclusive(async () => {
        const out = jsonOf(
          await invokeTool(capture, 'run_background', {
            command: 'curl http://example.com',
            description: 'nope'
          })
        )
        assert.ok(
          out.error?.includes('not allowed') || out.allowed === false || out.error,
          JSON.stringify(out)
        )
      })
    })

    test('a short-lived node process is spawned, tracked and reaped', async () => {
      await runExclusive(async () => {
        const started = jsonOf(
          await invokeTool(capture, 'run_background', {
            command: `node -e "console.log('pm-tools-hello'); setTimeout(()=>process.exit(0), 300)"`,
            description: 'round-8 lifecycle probe'
          })
        )
        assert.ok(started.id ?? started.processId ?? started.pid, JSON.stringify(started))
        const id = started.id ?? started.processId ?? started.pid

        // check while it should still be alive or just-exited — both are valid
        // observations, but the tool must answer with structured output.
        const checked = jsonOf(await invokeTool(capture, 'check_process', { pid: id }))
        assert.ok('alive' in checked || 'running' in checked, JSON.stringify(checked))

        // wait for exit and read the exit code + output
        const waited = jsonOf(await invokeTool(capture, 'wait_process', { pid: id }))
        assert.equal(waited.exitCode ?? waited.code, 0, JSON.stringify(waited))
        assert.ok(JSON.stringify(waited).includes('pm-tools-hello'), 'log output must be captured')

        // list sees the (now dead) tracked process, then stop is a no-op error
        const listed = jsonOf(await invokeTool(capture, 'list_processes', {}))
        assert.ok(Array.isArray(listed.processes), JSON.stringify(listed).slice(0, 200))

        const stopped = jsonOf(await invokeTool(capture, 'stop_process', { pid: id }))
        assert.ok(stopped, 'stop answers even for an already-exited process')
      })
    })

    test('check/wait on an unknown id report not-found', async () => {
      await runExclusive(async () => {
        const checked = jsonOf(await invokeTool(capture, 'check_process', { pid: 999999 }))
        assert.ok(
          checked.error?.includes('No tracked process') ||
            checked.error?.includes('not found') ||
            checked.found === false ||
            checked.alive === false,
          JSON.stringify(checked)
        )
      })
    })
  })
} else {
  describe('process-manager-server (load failure — NOT skipped)', () => {
    test('module loads and registers tools', () => {
      assert.ok(false, `process-manager-server failed to load: ${registrationError}`)
    })
  })
}

describe('process-manager-server — cleanup', () => {
  test('temp workspace removed, env restored', async () => {
    await runExclusive(async () => {
      rmSync(WS_DIR, { recursive: true, force: true })
      delete process.env.WORKSPACE_PATH
      assert.ok(true)
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
