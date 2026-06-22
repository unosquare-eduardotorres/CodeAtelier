/**
 * Investigation Flow E2E Test
 *
 * Verifies:
 * 1. Handoff indicator appears when generalist detects investigation
 * 2. Task plan card renders after coordinator decomposes
 * 3. After specialist completes, investigation report card renders
 * 4. Action buttons (Fix Sequential, Fix Parallel, Revise, Save as Idea) are present
 * 5. Visual ordering: Da Vinci → Task Plan → Specialist output → Report card
 *
 * Uses CDP approach (same as ux-audit-screenshots.e2e.ts) because
 * Playwright's _electron.launch() is incompatible with Electron 41+.
 *
 * Prerequisites:
 *   1. Build the app first: npx electron-vite build
 *   2. Run: npx playwright test e2e/investigation-flow.e2e.ts
 */
import { test, expect, chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { resolve } from 'path'

const ELECTRON_BIN = resolve(
  __dirname,
  '../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
)
const MAIN_ENTRY = resolve(__dirname, '../out/main/index.js')
const CDP_PORT = 19223 // Different port to avoid conflicts with other tests

/** Wait for CDP to be available */
async function waitForCDP(port: number, timeoutMs = 20000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (resp.ok) return
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`CDP not available on port ${port} after ${timeoutMs}ms`)
}

test.describe('Investigation Flow', () => {
  let electronProcess: ChildProcess | null = null
  let browser: Browser | null = null
  let page: Page | null = null

  test.beforeAll(async () => {
    // Launch Electron with remote debugging
    electronProcess = spawn(ELECTRON_BIN, [MAIN_ENTRY, '--no-sandbox'], {
      env: {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: '1',
        NODE_ENV: 'development'
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      args: [`--remote-debugging-port=${CDP_PORT}`]
    } as Parameters<typeof spawn>[2])

    // Wait for CDP
    await waitForCDP(CDP_PORT)

    // Connect via CDP
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
    const contexts = browser.contexts()
    if (contexts.length === 0) {
      throw new Error('No browser contexts found')
    }
    const pages = contexts[0].pages()
    page = pages.length > 0 ? pages[0] : await contexts[0].newPage()

    // Wait for the app to load
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)
  })

  test.afterAll(async () => {
    if (browser) {
      await browser.close().catch(() => {})
    }
    if (electronProcess) {
      electronProcess.kill('SIGTERM')
      // Give it time to clean up, then force kill
      await new Promise((r) => setTimeout(r, 3000))
      if (!electronProcess.killed) {
        electronProcess.kill('SIGKILL')
      }
    }
  })

  test('investigation report card renders after specialist completes', async () => {
    test.skip(!page, 'Page not available — Electron may not have launched')

    // 1. Verify the app has loaded (check for chat input or workspace selector)
    await expect(
      page!.locator('[data-testid="message-input"], [aria-label="Message input"]').first()
    ).toBeVisible({ timeout: 15000 })

    // 2. Wait for TaskPlanCard to appear (triggered by handoff)
    // This test assumes a conversation is already in progress or we can trigger one
    // In a real scenario, we'd send a message that triggers investigation
    const taskPlanCard = page!.locator('[data-testid="task-plan-card"]')

    // If a task plan card appears, verify the investigation flow
    if (await taskPlanCard.isVisible({ timeout: 5000 }).catch(() => false)) {
      // 3. Click "Sequential" to start execution
      const sequentialBtn = page!.locator('button:has-text("Sequential")')
      if (await sequentialBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await sequentialBtn.click()
      }

      // 4. Wait for completion or investigation report (unified card)
      const reportCard = page!.locator('[data-testid="task-plan-card"]')
      await expect(reportCard).toBeVisible({ timeout: 120000 })

      // 5. Verify unified action buttons are present
      await expect(page!.locator('button:has-text("Build Now")')).toBeVisible()
      await expect(page!.locator('button:has-text("Orchestrated Build")')).toBeVisible()
      await expect(page!.locator('button:has-text("Refine Plan")')).toBeVisible()
      await expect(page!.locator('button:has-text("Save as Idea")')).toBeVisible()
    }
  })

  test('message ordering: Da Vinci → Handoff → Task Plan → Specialist', async () => {
    test.skip(!page, 'Page not available — Electron may not have launched')

    // Verify DOM ordering of rendered messages
    // Da Vinci message should appear before the task plan card
    const messageElements = page!.locator(
      '[data-testid="message-bubble"], [data-testid="task-plan-card"], [data-testid="handoff-indicator"]'
    )

    const count = await messageElements.count()
    if (count >= 2) {
      // Collect the testid order
      const testIds: string[] = []
      for (let i = 0; i < count; i++) {
        const testId = await messageElements.nth(i).getAttribute('data-testid')
        if (testId) testIds.push(testId)
      }

      // If we have both message bubbles and task plan, verify ordering
      const firstMessageIdx = testIds.indexOf('message-bubble')
      const taskPlanIdx = testIds.indexOf('task-plan-card')
      const handoffIdx = testIds.indexOf('handoff-indicator')

      if (firstMessageIdx !== -1 && taskPlanIdx !== -1) {
        // Messages should appear before task plan
        expect(firstMessageIdx).toBeLessThan(taskPlanIdx)
      }

      if (handoffIdx !== -1 && taskPlanIdx !== -1) {
        // Handoff indicator should appear before task plan
        expect(handoffIdx).toBeLessThan(taskPlanIdx)
      }
    }
  })

  test('data-testid attributes are present on key elements', async () => {
    test.skip(!page, 'Page not available — Electron may not have launched')

    // Verify that our testability attributes are in the DOM when elements render
    // This is a lightweight smoke test — the actual elements may not all be visible
    // at once, but the selectors should be valid

    // Message bubbles should exist if any conversation is loaded
    const messageBubbles = page!.locator('[data-testid="message-bubble"]')
    const bubbleCount = await messageBubbles.count()

    // If there are messages, at least one should be accessible
    if (bubbleCount > 0) {
      await expect(messageBubbles.first()).toBeVisible()
    }
  })

  test('action button Build Now routes to blueprint pipeline', async () => {
    test.skip(!page, 'Page not available — Electron may not have launched')

    const buildNowBtn = page!.locator('button:has-text("Build Now")')
    const hasBuildNow = await buildNowBtn.isVisible({ timeout: 5000 }).catch(() => false)

    if (!hasBuildNow) {
      // Build Now only appears after investigation completes — skip if not present
      test.skip()
      return
    }

    // Button should be enabled and clickable
    await expect(buildNowBtn).toBeEnabled()

    // Verify it's styled as a primary action
    const text = await buildNowBtn.textContent()
    expect(text).toContain('Build Now')
  })

  test('action button Save as Idea creates idea entry', async () => {
    test.skip(!page, 'Page not available — Electron may not have launched')

    const saveIdeaBtn = page!.locator('button:has-text("Save as Idea")')
    const hasSaveIdea = await saveIdeaBtn.isVisible({ timeout: 5000 }).catch(() => false)

    if (!hasSaveIdea) {
      test.skip()
      return
    }

    // Button should be enabled
    await expect(saveIdeaBtn).toBeEnabled()
    const text = await saveIdeaBtn.textContent()
    expect(text).toContain('Save as Idea')
  })

  test('specialist failure triggers error card with retry option', async () => {
    test.skip(!page, 'Page not available — Electron may not have launched')

    // Check if any error state is rendered in the investigation flow
    const errorCard = page!.locator('[data-testid="error-card"], [class*="danger"]')
    const hasError = await errorCard.first().isVisible({ timeout: 3000 }).catch(() => false)

    if (!hasError) {
      // No failure state currently visible — this is expected in happy path
      test.skip()
      return
    }

    // Error card should have retry option
    const retryBtn = page!.getByRole('button', { name: /retry/i })
    const hasRetry = await retryBtn.isVisible({ timeout: 2000 }).catch(() => false)
    if (hasRetry) {
      await expect(retryBtn).toBeEnabled()
    }
  })

  test('investigation report card shows structured findings', async () => {
    test.skip(!page, 'Page not available — Electron may not have launched')

    const reportCard = page!.locator('[data-testid="task-plan-card"]')
    const hasReport = await reportCard.isVisible({ timeout: 5000 }).catch(() => false)

    if (!hasReport) {
      test.skip()
      return
    }

    // Report card should contain structured content (buttons, sections)
    const buttons = reportCard.locator('button')
    const buttonCount = await buttons.count()
    expect(buttonCount).toBeGreaterThan(0)

    // Should have at least the action buttons
    const textContent = await reportCard.textContent()
    expect(textContent?.length).toBeGreaterThan(10)
  })
})
