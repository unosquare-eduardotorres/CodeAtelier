/**
 * Unit tests for hook-engine.service.ts — declarative lifecycle hook engine.
 *
 * Drives the exported `hookEngine` singleton through its real public API:
 *  - loadHooks() reads .agentstudio/hooks.json from a temp workspace.
 *  - executeHooks() filters by event + condition, interpolates ${VAR}, and
 *    runs blocking hooks via deterministic shell builtins (echo / exit).
 *
 * NOTE: the harness runs async tests inside a describe() concurrently, and this
 * suite mutates the singleton's private state + a shared temp workspace. To keep
 * it deterministic, every scenario is consolidated into a single sequential
 * async test (mirrors omlx-embedding.test.ts).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { hookEngine, type HookDefinition } from '../hook-engine.service'

function makeWorkspace(hooks?: HookDefinition[] | string): string {
  const ws = mkdtempSync(join(tmpdir(), 'hook-engine-'))
  if (hooks !== undefined) {
    const dir = join(ws, '.agentstudio')
    mkdirSync(dir, { recursive: true })
    const body = typeof hooks === 'string' ? hooks : JSON.stringify({ hooks })
    writeFileSync(join(dir, 'hooks.json'), body, 'utf-8')
  }
  return ws
}

describe('HookEngine', () => {
  test('loadHooks + executeHooks — full lifecycle (sequential)', async () => {
    const workspaces: string[] = []
    try {
      // ── loadHooks: missing file ──
      let ws = makeWorkspace()
      workspaces.push(ws)
      await hookEngine.loadHooks(ws)
      assert.deepEqual(hookEngine.getLoadedHooks(), [], 'no hooks file → empty')

      // ── loadHooks: valid file + getLoadedHooks copy semantics ──
      ws = makeWorkspace([
        { event: 'gate_passed', name: 'notify', command: 'echo hi', blocking: true }
      ])
      workspaces.push(ws)
      await hookEngine.loadHooks(ws)
      const loaded = hookEngine.getLoadedHooks()
      assert.equal(loaded.length, 1)
      assert.equal(loaded[0].name, 'notify')
      loaded.push({ event: 'gate_failed', name: 'x', command: 'echo', blocking: true })
      assert.equal(hookEngine.getLoadedHooks().length, 1, 'getLoadedHooks returns a copy')

      // ── loadHooks: malformed JSON → empty (caught) ──
      ws = makeWorkspace('{ not valid json')
      workspaces.push(ws)
      await hookEngine.loadHooks(ws)
      assert.deepEqual(hookEngine.getLoadedHooks(), [], 'malformed JSON → empty')

      // ── executeHooks: event filtering ──
      ws = makeWorkspace([{ event: 'gate_passed', name: 'a', command: 'echo', blocking: true }])
      workspaces.push(ws)
      await hookEngine.loadHooks(ws)
      assert.deepEqual(await hookEngine.executeHooks('gate_failed'), [], 'no event match → []')

      // ── executeHooks: condition.mode mismatch vs match ──
      ws = makeWorkspace([
        {
          event: 'gate_passed',
          name: 'build-only',
          command: 'echo ran',
          blocking: true,
          condition: { mode: 'build' }
        }
      ])
      workspaces.push(ws)
      await hookEngine.loadHooks(ws)
      assert.deepEqual(
        await hookEngine.executeHooks('gate_passed', { mode: 'plan' }),
        [],
        'mode mismatch skips'
      )
      const matched = await hookEngine.executeHooks('gate_passed', { mode: 'build' })
      assert.equal(matched.length, 1)
      assert.equal(matched[0].exitCode, 0, 'mode match runs')

      // ── executeHooks: ${VAR} interpolation (blocking, echo) ──
      ws = makeWorkspace([
        { event: 'gate_passed', name: 'echo-var', command: 'echo ${greeting}', blocking: true }
      ])
      workspaces.push(ws)
      await hookEngine.loadHooks(ws)
      const interp = await hookEngine.executeHooks('gate_passed', { greeting: 'hello-hook' })
      assert.equal(interp[0].exitCode, 0)
      assert.ok(interp[0].stdout.includes('hello-hook'), 'interpolated ${greeting}')

      // ── executeHooks: blocking failure → exitCode 1 + stderr ──
      ws = makeWorkspace([
        { event: 'gate_failed', name: 'boom', command: 'exit 3', blocking: true }
      ])
      workspaces.push(ws)
      await hookEngine.loadHooks(ws)
      const failed = await hookEngine.executeHooks('gate_failed')
      assert.equal(failed[0].exitCode, 1)
      assert.ok(failed[0].stderr.length > 0)

      // ── executeHooks: non-blocking fire-and-forget → exitCode null ──
      ws = makeWorkspace([{ event: 'post_merge', name: 'bg', command: 'true', blocking: false }])
      workspaces.push(ws)
      await hookEngine.loadHooks(ws)
      const bg = await hookEngine.executeHooks('post_merge')
      assert.equal(bg[0].exitCode, null)
      assert.equal(bg[0].durationMs, 0)

      // ── executeHooks: lifecycle events (started + response) ──
      ws = makeWorkspace([
        { event: 'gate_passed', name: 'lc', command: 'echo done', blocking: true }
      ])
      workspaces.push(ws)
      await hookEngine.loadHooks(ws)
      const phases: string[] = []
      const listener = (e: { phase: string }): void => {
        phases.push(e.phase)
      }
      hookEngine.on('hookLifecycle', listener)
      await hookEngine.executeHooks('gate_passed')
      hookEngine.off('hookLifecycle', listener)
      assert.ok(phases.includes('started'))
      assert.ok(phases.includes('response'))
    } finally {
      for (const ws of workspaces) rmSync(ws, { recursive: true, force: true })
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
