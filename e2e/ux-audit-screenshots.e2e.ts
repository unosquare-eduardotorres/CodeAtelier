/**
 * UX Audit Screenshot Capture Suite
 *
 * Captures screenshots of every page/view in the Code Atelier Electron app
 * for UX/UI audit analysis.
 *
 * Uses a manual Electron + CDP approach since Playwright's built-in
 * _electron.launch() is incompatible with Electron 41+.
 *
 * Prerequisites:
 *   1. Build the app first: npx electron-vite build
 *   2. Run: npx playwright test e2e/ux-audit-screenshots.e2e.ts
 */
import { test, expect, chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { resolve } from 'path'
import { mkdirSync } from 'fs'

const SCREENSHOT_DIR = resolve(__dirname, 'screenshots')
const ELECTRON_BIN = resolve(
  __dirname,
  '../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
)
const MAIN_ENTRY = resolve(__dirname, '../out/main/index.js')
const CDP_PORT = 19222

/** Helper: take a named screenshot */
async function snap(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: true })
  console.log(`  📸 ${name}.png`)
}

/** Helper: click by aria-label (safe — returns false if not found) */
async function clickLabel(page: Page, label: string): Promise<boolean> {
  const el = page.locator(`[aria-label="${label}"]`).first()
  if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
    await el.click()
    await page.waitForTimeout(600)
    return true
  }
  return false
}

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

test.describe('UX Audit Screenshots', () => {
  let electronProcess: ChildProcess
  let browser: Browser
  let page: Page

  test.beforeAll(() => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
  })

  test.afterAll(async () => {
    if (browser) await browser.close().catch(() => {})
    if (electronProcess && !electronProcess.killed) {
      electronProcess.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 2000))
      if (!electronProcess.killed) electronProcess.kill('SIGKILL')
    }
  })

  test('capture all pages and views for UX audit', async () => {
    // ── Launch Electron with CDP ─────────────────────────────────
    // Spawn Electron using the bootstrap script that sets --remote-debugging-port
    // via app.commandLine.appendSwitch (required for Electron 41+).
    // CRITICAL: Must unset ELECTRON_RUN_AS_NODE to enable full Electron mode.
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE

    electronProcess = spawn(
      ELECTRON_BIN,
      ['-r', resolve(__dirname, 'helpers/electron-bootstrap.js'), MAIN_ENTRY],
      {
        env: { ...env, E2E_CDP_PORT: String(CDP_PORT) },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )

    // Collect output for debugging
    electronProcess.stderr?.on('data', (d) => {
      const msg = d.toString().trim()
      if (msg && !msg.includes('DevTools')) console.log(`  [electron:err] ${msg}`)
    })
    electronProcess.stdout?.on('data', (d) => {
      const msg = d.toString().trim()
      if (msg) console.log(`  [electron] ${msg}`)
    })

    // Wait for CDP to be available
    await waitForCDP(CDP_PORT)
    console.log('  ✅ Electron launched, CDP available')

    // Get the page-level WebSocket URL from /json/list
    let pageWsUrl = ''
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
        const targets = (await resp.json()) as Array<{
          type: string
          webSocketDebuggerUrl: string
          url: string
        }>
        const pageTarget = targets.find((t) => t.type === 'page')
        if (pageTarget) {
          pageWsUrl = pageTarget.webSocketDebuggerUrl
          break
        }
      } catch {
        // Retry
      }
      await new Promise((r) => setTimeout(r, 500))
    }

    if (!pageWsUrl) throw new Error('No page target found in CDP')
    console.log(`  ✅ Found page target: ${pageWsUrl}`)

    // Connect Playwright directly to the page CDP WebSocket
    // (connectOverCDP hangs with Electron's non-standard CDP implementation)
    browser = await chromium.connect(pageWsUrl, { timeout: 30000 })
    const contexts = browser.contexts()
    const context = contexts[0] || (await browser.newContext())
    const pages = context.pages()
    page = pages[0] || (await context.newPage())

    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(3000) // Let initial renders settle

    // ── 1. Initial screen (Welcome Modal or Home) ────────────────
    await snap(page, '01-initial-screen')

    // Check if WelcomeModal is present (first launch with no profile)
    const welcomeModal = page.locator('[role="dialog"]').first()
    const hasWelcomeModal = await welcomeModal.isVisible({ timeout: 2000 }).catch(() => false)

    if (hasWelcomeModal) {
      await snap(page, '01a-welcome-modal')
      // Try to complete the welcome flow
      const nameInput = page.locator('input').first()
      if (await nameInput.isVisible({ timeout: 1000 }).catch(() => false)) {
        await nameInput.fill('Test User')
      }
      // Click an avatar option
      const avatarBtn = page.locator('[data-avatar], .avatar-option, button img').first()
      if (await avatarBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await avatarBtn.click()
        await page.waitForTimeout(300)
      }
      // Submit
      const submitBtn = page
        .getByRole('button', { name: /continue|get started|save|let.*go/i })
        .first()
      if (await submitBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await submitBtn.click()
        await page.waitForTimeout(2000)
      }
    }

    // ── 2. Home Screen (no workspace selected) ───────────────────
    await snap(page, '02-home-screen')

    // ── 3. App Settings Page ─────────────────────────────────────
    if (await clickLabel(page, 'Settings')) {
      await page.waitForTimeout(800)
      await snap(page, '03-app-settings')
      // Toggle back
      await clickLabel(page, 'Settings')
      await page.waitForTimeout(500)
    }

    // ── 4. Try to select a workspace ─────────────────────────────
    let hasWorkspace = false

    // Try data-testid first
    const wsItem = page.locator('[data-testid="workspace-item"]').first()
    if (await wsItem.isVisible({ timeout: 1000 }).catch(() => false)) {
      await wsItem.click()
      await page.waitForTimeout(1500)
      hasWorkspace = true
    }

    if (!hasWorkspace) {
      // Try any clickable element that looks like a workspace
      const wsCard = page
        .locator('button, [role="button"], .cursor-pointer, a')
        .filter({ hasText: /workspace|project|studio/i })
        .first()
      if (await wsCard.isVisible({ timeout: 1000 }).catch(() => false)) {
        await wsCard.click()
        await page.waitForTimeout(1500)
        hasWorkspace = true
      }
    }

    if (!hasWorkspace) {
      // Look for any card-like clickable element on the home screen
      const anyCard = page.locator('.group, [class*="card"], [class*="hover"]').first()
      if (await anyCard.isVisible({ timeout: 1000 }).catch(() => false)) {
        await anyCard.click()
        await page.waitForTimeout(1500)
        hasWorkspace = true
      }
    }

    // ── 5. Chat Panel ────────────────────────────────────────────
    await snap(page, '04-chat-panel')

    // ── 6. Chat Sidebar (always visible with workspace) ──────────
    await snap(page, '05-chat-sidebar')

    // ── 7. Agent Monitor Panel ───────────────────────────────────
    if (await clickLabel(page, 'Show agent panel')) {
      await page.waitForTimeout(800)
      await snap(page, '06-agent-monitor')
      await clickLabel(page, 'Hide agent panel')
      await page.waitForTimeout(400)
    }

    // ── 9. Workspace Settings — all tabs ─────────────────────────
    if (hasWorkspace && (await clickLabel(page, 'Workspace Settings'))) {
      await page.waitForTimeout(800)

      const settingsTabs = [
        { name: 'Workspace', file: '08-ws-general' },
        { name: 'Models', file: '09-ws-models' },
        { name: 'Repository', file: '10-ws-repository' },
        { name: 'Team', file: '11-ws-team' },
        { name: 'Ideas', file: '12-ws-ideas' },
        { name: 'Memory', file: '13-ws-memory' },
        { name: 'Documents', file: '14-ws-documents' },
        { name: 'Tokens', file: '15-ws-tokens' }
      ]

      for (const tab of settingsTabs) {
        const tabBtn = page
          .locator('button, [role="tab"]')
          .filter({ hasText: new RegExp(`^\\s*${tab.name}\\s*$`) })
          .first()
        if (await tabBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await tabBtn.click()
          await page.waitForTimeout(600)
        }
        await snap(page, tab.file)
      }

      // Close workspace settings
      await clickLabel(page, 'Workspace Settings')
      await page.waitForTimeout(500)
    }

    // ── 10. New Conversation Modal (Cmd+N) ───────────────────────
    if (hasWorkspace) {
      await page.keyboard.press('Meta+n')
      await page.waitForTimeout(800)
      await snap(page, '16-new-conversation-modal')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
    }

    // ── 11. Full layout with all panels open ─────────────────────
    await clickLabel(page, 'Show agent panel')
    await page.waitForTimeout(800)
    await snap(page, '17-full-layout-all-panels')

    // ── 12. Home screen (no workspace) ───────────────────────────
    await clickLabel(page, 'Home')
    await page.waitForTimeout(800)
    await snap(page, '18-home-no-workspace')

    console.log('\n  ✅ All screenshots captured in e2e/screenshots/')
  })

  test('capture workspace settings modal in open and closed states', async () => {
    if (!page) {
      test.skip()
      return
    }

    mkdirSync(SCREENSHOT_DIR, { recursive: true })

    // Try to open workspace settings
    const hasSettings = await clickLabel(page, 'Workspace Settings')
    if (hasSettings) {
      await page.waitForTimeout(800)
      await snap(page, 'workspace-settings-modal-open')

      // Close
      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
      await snap(page, 'workspace-settings-modal-closed')
    } else {
      // Capture whatever state we're in
      await snap(page, 'no-workspace-settings-available')
    }

    const buffer = await page.screenshot()
    expect(buffer.length).toBeGreaterThan(0)
  })

  test('capture sidebar collapsed vs expanded layout', async () => {
    if (!page) {
      test.skip()
      return
    }

    mkdirSync(SCREENSHOT_DIR, { recursive: true })

    // Capture current sidebar state
    await snap(page, 'sidebar-default')

    // Try Cmd+B to toggle sidebar
    await page.keyboard.press('Meta+b')
    await page.waitForTimeout(600)
    await snap(page, 'sidebar-toggled')

    // Toggle back
    await page.keyboard.press('Meta+b')
    await page.waitForTimeout(600)
    await snap(page, 'sidebar-restored')

    const buffer = await page.screenshot()
    expect(buffer.length).toBeGreaterThan(0)
  })

  test('capture empty state vs populated state differences', async () => {
    if (!page) {
      test.skip()
      return
    }

    mkdirSync(SCREENSHOT_DIR, { recursive: true })

    // Capture whatever state we're in now
    await snap(page, 'app-current-state')

    // Check for populated vs empty indicators
    const chatPanel = page.locator('[data-testid="chat-panel"]')
    const hasChatPanel = await chatPanel.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasChatPanel) {
      await snap(page, 'populated-chat-panel')
    } else {
      // Home / welcome state
      await snap(page, 'empty-or-welcome-state')
    }

    const buffer = await page.screenshot()
    expect(buffer.length).toBeGreaterThan(0)
  })

  test('capture loading skeleton states during initialization', async () => {
    if (!page) {
      test.skip()
      return
    }

    mkdirSync(SCREENSHOT_DIR, { recursive: true })

    // Look for skeleton/loading indicators
    const skeletons = page.locator('[class*="skeleton"], [class*="animate-pulse"]')
    const skeletonCount = await skeletons.count()

    if (skeletonCount > 0) {
      await snap(page, 'loading-skeletons')
    }

    // Look for spinners
    const spinners = page.locator('[class*="animate-spin"]')
    const spinnerCount = await spinners.count()

    if (spinnerCount > 0) {
      await snap(page, 'loading-spinners')
    }

    // Capture final loaded state
    await snap(page, 'fully-loaded')

    const buffer = await page.screenshot()
    expect(buffer.length).toBeGreaterThan(0)
  })
})
