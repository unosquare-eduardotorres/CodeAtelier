/**
 * Blueprint DAG Scheduling E2E — offline, shim-driven (D5).
 *
 * Drives the real Electron app through the full blueprint pipeline with the
 * scripted claude shim in DAG-tasks mode (CLAUDE_SHIM_DAG_TASKS=1): the tasks
 * phase emits two independent wave-1 tasks plus a wave-2 gate task depending
 * on both. Everything is real (renderer, IPC, main process, SQLite, git)
 * EXCEPT the model.
 *
 * Asserts the DAG scheduler's two headline behaviors end-to-end:
 *   1. Cross-wave parallel dispatch — the build artifact's scheduler stats
 *      record mode 'dag' with maxParallelism ≥ 2 (T001 ∥ T002), and the
 *      wave-2 gate task T003 completed after both deps (status complete).
 *   2. Drain-point gates — drainCount ≥ 1 wave-gate run on the settled tree
 *      (wave-gates artifacts exist), and no gate inflation (small count).
 *
 * Run:
 *   npx electron-vite build
 *   CLAUDE_SHIM_DIR=e2e/helpers/claude-shim CLAUDE_SHIM_DAG_TASKS=1 \
 *     npx playwright test e2e/blueprint-dag-scheduling.e2e.ts
 *
 * Prerequisites:
 *   - Built app: out/main/index.js
 */
import { test, expect } from './helpers/electron-fixture'
import type { Page } from '@playwright/test'
import { WelcomePage } from './pages/welcome-page'
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const IS_SHIM = !!process.env.CLAUDE_SHIM_DIR
const IS_DAG = process.env.CLAUDE_SHIM_DAG_TASKS === '1'

test.skip(!IS_SHIM || !IS_DAG, 'Set CLAUDE_SHIM_DIR + CLAUDE_SHIM_DAG_TASKS=1 to enable this test')

test.setTimeout(240_000)

// ── Helpers (mirrors blueprint-quality-gates.e2e.ts) ──

async function createWorkspace(page: Page, name: string, repoPath: string): Promise<string> {
  return page.evaluate(
    async ([n, p]) => {
      const ws = await (window as any).api.createWorkspace({ name: n, repoPath: p })
      return ws.id as string
    },
    [name, repoPath]
  )
}

async function getBlueprintDetails(page: Page, blueprintId: string): Promise<any> {
  return page.evaluate(async (id) => {
    return (await (window as any).api.blueprintGetDetails({ id })) as any
  }, blueprintId)
}

async function waitForTerminalStatus(
  page: Page,
  blueprintId: string,
  timeoutMs = 180_000
): Promise<any> {
  const deadline = Date.now() + timeoutMs
  let last: any = null
  while (Date.now() < deadline) {
    last = await getBlueprintDetails(page, blueprintId)
    if (last && ['complete', 'failed', 'cancelled'].includes(last.status)) return last
    await page.waitForTimeout(1_000)
  }
  throw new Error(
    `Blueprint did not reach a terminal status within ${timeoutMs}ms — last: ` +
      `${last?.status ?? 'unknown'} (phase ${last?.currentPhase ?? '?'})`
  )
}

async function startBlueprint(page: Page, workspaceId: string, title: string): Promise<string> {
  return page.evaluate(
    async ([wsId, t]) => {
      const created = (await (window as any).api.blueprintCreate({
        workspaceId: wsId as string,
        title: t as string,
        description: 'Add a greeting endpoint that returns JSON with a name parameter'
      })) as { id: string }
      await (window as any).api.blueprintStartSpecify({
        blueprintId: created.id,
        workspaceId: wsId as string
      })
      return created.id
    },
    [workspaceId, title]
  )
}

async function answerGates(page: Page, blueprintId: string, workspaceId: string): Promise<void> {
  const deadline = Date.now() + 120_000
  let answered = false
  let proceeded = false
  let approved = false
  let clarifyPolls = 0

  while (Date.now() < deadline && !(answered && proceeded && approved)) {
    const details = await getBlueprintDetails(page, blueprintId)

    if (!answered && details?.currentPhase === 'clarify') {
      clarifyPolls++
      if (clarifyPolls >= 2) {
        answered = await page.evaluate(
          async ([bpId, wsId]) => {
            try {
              await (window as any).api.blueprintClarifyAnswer({
                blueprintId: bpId,
                workspaceId: wsId,
                message: 'JSON format. Include the name parameter. 100 req/min rate limit.'
              })
              return true
            } catch {
              return false
            }
          },
          [blueprintId, workspaceId]
        )
      }
    }

    if (answered && !proceeded && details?.currentPhase === 'clarify') {
      await page.waitForTimeout(2_000)
      proceeded = await page.evaluate(
        async ([bpId, wsId]) => {
          try {
            await (window as any).api.blueprintClarifyProceed({
              blueprintId: bpId,
              workspaceId: wsId
            })
            return true
          } catch {
            return false
          }
        },
        [blueprintId, workspaceId]
      )
    }

    if (!approved && details?.status === 'reviewing') {
      const reviewPhase = details.phases?.find((p: any) => p.phase === 'review')
      if (reviewPhase?.status === 'complete') {
        try {
          await page.evaluate(
            async ([bpId]) => {
              await (window as any).api.blueprintApprovalRespond({
                blueprintId: bpId as string,
                approved: true
              })
            },
            [blueprintId]
          )
          approved = true
        } catch {
          /* gate not raised yet — retry */
        }
      }
    }

    if (answered && proceeded && approved) break
    await page.waitForTimeout(1_500)
  }

  if (!answered) throw new Error('Clarify phase never became answerable')
  if (!proceeded) throw new Error('Clarify gate never became passable')
  if (!approved) throw new Error('Review approval gate never became answerable')
}

// ── Tests ──

test.describe('Blueprint DAG Scheduling (offline, shim-driven)', () => {
  test('cross-wave parallel dispatch + drain-point gates recorded in build artifact', async ({
    electronPage: page
  }) => {
    const welcomePage = new WelcomePage(page)
    if (await welcomePage.isWelcomeModalVisible()) {
      await welcomePage.completeWelcomeModal('E2E Test')
    }

    const repoDir = mkdtempSync(join(tmpdir(), 'e2e-dag-scheduling-'))
    writeFileSync(join(repoDir, 'README.md'), '# E2E DAG scheduling workspace\n')
    const workspaceId = await createWorkspace(page, 'E2E DAG Scheduling', repoDir)

    const blueprintId = await startBlueprint(page, workspaceId, 'E2E DAG Scheduling Run')
    await answerGates(page, blueprintId, workspaceId)

    const final = await waitForTerminalStatus(page, blueprintId)
    expect(final.status).toBe('complete')

    // ── 1. All three tasks completed; the wave-2 gate task ran after its deps ──
    const tasks = final.tasks as Array<{ taskId: string; status: string; wave: number }>
    expect(tasks.length).toBe(3)
    for (const t of tasks) {
      expect(t.status, `task ${t.taskId}`).toBe('complete')
    }
    const t3 = tasks.find((t) => t.taskId === 'T003')
    expect(t3?.wave).toBe(2)

    // ── 2. Scheduler stats: DAG mode, real parallelism, drain-point gates ──
    const buildPhase = (final.phases as Array<any>).find((p) => p.phase === 'build')
    expect(buildPhase).toBeDefined()
    const artifacts = (buildPhase?.artifactsJson ?? []) as Array<{
      type: string
      contentJson?: Record<string, unknown>
    }>
    const buildArtifact = artifacts.findLast((a) => a.type === 'build')
    expect(buildArtifact).toBeDefined()

    const scheduler = buildArtifact?.contentJson?.scheduler as
      | {
          mode: string
          maxParallelism: number
          drainCount: number
          parallelismHistogram?: Record<string, number>
          perTaskWaitMs?: Record<string, number>
        }
      | undefined
    expect(scheduler).toBeDefined()
    expect(scheduler?.mode).toBe('dag')
    // T001 ∥ T002 dispatched concurrently (cap default 3)
    expect(scheduler?.maxParallelism ?? 0).toBeGreaterThanOrEqual(2)
    // Drain-point gates ran on the settled tree — at least once (the join
    // stall before T003, and/or the final settle), never per-completion.
    expect(scheduler?.drainCount ?? 0).toBeGreaterThanOrEqual(1)
    expect(scheduler?.drainCount ?? 0).toBeLessThanOrEqual(3)

    // ── 3. Wave-gate evidence persisted (drain-point gates are wave-gates) ──
    const waveGateArtifacts = artifacts.filter((a) => a.type === 'wave-gates')
    expect(waveGateArtifacts.length).toBeGreaterThanOrEqual(1)
    expect(waveGateArtifacts.length).toBeLessThanOrEqual(3)
  })
})
