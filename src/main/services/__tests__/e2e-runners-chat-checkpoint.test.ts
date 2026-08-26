/**
 * Tier 1b (part 2) — chat-edge.runner, checkpoint.runner, workspace-ops.runner.
 *
 * Same recipe as e2e-service-runners-behavior.test.ts: pre-require the service,
 * patch the singleton method, drive both the success and failure branch, assert
 * on the transcript. Filesystem/git-backed runners get a REAL temp git repo
 * rather than a mock, so the fs and child_process paths execute for real.
 *
 * Run: tsx src/main/services/__tests__/e2e-runners-chat-checkpoint.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'

import { attachTestDb } from '../../db/repositories/__tests__/db-test-helper'
import { serial, tryRequire, makeCtx, statuses, errors, assistantText } from './e2e-runner-harness'

const dbContext = attachTestDb()

/** A real git repo with the fixture layout the workspace-ops runners expect. */
function makeGitFixture(): string | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-ws-ops-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'src', 'hello.ts'), 'export const VERSION = "1.0.0"\n', 'utf-8')
    writeFileSync(join(dir, 'docs', 'sample.md'), '# Sample\n\n```mermaid\ngraph TD;\nA-->B;\n```\n')
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'E2E',
      GIT_AUTHOR_EMAIL: 'e2e@test.local',
      GIT_COMMITTER_NAME: 'E2E',
      GIT_COMMITTER_EMAIL: 'e2e@test.local'
    }
    const run = (cmd: string): void => {
      execSync(cmd, { cwd: dir, stdio: 'pipe', env, windowsHide: true })
    }
    run('git init -q')
    run('git add .')
    run('git commit -q -m "initial"')
    return dir
  } catch {
    return null
  }
}

if (!dbContext) {
  describe('e2e-runners-chat-checkpoint (skipped — no DB)', () => {
    test('db_setup_unavailable', () => {
      /* better-sqlite3 unavailable — nothing to assert */
    })
  })
} else {
  const wsId = dbContext.wsId
  const ctx = (o = {}): ReturnType<typeof makeCtx> => makeCtx(wsId, o)

  const chatEdgeMod = tryRequire('../e2e-testing/service-runners/chat-edge.runner')
  const checkpointMod = tryRequire('../e2e-testing/service-runners/checkpoint.runner')
  const wsOpsMod = tryRequire('../e2e-testing/service-runners/workspace-ops.runner')
  // `chatStreamService` is a Proxy with only a `get` trap that forwards to a
  // lazily-built `_instance`. Defining a property on the Proxy lands on its
  // empty target and the trap never reads it, so the only patchable object is
  // the instance `initChatStream` returns — which the trap DOES forward to.
  const chatStreamMod = tryRequire('../chat-stream.service')
  const chatStream = chatStreamMod?.initChatStream(
    { isDestroyed: () => false, webContents: { send: () => {} } },
    { onStopPipeline: async () => {} }
  )
  const chatAgent = tryRequire('../chat-agent.service')?.chatAgentService
  const checkpoint = tryRequire('../checkpoint.service')?.checkpointService
  const repoSvc = tryRequire('../repo.service')?.repoService
  const costTracker = tryRequire('../cost-tracker.service')?.costTrackerService
  const repos = tryRequire('../../db/repositories')

  const okHandle = (onAbort?: () => void): { done: Promise<void>; abort: () => void } => ({
    done: Promise.resolve(),
    abort: () => onAbort?.()
  })

  // ── chat-edge.runner — runChatEdgeConcurrent ───────────────────────────────

  describe('chat-edge.runner — runChatEdgeConcurrent', () => {
    test(
      'records empty_rejected, second_stream_ok and second_stream_rejected',
      serial(async (p) => {
        let call = 0
        p.set(chatStream, 'stream', async () => {
          call++
          if (call === 1) throw new Error('prompt is empty')
          if (call === 3) throw new Error('stream already in progress')
          return okHandle()
        })
        const t = await chatEdgeMod.runChatEdgeConcurrent(
          ctx({ streamPrompt: async () => [assistantText('2')] })
        )
        const s = statuses(t)
        assert.ok(s.includes('empty_rejected'), s.join('|'))
        assert.ok(s.includes('second_stream_ok'))
        assert.ok(s.includes('second_stream_rejected'))
        assert.ok(s.includes('first_stream_ok'))
        assert.deepEqual(errors(t), [])
      })
    )

    test(
      'the whitespace-only probe is sent verbatim, not trimmed away',
      serial(async (p) => {
        const prompts: string[] = []
        p.set(chatStream, 'stream', async (_c: string, text: string) => {
          prompts.push(text)
          return okHandle()
        })
        await chatEdgeMod.runChatEdgeConcurrent(ctx({ streamPrompt: async () => [] }))
        assert.equal(prompts[0], '   ')
      })
    )

    test(
      'flags empty_accepted_unexpectedly when the whitespace prompt is accepted',
      serial(async (p) => {
        p.set(chatStream, 'stream', async () => okHandle())
        const t = await chatEdgeMod.runChatEdgeConcurrent(
          ctx({ streamPrompt: async () => [assistantText('hi')] })
        )
        const s = statuses(t)
        assert.ok(s.includes('empty_accepted_unexpectedly'))
        assert.ok(s.includes('second_stream_accepted_unexpectedly'))
      })
    )

    test(
      'records second_stream_no_response when the helper yields no assistant text',
      serial(async (p) => {
        p.set(chatStream, 'stream', async () => okHandle())
        const t = await chatEdgeMod.runChatEdgeConcurrent(ctx({ streamPrompt: async () => [] }))
        assert.ok(statuses(t).includes('second_stream_no_response'))
      })
    )

    test(
      'records second_stream_failed when the helper rejects',
      serial(async (p) => {
        p.set(chatStream, 'stream', async () => okHandle())
        const t = await chatEdgeMod.runChatEdgeConcurrent(
          ctx({
            streamPrompt: async () => {
              throw new Error('helper blew up')
            }
          })
        )
        assert.ok(statuses(t).some((s) => s === 'second_stream_failed: helper blew up'))
      })
    )

    test(
      'a first-stream rejection lands in concurrent_test_error, not the outer catch',
      serial(async (p) => {
        let call = 0
        p.set(chatStream, 'stream', async () => {
          call++
          // 1: empty probe, 2: (unused), 3: first concurrent stream
          if (call >= 3) throw new Error('backend down')
          return okHandle()
        })
        const t = await chatEdgeMod.runChatEdgeConcurrent(ctx({ streamPrompt: async () => [] }))
        const s = statuses(t)
        assert.ok(s.includes('second_stream_rejected') || s.includes('testing_concurrent'))
        assert.deepEqual(errors(t), [], 'inner failures must not reach the outer catch')
      })
    )
  })

  // ── chat-edge.runner — runChatEdgeRapidCancel ──────────────────────────────

  describe('chat-edge.runner — runChatEdgeRapidCancel', () => {
    test(
      'aborts and restarts three cycles and reports no zombie sessions',
      serial(async (p) => {
        let aborts = 0
        p.set(chatStream, 'stream', async () => okHandle(() => aborts++))
        const t = await chatEdgeMod.runChatEdgeRapidCancel(
          ctx({ streamPrompt: async () => [assistantText('4')] })
        )
        assert.equal(aborts, 3, 'every cycle must abort its handle')
        const s = statuses(t)
        assert.ok(s.includes('cycle_1_start'))
        assert.ok(s.includes('cycle_2_start'))
        assert.ok(s.includes('cycle_3_restart_ok'))
        assert.ok(s.includes('no_zombie_sessions'))
      })
    )

    test(
      'reports zombie_risk when restarts never produce a response',
      serial(async (p) => {
        p.set(chatStream, 'stream', async () => okHandle())
        const t = await chatEdgeMod.runChatEdgeRapidCancel(ctx({ streamPrompt: async () => [] }))
        const s = statuses(t)
        assert.ok(s.includes('cycle_1_restart_no_response'))
        assert.ok(s.includes('zombie_risk: 0/3'))
      })
    )

    test(
      'two of three successful restarts still count as healthy',
      serial(async (p) => {
        p.set(chatStream, 'stream', async () => okHandle())
        let n = 0
        const t = await chatEdgeMod.runChatEdgeRapidCancel(
          ctx({ streamPrompt: async () => (++n <= 2 ? [assistantText('ok')] : []) })
        )
        assert.ok(statuses(t).includes('no_zombie_sessions'))
      })
    )

    test(
      'a per-cycle stream failure is recorded and the loop continues',
      serial(async (p) => {
        p.set(chatStream, 'stream', async () => {
          throw new Error('no backend')
        })
        const t = await chatEdgeMod.runChatEdgeRapidCancel(ctx({ streamPrompt: async () => [] }))
        const s = statuses(t)
        assert.ok(s.includes('cycle_1_error: no backend'))
        assert.ok(s.includes('cycle_2_error: no backend'))
        assert.ok(s.includes('cycle_3_error: no backend'))
        assert.ok(s.includes('zombie_risk: 0/3'))
      })
    )

    test(
      'a restart rejection is recorded per cycle',
      serial(async (p) => {
        p.set(chatStream, 'stream', async () => okHandle())
        const t = await chatEdgeMod.runChatEdgeRapidCancel(
          ctx({
            streamPrompt: async () => {
              throw new Error('restart denied')
            }
          })
        )
        assert.ok(statuses(t).includes('cycle_1_restart_failed: restart denied'))
      })
    )
  })

  // ── chat-edge.runner — runChatEdgeCompactRace ──────────────────────────────

  describe('chat-edge.runner — runChatEdgeCompactRace', () => {
    test(
      'streams after compact and reports ok, awaiting the compact promise',
      serial(async (p) => {
        let compacted = 0
        p.set(chatAgent, 'compact', async () => {
          compacted++
        })
        const t = await chatEdgeMod.runChatEdgeCompactRace(
          ctx({ streamPrompt: async () => [assistantText('42')] })
        )
        assert.equal(compacted, 1)
        const s = statuses(t)
        assert.ok(s.includes('building_history'))
        assert.ok(s.includes('triggering_compact_race'))
        assert.ok(s.includes('stream_after_compact_ok'))
      })
    )

    test(
      'a rejecting compact is swallowed and does not fail the run',
      serial(async (p) => {
        p.set(chatAgent, 'compact', async () => {
          throw new Error('compact busy')
        })
        const t = await chatEdgeMod.runChatEdgeCompactRace(
          ctx({ streamPrompt: async () => [assistantText('42')] })
        )
        assert.deepEqual(errors(t), [])
        assert.ok(statuses(t).includes('stream_after_compact_ok'))
      })
    )

    test(
      'no assistant text yields the no_response branch',
      serial(async (p) => {
        p.set(chatAgent, 'compact', async () => undefined)
        const t = await chatEdgeMod.runChatEdgeCompactRace(ctx({ streamPrompt: async () => [] }))
        assert.ok(statuses(t).includes('stream_after_compact_no_response'))
      })
    )

    test(
      'a clean rejection during the race is accepted as compact_race_ok',
      serial(async (p) => {
        p.set(chatAgent, 'compact', async () => undefined)
        let call = 0
        const t = await chatEdgeMod.runChatEdgeCompactRace(
          ctx({
            streamPrompt: async () => {
              if (++call <= 2) return [assistantText('ack')]
              throw new Error('busy compacting')
            }
          })
        )
        assert.ok(statuses(t).includes('compact_race_ok: busy compacting'))
      })
    )

    test(
      'a failure while building history surfaces as an error entry',
      serial(async () => {
        const t = await chatEdgeMod.runChatEdgeCompactRace(
          ctx({
            streamPrompt: async () => {
              throw new Error('history build failed')
            }
          })
        )
        assert.deepEqual(errors(t), ['history build failed'])
      })
    )
  })

  // ── checkpoint.runner ──────────────────────────────────────────────────────

  describe('checkpoint.runner — runCheckpointCapture', () => {
    test(
      'reports checkpoint_captured when the service lists at least one',
      serial(async (p) => {
        p.set(checkpoint, 'listCheckpoints', () => [{ id: 'cp1', createdAt: 'now' }])
        const t = await checkpointMod.runCheckpointCapture(
          ctx({ streamPrompt: async () => [assistantText('edited')] })
        )
        assert.deepEqual(statuses(t), ['streaming_edit', 'checkpoint_captured'])
      })
    )

    test(
      'reports checkpoint_not_found on an empty list',
      serial(async (p) => {
        p.set(checkpoint, 'listCheckpoints', () => [])
        const t = await checkpointMod.runCheckpointCapture(ctx())
        assert.ok(statuses(t).includes('checkpoint_not_found'))
      })
    )

    test(
      'the streamed edit transcript is spliced into the result',
      serial(async (p) => {
        p.set(checkpoint, 'listCheckpoints', () => [{ id: 'cp1' }])
        const t = await checkpointMod.runCheckpointCapture(
          ctx({ streamPrompt: async () => [assistantText('done editing')] })
        )
        assert.ok(t.some((e: any) => e.type === 'text' && e.content === 'done editing'))
      })
    )

    test(
      'checkpoints are looked up by the context conversation id',
      serial(async (p) => {
        const seen: string[] = []
        p.set(checkpoint, 'listCheckpoints', (id: string) => {
          seen.push(id)
          return []
        })
        const c = ctx()
        await checkpointMod.runCheckpointCapture(c)
        assert.deepEqual(seen, [c.conversationId])
      })
    )

    test(
      'a throwing listCheckpoints becomes an error entry',
      serial(async (p) => {
        p.set(checkpoint, 'listCheckpoints', () => {
          throw new Error('checkpoint store corrupt')
        })
        const t = await checkpointMod.runCheckpointCapture(ctx())
        assert.deepEqual(errors(t), ['checkpoint store corrupt'])
      })
    )

    test(
      'a rejecting streamPrompt becomes an error entry',
      serial(async (p) => {
        p.set(checkpoint, 'listCheckpoints', () => [])
        const t = await checkpointMod.runCheckpointCapture(
          ctx({
            streamPrompt: async () => {
              throw new Error('stream failed')
            }
          })
        )
        assert.deepEqual(errors(t), ['stream failed'])
      })
    )
  })

  describe('checkpoint.runner — runCheckpointRestore', () => {
    const fixture = makeGitFixture()

    test(
      'skips cleanly when no checkpoint was captured',
      serial(async (p) => {
        p.set(checkpoint, 'listCheckpoints', () => [])
        const t = await checkpointMod.runCheckpointRestore(ctx())
        assert.deepEqual(statuses(t), ['streaming_edit', 'restore_skip_no_checkpoint'])
      })
    )

    test(
      'reports restore_failed with the service message',
      serial(async (p) => {
        p.set(checkpoint, 'listCheckpoints', () => [{ id: 'cp1' }])
        p.set(checkpoint, 'restoreGitState', () => ({ success: false, message: 'dirty tree' }))
        const t = await checkpointMod.runCheckpointRestore(ctx())
        assert.ok(statuses(t).includes('restore_failed: dirty tree'))
      })
    )

    test(
      'restores against the most recent checkpoint and the workspace path',
      serial(async (p) => {
        const calls: unknown[][] = []
        p.set(checkpoint, 'listCheckpoints', () => [{ id: 'newest' }, { id: 'older' }])
        p.set(checkpoint, 'restoreGitState', (...a: unknown[]) => {
          calls.push(a)
          return { success: false, message: 'stop here' }
        })
        const c = ctx()
        await checkpointMod.runCheckpointRestore(c)
        assert.deepEqual(calls, [['newest', c.workspacePath]])
      })
    )

    test(
      'reads the file back and reports restore_ok when the edit was reverted',
      serial(async (p) => {
        if (!fixture) return
        p.set(checkpoint, 'listCheckpoints', () => [{ id: 'cp1' }])
        p.set(checkpoint, 'restoreGitState', () => ({ success: true }))
        const t = await checkpointMod.runCheckpointRestore(ctx({ workspacePath: fixture }))
        assert.ok(statuses(t).includes('restore_ok'))
      })
    )

    test(
      'reports a content mismatch when the file still holds the edited value',
      serial(async (p) => {
        if (!fixture) return
        writeFileSync(join(fixture, 'src', 'hello.ts'), 'export const VERSION = "9.9.9"\n', 'utf-8')
        p.set(checkpoint, 'listCheckpoints', () => [{ id: 'cp1' }])
        p.set(checkpoint, 'restoreGitState', () => ({ success: true }))
        const t = await checkpointMod.runCheckpointRestore(ctx({ workspacePath: fixture }))
        assert.ok(statuses(t).includes('restore_content_mismatch'))
        writeFileSync(join(fixture, 'src', 'hello.ts'), 'export const VERSION = "1.0.0"\n', 'utf-8')
      })
    )

    test(
      'a missing file surfaces as an error entry rather than a crash',
      serial(async (p) => {
        p.set(checkpoint, 'listCheckpoints', () => [{ id: 'cp1' }])
        p.set(checkpoint, 'restoreGitState', () => ({ success: true }))
        const t = await checkpointMod.runCheckpointRestore(
          ctx({ workspacePath: join(tmpdir(), 'definitely-not-here-e2e') })
        )
        assert.equal(errors(t).length, 1)
        assert.match(errors(t)[0], /ENOENT/)
      })
    )
  })

  describe('checkpoint.runner — runCheckpointRewind', () => {
    test(
      'skips when fewer than two checkpoints exist',
      serial(async (p) => {
        p.set(checkpoint, 'listCheckpoints', () => [{ id: 'only' }])
        p.set(repos.messageRepository, 'findByConversation', () => [])
        const t = await checkpointMod.runCheckpointRewind(ctx())
        const s = statuses(t)
        assert.ok(s.includes('turn_1'))
        assert.ok(s.includes('turn_2'))
        assert.ok(s.includes('rewind_skip_insufficient_checkpoints: 1'))
      })
    )

    test(
      'deletes messages newer than the oldest checkpoint and reports rewind_ok',
      serial(async (p) => {
        const rows = [
          { id: 'm1', createdAt: '2024-01-01T00:00:00.000Z' },
          { id: 'm2', createdAt: '2024-01-03T00:00:00.000Z' },
          { id: 'm3', createdAt: '2024-01-04T00:00:00.000Z' }
        ]
        let live = [...rows]
        const deleted: string[] = []
        p.set(checkpoint, 'listCheckpoints', () => [
          { id: 'new', createdAt: '2024-01-05T00:00:00.000Z' },
          { id: 'old', createdAt: '2024-01-02T00:00:00.000Z' }
        ])
        p.set(checkpoint, 'restoreGitState', () => ({ success: true }))
        p.set(repos.messageRepository, 'findByConversation', () => live)
        p.set(repos.messageRepository, 'deleteById', (id: string) => {
          deleted.push(id)
          live = live.filter((r) => r.id !== id)
        })
        const t = await checkpointMod.runCheckpointRewind(ctx())
        assert.deepEqual(deleted, ['m2', 'm3'], 'only messages after the checkpoint are removed')
        assert.ok(statuses(t).includes('rewind_ok'))
      })
    )

    test(
      'reports rewind_messages_not_reduced when nothing was newer',
      serial(async (p) => {
        const rows = [{ id: 'm1', createdAt: '2024-01-01T00:00:00.000Z' }]
        p.set(checkpoint, 'listCheckpoints', () => [
          { id: 'new', createdAt: '2024-01-05T00:00:00.000Z' },
          { id: 'old', createdAt: '2024-01-02T00:00:00.000Z' }
        ])
        p.set(checkpoint, 'restoreGitState', () => ({ success: true }))
        p.set(repos.messageRepository, 'findByConversation', () => rows)
        p.set(repos.messageRepository, 'deleteById', () => {})
        const t = await checkpointMod.runCheckpointRewind(ctx())
        assert.ok(statuses(t).includes('rewind_messages_not_reduced'))
      })
    )

    test(
      'reports a git restore failure with its message',
      serial(async (p) => {
        p.set(checkpoint, 'listCheckpoints', () => [
          { id: 'new', createdAt: '2024-01-05T00:00:00.000Z' },
          { id: 'old', createdAt: '2024-01-02T00:00:00.000Z' }
        ])
        p.set(checkpoint, 'restoreGitState', () => ({ success: false, message: 'detached head' }))
        p.set(repos.messageRepository, 'findByConversation', () => [])
        const t = await checkpointMod.runCheckpointRewind(ctx())
        assert.ok(statuses(t).includes('rewind_git_restore_failed: detached head'))
      })
    )

    test(
      'a repository throw becomes an error entry',
      serial(async (p) => {
        p.set(repos.messageRepository, 'findByConversation', () => {
          throw new Error('messages table missing')
        })
        const t = await checkpointMod.runCheckpointRewind(ctx())
        assert.deepEqual(errors(t), ['messages table missing'])
      })
    )
  })

  describe('checkpoint.runner — runCheckpointUntracked', () => {
    test(
      'skips when the write never produced a file',
      serial(async (p) => {
        p.set(checkpoint, 'listCheckpoints', () => [])
        const t = await checkpointMod.runCheckpointUntracked(
          ctx({ workspacePath: join(tmpdir(), 'e2e-no-such-ws') })
        )
        const s = statuses(t)
        assert.ok(s.includes('file_created: false'))
        assert.ok(s.includes('untracked_skip_file_not_created'))
      })
    )

    test(
      'reports untracked_removed when restore cleaned the new file away',
      serial(async (p) => {
        const fixture = makeGitFixture()
        if (!fixture) return
        const target = join(fixture, 'src', 'e2e-untracked-test.ts')
        p.set(checkpoint, 'listCheckpoints', () => [{ id: 'cp-before' }])
        p.set(checkpoint, 'restoreGitState', () => {
          rmSync(target, { force: true })
          return { success: true }
        })
        const t = await checkpointMod.runCheckpointUntracked(
          ctx({
            workspacePath: fixture,
            streamPrompt: async () => {
              writeFileSync(target, 'export const TEST = true\n', 'utf-8')
              return []
            }
          })
        )
        const s = statuses(t)
        assert.ok(s.includes('file_created: true'))
        assert.ok(s.includes('untracked_removed'))
        rmSync(fixture, { recursive: true, force: true })
      })
    )

    test(
      'reports untracked_still_exists when restore left the file behind',
      serial(async (p) => {
        const fixture = makeGitFixture()
        if (!fixture) return
        const target = join(fixture, 'src', 'e2e-untracked-test.ts')
        p.set(checkpoint, 'listCheckpoints', () => [{ id: 'cp-before' }])
        p.set(checkpoint, 'restoreGitState', () => ({ success: true }))
        const t = await checkpointMod.runCheckpointUntracked(
          ctx({
            workspacePath: fixture,
            streamPrompt: async () => {
              writeFileSync(target, 'export const TEST = true\n', 'utf-8')
              return []
            }
          })
        )
        assert.ok(statuses(t).includes('untracked_still_exists'))
        rmSync(fixture, { recursive: true, force: true })
      })
    )

    test(
      'falls back to a real `git clean -fd` when restore reports failure',
      serial(async (p) => {
        const fixture = makeGitFixture()
        if (!fixture) return
        const target = join(fixture, 'src', 'e2e-untracked-test.ts')
        p.set(checkpoint, 'listCheckpoints', () => [{ id: 'cp-before' }])
        p.set(checkpoint, 'restoreGitState', () => ({ success: false, message: 'nope' }))
        const t = await checkpointMod.runCheckpointUntracked(
          ctx({
            workspacePath: fixture,
            streamPrompt: async () => {
              writeFileSync(target, 'export const TEST = true\n', 'utf-8')
              return []
            }
          })
        )
        assert.ok(statuses(t).includes('untracked_removed'), statuses(t).join('|'))
        assert.equal(existsSync(target), false, 'git clean must really delete the file')
        rmSync(fixture, { recursive: true, force: true })
      })
    )

    test(
      'skips when the file exists but there is no checkpoint to restore to',
      serial(async (p) => {
        const fixture = makeGitFixture()
        if (!fixture) return
        const target = join(fixture, 'src', 'e2e-untracked-test.ts')
        p.set(checkpoint, 'listCheckpoints', () => [])
        const t = await checkpointMod.runCheckpointUntracked(
          ctx({
            workspacePath: fixture,
            streamPrompt: async () => {
              writeFileSync(target, 'export const TEST = true\n', 'utf-8')
              return []
            }
          })
        )
        assert.ok(statuses(t).includes('untracked_skip_no_checkpoint'))
        rmSync(fixture, { recursive: true, force: true })
      })
    )
  })

  // ── workspace-ops.runner ───────────────────────────────────────────────────

  describe('workspace-ops.runner — repo runners', () => {
    test(
      'runRepoDiffDetection reports diff_detected when hello.ts is dirty',
      serial(async (p) => {
        p.set(repoSvc, 'getUncommittedFileDetails', async () => [
          { filePath: 'src/hello.ts' },
          { filePath: 'README.md' }
        ])
        const t = await wsOpsMod.runRepoDiffDetection(ctx())
        assert.deepEqual(statuses(t), ['streaming_edit', 'diff_detected'])
      })
    )

    test(
      'runRepoDiffDetection reports diff_not_detected for unrelated changes',
      serial(async (p) => {
        p.set(repoSvc, 'getUncommittedFileDetails', async () => [{ filePath: 'README.md' }])
        const t = await wsOpsMod.runRepoDiffDetection(ctx())
        assert.ok(statuses(t).includes('diff_not_detected'))
      })
    )

    test(
      'runRepoDiffDetection keeps only status entries from the streamed turn',
      serial(async (p) => {
        p.set(repoSvc, 'getUncommittedFileDetails', async () => [])
        const t = await wsOpsMod.runRepoDiffDetection(
          ctx({ streamPrompt: async () => [assistantText('chatty response')] })
        )
        assert.equal(t.filter((e: any) => e.type === 'text').length, 0)
      })
    )

    test(
      'runRepoDiffDetection surfaces a repo service rejection as an error entry',
      serial(async (p) => {
        p.set(repoSvc, 'getUncommittedFileDetails', async () => {
          throw new Error('not a git repository')
        })
        const t = await wsOpsMod.runRepoDiffDetection(ctx())
        assert.deepEqual(errors(t), ['not a git repository'])
      })
    )

    test(
      'runRepoCommit really commits into a temp repo and verifies git log',
      serial(async () => {
        const fixture = makeGitFixture()
        if (!fixture) return
        const t = await wsOpsMod.runRepoCommit(ctx({ workspacePath: fixture }))
        assert.deepEqual(statuses(t), ['commit_ok'])
        const head = execSync('git log --oneline -1', {
          cwd: fixture,
          encoding: 'utf-8',
          windowsHide: true
        })
        assert.match(head, /E2E: test commit for workspace-ops/)
        rmSync(fixture, { recursive: true, force: true })
      })
    )

    test(
      'runRepoCommit reports an error entry outside a git repository',
      serial(async () => {
        const dir = mkdtempSync(join(tmpdir(), 'e2e-not-git-'))
        mkdirSync(join(dir, 'src'), { recursive: true })
        const t = await wsOpsMod.runRepoCommit(ctx({ workspacePath: dir }))
        assert.equal(errors(t).length, 1)
        assert.equal(statuses(t).length, 0)
        rmSync(dir, { recursive: true, force: true })
      })
    )

    test(
      'runRepoCommitMessage reports ok for a substantive suggestion',
      serial(async () => {
        const fixture = makeGitFixture()
        if (!fixture) return
        const t = await wsOpsMod.runRepoCommitMessage(
          ctx({
            workspacePath: fixture,
            streamPrompt: async () => [assistantText('feat: add greeting helper')]
          })
        )
        assert.ok(statuses(t).includes('commit_message_ok'))
        rmSync(fixture, { recursive: true, force: true })
      })
    )

    test(
      'runRepoCommitMessage reports empty for a response of 5 chars or fewer',
      serial(async () => {
        const fixture = makeGitFixture()
        if (!fixture) return
        const t = await wsOpsMod.runRepoCommitMessage(
          ctx({ workspacePath: fixture, streamPrompt: async () => [assistantText('fix')] })
        )
        assert.ok(statuses(t).includes('commit_message_empty'))
        rmSync(fixture, { recursive: true, force: true })
      })
    )

    test(
      'runRepoCommitMessage surfaces an unwritable workspace as an error entry',
      serial(async () => {
        const t = await wsOpsMod.runRepoCommitMessage(
          ctx({ workspacePath: join(tmpdir(), 'e2e-missing-ws-dir') })
        )
        assert.equal(errors(t).length, 1)
      })
    )
  })

  describe('workspace-ops.runner — btw / insights / docs', () => {
    test(
      'runBtwQuestion reports btw_ok when the message count is unchanged',
      serial(async (p) => {
        p.set(repos.messageRepository, 'findByConversation', () => [{ id: 'm1' }])
        const t = await wsOpsMod.runBtwQuestion(ctx())
        assert.deepEqual(statuses(t), ['btw_claude_only', 'btw_ok'])
      })
    )

    test(
      'runBtwQuestion reports persistence when the count grew',
      serial(async (p) => {
        let n = 0
        p.set(repos.messageRepository, 'findByConversation', () =>
          new Array(++n).fill({ id: 'm' })
        )
        const t = await wsOpsMod.runBtwQuestion(ctx())
        assert.ok(statuses(t).includes('btw_persisted: before=1, after=2'))
      })
    )

    test(
      'runBtwQuestion surfaces a repository throw as an error entry',
      serial(async (p) => {
        p.set(repos.messageRepository, 'findByConversation', () => {
          throw new Error('conversation missing')
        })
        const t = await wsOpsMod.runBtwQuestion(ctx())
        assert.deepEqual(errors(t), ['conversation missing'])
      })
    )

    test(
      'runInsightsTokens reports the tracked cost after two turns',
      serial(async (p) => {
        let turns = 0
        p.set(costTracker, 'getConversationCostCents', () => 17)
        const t = await wsOpsMod.runInsightsTokens(
          ctx({
            streamPrompt: async () => {
              turns++
              return []
            }
          })
        )
        assert.equal(turns, 2)
        assert.deepEqual(statuses(t), ['turn_1', 'turn_2', 'tokens_reported: cost_cents=17'])
      })
    )

    test(
      'runInsightsTokens still reports zero cost for a free local model',
      serial(async (p) => {
        p.set(costTracker, 'getConversationCostCents', () => 0)
        const t = await wsOpsMod.runInsightsTokens(ctx())
        assert.ok(statuses(t).includes('tokens_reported: cost_cents=0'))
      })
    )

    test(
      'runInsightsTokens surfaces a cost tracker throw as an error entry',
      serial(async (p) => {
        p.set(costTracker, 'getConversationCostCents', () => {
          throw new Error('usage log unavailable')
        })
        const t = await wsOpsMod.runInsightsTokens(ctx())
        assert.deepEqual(errors(t), ['usage log unavailable'])
      })
    )

    test(
      'runDocsMermaid finds the mermaid block in the fixture docs',
      serial(async () => {
        const fixture = makeGitFixture()
        if (!fixture) return
        const t = await wsOpsMod.runDocsMermaid(ctx({ workspacePath: fixture }))
        assert.deepEqual(statuses(t), ['mermaid_ok', 'mermaid_error_ok'])
        rmSync(fixture, { recursive: true, force: true })
      })
    )

    test(
      'runDocsMermaid reports mermaid_no_block for docs without a diagram',
      serial(async () => {
        const fixture = makeGitFixture()
        if (!fixture) return
        writeFileSync(join(fixture, 'docs', 'sample.md'), '# Plain doc\n\nNo diagrams here.\n')
        const t = await wsOpsMod.runDocsMermaid(ctx({ workspacePath: fixture }))
        assert.ok(statuses(t).includes('mermaid_no_block'))
        rmSync(fixture, { recursive: true, force: true })
      })
    )

    test(
      'runDocsMermaid skips when the fixture doc is absent',
      serial(async () => {
        const t = await wsOpsMod.runDocsMermaid(
          ctx({ workspacePath: join(tmpdir(), 'e2e-no-docs-here') })
        )
        assert.deepEqual(statuses(t), ['mermaid_skip_no_fixture'])
      })
    )
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
