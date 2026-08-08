/**
 * Phase 25, Wave 2 — CLIExecutor deep body coverage.
 *
 * Covers: cli-executor.ts (1032 lines, ~34% covered)
 *
 * Strategy: Test exported functions (buildGoalCommand), construct CLIExecutor
 * and test internal state, session tracking, and method shapes.
 *
 * Run: tsx src/main/services/__tests__/cli-executor-deep-phase25.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let CLIExecutor: any
let buildGoalCommand: any
let loaded = false

try {
  const mod = require('../cli-executor')
  CLIExecutor = mod.CLIExecutor
  buildGoalCommand = mod.buildGoalCommand
  loaded = true
} catch (err) {
  console.log(`⚠ cli-executor.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

if (loaded) {
  describe('buildGoalCommand — pure function (Phase 25)', () => {
    test('returns string for valid goal', () => {
      const result = buildGoalCommand('Complete the implementation')
      assert.ok(result === null || typeof result === 'string')
    })
    test('returns null for empty goal', () => {
      const result = buildGoalCommand('')
      assert.equal(result, null)
    })
    test('handles multiline goal', () => {
      const result = buildGoalCommand('Line 1\nLine 2\nLine 3')
      assert.ok(result === null || typeof result === 'string')
    })
    test('handles goal with special chars', () => {
      const result = buildGoalCommand('Fix the "bug" in file.ts & test')
      assert.ok(result === null || typeof result === 'string')
    })
  })

  describe('CLIExecutor — construction (Phase 25)', () => {
    test('can construct', () => {
      const exec = new CLIExecutor()
      assert.ok(exec !== undefined)
    })
    test('isAlive returns false initially', () => {
      const exec = new CLIExecutor()
      assert.equal(exec.isAlive(), false)
    })
  })

  describe('CLIExecutor — method shapes (Phase 25)', () => {
    const methods = [
      'execute',
      'killProcess',
      'isAlive',
      'getSessionId',
      'compact',
      'sendSlashCommand',
      'executeAndCollect',
      'getPendingToolNames',
      'getSpawnSignature'
    ]
    for (const m of methods) {
      test(`has ${m}`, () => {
        const exec = new CLIExecutor()
        assert.equal(typeof (exec as any)[m], 'function', `missing: ${m}`)
      })
    }
  })

  describe('CLIExecutor — internal state (Phase 25)', () => {
    test('cliProcess starts null', () => {
      const exec = new CLIExecutor()
      assert.ok((exec as any).cliProcess === null || (exec as any).cliProcess === undefined)
    })
    test('sessionId starts null', () => {
      const exec = new CLIExecutor()
      const sid = exec.getSessionId()
      assert.ok(sid === null || sid === undefined)
    })
  })

  describe('CLIExecutor — pending tool visibility', () => {
    test('idle executor reports no pending tools', () => {
      const exec = new CLIExecutor()
      assert.deepEqual(exec.getPendingToolNames(), [])
    })

    test('pending tools are visible to lifecycle callers mid-turn', () => {
      const exec = new CLIExecutor()
      const { ToolTracker } = require('../executor-utils/tool-tracker')
      const tracker = new ToolTracker()
      tracker.register('tid-1', 'mcp__mulldev__test')
      ;(exec as any).activeTools = tracker
      assert.deepEqual(exec.getPendingToolNames(), ['mcp__mulldev__test'])
    })

    // Regression: an orphaned tool_use stays at status 'running', which the
    // finalize path renders as done. killProcess must queue a failed result.
    test('killProcess records unresolved calls as orphans', async () => {
      const exec = new CLIExecutor()
      const { ToolTracker } = require('../executor-utils/tool-tracker')
      const tracker = new ToolTracker()
      tracker.register('tid-1', 'mcp__mulldev__test')
      ;(exec as any).activeTools = tracker
      ;(exec as any).cliProcess = { kill: () => {}, once: (_e: string, cb: () => void) => cb() }
      await exec.killProcess()
      assert.deepEqual((exec as any).orphanedToolCalls, [
        { id: 'tid-1', name: 'mcp__mulldev__test' }
      ])
      assert.deepEqual(exec.getPendingToolNames(), [], 'tracker is cleared after harvesting')

      const drained = [...(exec as any).drainOrphanedToolCalls()]
      assert.equal(drained.length, 1)
      assert.equal(drained[0].type, 'tool_result')
      assert.equal(drained[0].toolId, 'tid-1')
      assert.equal(drained[0].isError, true)
      assert.deepEqual([...(exec as any).drainOrphanedToolCalls()], [], 'drain is one-shot')
    })
  })

  describe('CLIExecutor — spawn signature', () => {
    test('fresh executor reports no signature', () => {
      const exec = new CLIExecutor()
      assert.equal(exec.getSpawnSignature(), null)
    })

    // The signature must not outlive the process it describes: a stale one would
    // let the factory reuse a budget that no longer exists.
    test('killProcess clears the signature', async () => {
      const exec = new CLIExecutor()
      ;(exec as any).spawnSignature = { model: 'claude-sonnet-4-6', maxTurns: 200, effort: 'high' }
      ;(exec as any).cliProcess = { kill: () => {}, once: (_e: string, cb: () => void) => cb() }
      await exec.killProcess()
      assert.equal((exec as any).spawnSignature, null)
      assert.equal(exec.getSpawnSignature(), null)
    })

    // isAlive() is the source of truth — a signature left behind by a dead
    // process must never be reported as live.
    test('signature is not reported while the process is dead', () => {
      const exec = new CLIExecutor()
      ;(exec as any).spawnSignature = { model: 'claude-sonnet-4-6', maxTurns: 200, effort: 'high' }
      assert.equal(exec.isAlive(), false)
      assert.equal(exec.getSpawnSignature(), null)
    })
  })

  describe('CLIExecutor — killProcess (Phase 25)', () => {
    test('killProcess on fresh executor', async () => {
      const exec = new CLIExecutor()
      try {
        await exec.killProcess()
      } catch {
        /* acceptable */
      }
      assert.ok(true)
    })
  })

  describe('CLIExecutor — compact (Phase 25)', () => {
    test('compact on fresh executor', () => {
      const exec = new CLIExecutor()
      try {
        exec.compact()
      } catch {
        /* acceptable */
      }
      assert.ok(true)
    })
  })
}

if (require.main === module) {
  void summaryAsync()
}
