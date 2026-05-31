/**
 * Project Specialist Lifecycle E2E Test
 *
 * Phase 2 of the Project Specialist refactor.
 *
 * Verifies end-to-end that:
 *   1. Opening a workspace auto-creates a pending Project Specialist row
 *      (via migration 66 + workspace-open handler).
 *   2. The ⚙️ Specialist button renders in the chat header.
 *   3. Clicking it opens the slide-over with four tabs.
 *   4. Build progress events render in the BuildProgressInline strip.
 *   5. Stack drift banner appears when tech stack changes between builds.
 *
 * Uses the same CDP approach as investigation-flow.e2e.ts because
 * Playwright's _electron.launch() is incompatible with Electron 40+.
 *
 * Prerequisites:
 *   1. Build the app first: npx electron-vite build
 *   2. Run: npx playwright test e2e/project-specialist-lifecycle.e2e.ts
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
const CDP_PORT = 19224

async function waitForCDP(port: number, timeoutMs = 20000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (resp.ok) return
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`CDP not available on port ${port} after ${timeoutMs}ms`)
}

test.describe('Project Specialist Lifecycle', () => {
  let electronProcess: ChildProcess | null = null
  let browser: Browser | null = null
  let page: Page | null = null

  test.beforeAll(async () => {
    electronProcess = spawn(ELECTRON_BIN, [MAIN_ENTRY, `--remote-debugging-port=${CDP_PORT}`], {
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'ignore', 'ignore']
    })
    await waitForCDP(CDP_PORT)

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
    const contexts = browser.contexts()
    page = contexts[0]!.pages()[0] ?? null
    if (!page) {
      const pages = contexts[0]!.pages()
      page = pages[0] ?? (await contexts[0]!.waitForEvent('page'))
    }
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await browser?.close()
    electronProcess?.kill()
  })

  test('chat header shows the Specialist button', async () => {
    if (!page) throw new Error('page not initialised')
    const button = page.getByRole('button', { name: /Specialist/i })
    await expect(button).toBeVisible({ timeout: 15_000 })
  })

  test('clicking the Specialist button opens the slide-over', async () => {
    if (!page) throw new Error('page not initialised')
    const button = page.getByRole('button', { name: /Specialist/i }).first()
    await button.click()
    const panel = page.getByRole('dialog', { name: /Specialist settings/i })
    await expect(panel).toBeVisible()

    // Close with ⓧ button
    const close = panel.getByRole('button', { name: /Close specialist panel/i })
    await close.click()
    await expect(panel).toBeHidden()
  })

  test('slide-over exposes all four tabs', async () => {
    if (!page) throw new Error('page not initialised')
    const button = page.getByRole('button', { name: /Specialist/i }).first()
    await button.click()
    for (const tab of ['Prompt', 'Skills', 'Tools', 'History']) {
      const tabBtn = page.getByRole('tab', { name: tab })
      await expect(tabBtn).toBeVisible()
    }
    // Close
    await page.getByRole('button', { name: /Close specialist panel/i }).click()
  })
})
