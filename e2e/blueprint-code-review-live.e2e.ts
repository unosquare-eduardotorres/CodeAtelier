/**
 * Blueprint Code-Review Live E2E — real LLM, manual run only (M10.1).
 *
 * Drives the real Electron app through a full pipeline with the code-review
 * role ON: build → code-review → verify → complete. Everything is real,
 * including the model — this spec exists to prove the adversarial layer runs
 * end-to-end with a genuine reviewer, which the shim cannot prove.
 *
 * Asserts:
 *   - the code-review phase record reaches `complete` (not `skipped`)
 *   - a code-review findings artifact exists on the phase record
 *   - the CodeReviewDeliverable renders in the detail view
 *
 * Run (manual — needs a workspace with a cloud provider configured and the
 * `blueprint:code-review` role bound to a model):
 *   npx electron-vite build
 *   LIVE_LLM=1 npx playwright test --project electron-live e2e/blueprint-code-review-live.e2e.ts
 *
 * Prerequisites:
 *   - Built app: out/main/index.js
 *   - A workspace with cloud provider configured (not local-llm)
 *   - The `blueprint:code-review` role bound to a model in Model Routing
 */
import { test, expect } from './helpers/electron-fixture'
import type { Page } from '@playwright/test'
import { WelcomePage } from './pages/welcome-page'
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const IS_LIVE = process.env.LIVE_LLM === '1'

test.skip(!IS_LIVE, 'Set LIVE_LLM=1 to enable this test (manual — real LLM)')

// Real LLM through 8 phases including a whole-diff review — allow 15 min.
test.setTimeout(900_000)

const tempDirs: string[] = []

/** A throwaway repo directory for the pipeline workspace (main auto-inits git). */
function makeRepoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-code-review-live-'))
  writeFileSync(join(dir, 'README.md'), '# E2E code-review live workspace\n')
  tempDirs.push(dir)
  return dir
}

// ── Helpers ──

async function createWorkspace(page: Page, name: string, repoPath: string): Promise<string> {
  return page.evaluate(
    async ([n, p]) => {
      const ws = await (window as any).api.createWorkspace({ name: n, repoPath: p })
      return ws.id as string
    },
    [name, repoPath]
  )
}

/** Read a workspace settings key straight over IPC. */
async function readSetting(page: Page, workspaceId: string, key: string): Promise<unknown> {
  return page.evaluate(
    async ([wsId, k]) => {
      const s = await (window as any).api.getWorkspaceSettings({ workspaceId: wsId })
      return (s ?? {})[k as string]
    },
    [workspaceId, key]
  )
}

/** Write workspace settings straight over IPC. */
async function writeSetting(
  page: Page,
  workspaceId: string,
  settings: Record<string, unknown>
): Promise<void> {
  await page.evaluate(
    async ([wsId, s]) => {
      await (window as any).api.updateWorkspaceSettings({
        workspaceId: wsId as string,
        settings: s as Record<string, unknown>
      })
    },
    [workspaceId, settings]
  )
}

/** Blueprint detail over IPC. */
async function getBlueprintDetails(page: Page, blueprintId: string): Promise<any> {
  return page.evaluate(async (id) => {
    return (await (window as any).api.blueprintGetDetails({ id })) as any
  }, blueprintId)
}

/** Poll until the blueprint reaches a terminal status, or fail with the last state. */
async function waitForTerminalStatus(page: Page, blueprintId: string, timeoutMs = 840_000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  let last: any = null
  while (Date.now() < deadline) {
    last = await getBlueprintDetails(page, blueprintId)
    if (last && ['complete', 'failed', 'cancelled'].includes(last.status)) return last
    await page.waitForTimeout(5_000)
  }
  throw new Error(
    `Blueprint did not reach a terminal status within ${timeoutMs}ms — last: ` +
      `${last?.status ?? 'unknown'} (phase ${last?.currentPhase ?? '?'}, ` +
      `${last?.phases?.map((p: any) => `${p.phase}:${p.status}`).join(' ')})`
  )
}

/** Create + start a blueprint over IPC. */
async function startBlueprint(page: Page, workspaceId: string, title: string): Promise<string> {
  return page.evaluate(
    async ([wsId, t]) => {
      const created = (await (window as any).api.blueprintCreate({
        workspaceId: wsId as string,
        title: t as string,
        description:
          'Add a /hello endpoint module: a greet(name) function returning JSON ' +
          '{ "greeting": "Hello, <name>" } plus a unit test for empty and normal names.'
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

/** Answer clarify (free text), pass the clarify gate, and approve the review gate over IPC. */
async function answerGates(page: Page, blueprintId: string, workspaceId: string): Promise<void> {
  const deadline = Date.now() + 600_000
  let answered = false
  let proceeded = false
  let approved = false

  while (Date.now() < deadline && !(answered && proceeded && approved)) {
    const details = await getBlueprintDetails(page, blueprintId)

    if (!answered && details?.currentPhase === 'clarify') {
      answered = await page
        .evaluate(
          async ([bpId, wsId]) => {
            try {
              await (window as any).api.blueprintClarifyAnswer({
                blueprintId: bpId,
                workspaceId: wsId,
                message:
                  'JSON response. Name parameter required, default "world" when absent. ' +
                  'No rate limiting needed for this test.'
              })
              return true
            } catch {
              return false
            }
          },
          [blueprintId, workspaceId]
        )
        .catch(() => false)
    }

    if (answered && !proceeded && details?.currentPhase === 'clarify') {
      proceeded = await page
        .evaluate(
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
        .catch(() => false)
    }

    if (!approved && details?.status === 'reviewing') {
      const reviewPhase = details.phases?.find((p: any) => p.phase === 'review')
      // Only after the record is `complete` — approving while `active` (gate
      // not yet raised) dispatches BUILD into a running machine.
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
          // Gate not raised yet — retry on the next poll
        }
      }
    }

    if (answered && proceeded && approved) break
    await page.waitForTimeout(5_000)
  }
}

/** Navigate to the blueprint detail view (phase deliverables render there). */
async function navigateToBlueprintDetail(
  page: Page,
  title: string
): Promise<void> {
  const welcomePage = new WelcomePage(page)
  if (await welcomePage.isWelcomeModalVisible()) {
    await welcomePage.completeWelcomeModal('E2E Test')
  }

  const wsItems = page.locator('[data-testid="workspace-item"]')
  if (await wsItems.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
    await wsItems.first().click()
    await page.waitForTimeout(3_000)
  }

  // In-workspace nav: the sidebar has a direct "Blueprints" button.
  const bpNav = page.getByRole('button', { name: /^blueprints$/i })
  if (await bpNav.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await bpNav.click()
    await page.waitForTimeout(800)
  }
  await expect(page.locator('[data-testid="blueprint-page"]')).toBeVisible({ timeout: 10_000 })

  const item = page.locator('[data-testid="blueprint-page"]').getByText(title).first()
  if (await item.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await item.click()
    await page.waitForTimeout(2_000)
  }
}

// ── Test ──

test.describe('Blueprint Code-Review (live LLM)', () => {
  test('role ON → build → code-review → verify → complete', async ({ electronPage: page }) => {
    // ── Setup: throwaway workspace ──
    const repoDir = makeRepoDir()
    const workspaceId = await createWorkspace(page, 'E2E Code Review Live', repoDir)

    // Bind the code-review role ON (modelRoles entry without disabled flag).
    // The role resolves to whatever model the workspace routes by default —
    // the point is that the layer RUNS, not which model reviews.
    const existingRoles = (await readSetting(page, workspaceId, 'modelRoles')) as
      | Record<string, unknown>
      | undefined
    await writeSetting(page, workspaceId, {
      modelRoles: {
        ...(existingRoles ?? {}),
        'blueprint:code-review': { provider: 'claude', modelId: 'claude-sonnet-4-6' }
      }
    })

    // ── Run the pipeline ──
    const blueprintId = await startBlueprint(page, workspaceId, 'E2E Code Review Live Run')
    await answerGates(page, blueprintId, workspaceId)

    const final = await waitForTerminalStatus(page, blueprintId)
    expect(final.status).toBe('complete')

    // ── Assert: code-review phase record `complete` (role ON — ran for real) ──
    const codeReviewPhase = final.phases.find((p: any) => p.phase === 'code-review')
    expect(codeReviewPhase).toBeDefined()
    expect(codeReviewPhase?.status).toBe('complete')

    // ── Assert: findings artifact exists on the phase record ──
    const artifacts = codeReviewPhase?.artifactsJson ?? []
    const findingsArtifact = artifacts.find((a: any) => a.type === 'code-review')
    expect(findingsArtifact).toBeDefined()
    const contentJson = findingsArtifact?.contentJson as
      | { findings?: unknown[]; verdict?: string }
      | undefined
    expect(Array.isArray(contentJson?.findings)).toBe(true)
    expect(typeof contentJson?.verdict).toBe('string')

    // ── Assert: CodeReviewDeliverable renders in the detail view ──
    await navigateToBlueprintDetail(page, 'E2E Code Review Live Run')

    // The deliverable header shows the phase label + a findings count summary
    const deliverable = page.getByText('Code Review', { exact: false }).first()
    await expect(deliverable).toBeVisible({ timeout: 15_000 })

    // Verdict banner renders (approve / fix required / concerns noted)
    const verdictText = page.getByText(/approve|fix required|concerns noted/i).first()
    await expect(verdictText).toBeVisible({ timeout: 10_000 })
  })
})
