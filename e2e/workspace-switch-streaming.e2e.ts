/**
 * Workspace-Switch Streaming — Fullstack E2E Test
 *
 * The reported bug: a blueprint keeps running when you switch workspaces, but a
 * chat "stops streaming" the moment you do. This drives the real app through the
 * whole scenario and asserts the stream survives:
 *
 *   workspace A → send a slow chat turn → switch to workspace B mid-stream →
 *   main is STILL streaming conversation A → stream completes while B is on
 *   screen → the streamed text is persisted to A and visible on switch-back.
 *
 * Everything is real (renderer, IPC, main, SQLite, the CLI executor) except the
 * model: the shim on PATH answers `spawn('claude')` with a deliberately slow
 * plain-chat turn (E2E_SLOW_STREAM marker → ~30s of deltas), which is what makes
 * "act while the stream is live" testable at all.
 *
 * Both workspaces are created by the test (temp git repos) and deleted in
 * teardown, so it does not depend on — or disturb — the machine's workspaces.
 *
 * Run:
 *   npx electron-vite build
 *   CLAUDE_SHIM_DIR=e2e/helpers/claude-shim npx playwright test e2e/workspace-switch-streaming.e2e.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

const IS_SHIM = !!process.env.CLAUDE_SHIM_DIR

test.skip(!IS_SHIM, 'Set CLAUDE_SHIM_DIR=e2e/helpers/claude-shim to enable this test')

// Boot + two workspace creations + a ~30s stream + switch-back.
test.setTimeout(300_000)

/** Marker the shim answers with a slow stream. Kept under 80 chars so the
 *  prompt optimizer skips it (prompt-optimizer.service.ts: `text.length < 80`). */
const SLOW_PROMPT = 'E2E_SLOW_STREAM: count slowly for me'
/** Emitted in the shim's LAST delta — proves the tail of the stream survived. */
const SENTINEL = 'E2E-STREAM-SENTINEL'
const CONVERSATION_TITLE = 'E2E switch stream'

const tempDirs: string[] = []
const createdWorkspaceIds: string[] = []

// ── Helpers ──

/** A throwaway repo directory for a workspace (main auto-inits git). */
function makeRepoDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `e2e-ws-${label}-`))
  writeFileSync(join(dir, 'README.md'), `# E2E ${label} workspace\n`)
  tempDirs.push(dir)
  return dir
}

async function createWorkspace(page: Page, name: string, repoPath: string): Promise<string> {
  const id = await page.evaluate(
    async ([n, p]) => {
      const ws = await (window as any).api.createWorkspace({ name: n, repoPath: p })
      return ws.id as string
    },
    [name, repoPath]
  )
  createdWorkspaceIds.push(id)
  return id
}

/** Conversation IDs main reports as actively streaming (the authoritative view). */
async function streamingConversationIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const state = await (window as any).api.getStreamingState()
    return ((state?.streams ?? []) as Array<{ conversationId: string }>).map(
      (s) => s.conversationId
    )
  })
}

/**
 * Reload the renderer so the workspace list picks up workspaces created over
 * IPC — `loadWorkspaces()` runs once in the boot effect, so the welcome screen
 * would otherwise keep rendering the pre-setup list.
 */
async function reloadRenderer(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' })
  // Same flag the fixture sets — it skips workspace transition animations.
  await page.evaluate(() => {
    ;(window as unknown as Record<string, unknown>).__E2E_TESTING__ = true
  })
  await page.waitForTimeout(4_000)
  const welcome = new WelcomePage(page)
  if (await welcome.isWelcomeModalVisible()) {
    await welcome.completeWelcomeModal('E2E Test')
  }
}

/** Return to the welcome screen — the app's workspace-switch surface. */
async function goHome(page: Page): Promise<void> {
  const homeBtn = page.locator('[aria-label="Home"]')
  if (await homeBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await homeBtn.click()
    await page.waitForTimeout(1_000)
  }
}

/**
 * Plan mode asks "Specialists will be used for this plan action" before the
 * first send. Confirm it — otherwise the prompt just sits in the composer.
 * Absent when the user has ticked "don't show this again", hence best-effort.
 */
async function confirmPlanSpecialistWarning(page: Page): Promise<void> {
  const continueBtn = page.getByRole('dialog').getByRole('button', { name: /^continue$/i })
  if (await continueBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await continueBtn.click()
    await page.waitForTimeout(500)
  }
}

async function openWorkspaceCard(page: Page, workspaceId: string): Promise<void> {
  const card = page.locator(`[data-testid="workspace-card"][data-workspace-id="${workspaceId}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await card.click()
  await expect(page.locator('[data-testid="unified-sidebar"]').first()).toBeVisible({
    timeout: 20_000
  })
}

// ── Teardown ──

test.afterAll(async ({ electronPage: page }) => {
  for (const id of createdWorkspaceIds) {
    await page
      .evaluate(async (workspaceId) => {
        await (window as any).api.deleteWorkspace({ id: workspaceId })
      }, id)
      .catch(() => {})
  }
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

test.describe('Workspace-switch streaming', () => {
  test('a chat streaming in workspace A keeps streaming after switching to workspace B', async ({
    electronPage: page
  }) => {
    const welcome = new WelcomePage(page)
    if (await welcome.isWelcomeModalVisible()) {
      await welcome.completeWelcomeModal('E2E Test')
    }

    // 1. Two dedicated workspaces — A streams, B is the one we switch to.
    const workspaceA = await createWorkspace(page, 'E2E Stream Source', makeRepoDir('a'))
    const workspaceB = await createWorkspace(page, 'E2E Stream Target', makeRepoDir('b'))

    // 2. A conversation in A, pinned to the CLI-backed provider the shim serves.
    const conversationId = await page.evaluate(
      async ([wsId, title]) => {
        const conv = await (window as any).api.createConversation({
          workspaceId: wsId,
          title,
          mode: 'plan',
          llmProvider: 'claude'
        })
        return conv.id as string
      },
      [workspaceA, CONVERSATION_TITLE]
    )

    // 3. Open A and select the conversation through the real UI.
    await reloadRenderer(page)
    await goHome(page)
    await openWorkspaceCard(page, workspaceA)

    const chatItem = page.locator(`[aria-label="Open conversation: ${CONVERSATION_TITLE}"]`)
    await expect(chatItem).toBeVisible({ timeout: 20_000 })
    await chatItem.click()

    // 4. Send through the composer so the STORE drives the stream, not raw IPC.
    const composer = page.locator('[aria-label="Message input"]')
    await expect(composer).toBeVisible({ timeout: 15_000 })
    await composer.fill(SLOW_PROMPT)
    await composer.press('Enter')
    await confirmPlanSpecialistWarning(page)

    // 5. The turn is live: main reports it and the composer offers Stop.
    await expect
      .poll(async () => (await streamingConversationIds(page)).includes(conversationId), {
        timeout: 60_000,
        message: 'main never started streaming the conversation — is the shim on PATH?'
      })
      .toBe(true)
    await expect(page.locator('[aria-label="Stop generation"]')).toBeVisible({ timeout: 20_000 })

    // 6. Switch to workspace B while the stream is still running.
    await goHome(page)
    await openWorkspaceCard(page, workspaceB)

    // 7. THE REGRESSION: the switch must not stop the stream. Sample repeatedly —
    //    a teardown triggered by the switch shows up within a second or two.
    for (let sample = 0; sample < 6; sample++) {
      expect(
        await streamingConversationIds(page),
        `conversation A stopped streaming after the workspace switch (sample ${sample})`
      ).toContain(conversationId)
      await page.waitForTimeout(1_000)
    }

    // 8. Let it finish while workspace B is still on screen.
    await expect
      .poll(async () => (await streamingConversationIds(page)).includes(conversationId), {
        timeout: 120_000,
        message: 'the background stream never completed'
      })
      .toBe(false)

    // 9. The whole answer — including the last delta — was persisted to A.
    const persisted = await page.evaluate(async (cid) => {
      const messages = await (window as any).api.getMessages({ conversationId: cid })
      return (messages as Array<{ contentMd: string }>).map((m) => m.contentMd).join('\n')
    }, conversationId)
    expect(persisted).toContain(SENTINEL)

    // 10. Switching back shows it in the transcript.
    await goHome(page)
    await openWorkspaceCard(page, workspaceA)
    await expect(chatItem).toBeVisible({ timeout: 20_000 })
    await chatItem.click()
    await expect(
      page.locator('[data-testid="chat-panel"]').getByText(SENTINEL).first()
    ).toBeVisible({ timeout: 20_000 })
  })
})
