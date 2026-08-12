/**
 * Shared Playwright + Electron CDP Fixture
 *
 * Extracts the ~50 lines of CDP boilerplate that every E2E test repeats:
 *   1. Spawns Electron with -r bootstrap.js (sets --remote-debugging-port)
 *   2. Waits for CDP /json/list to expose a page target
 *   3. Connects Playwright via chromium.connect(wsUrl)
 *   4. Exposes a ready `electronPage` to every test
 *   5. Auto-teardown: browser.close() + process.kill()
 *
 * Compatible with Electron 41+ (no --remote-debugging-port CLI flag).
 *
 * Usage:
 *   import { test, expect } from './helpers/electron-fixture'
 *   test('my test', async ({ electronPage }) => { ... })
 */
import { test as base, chromium, expect } from '@playwright/test'
import type { Page, Browser } from '@playwright/test'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { resolve } from 'path'

// ── Constants ────────────────────────────────────────────────────────

const ELECTRON_BIN = resolve(
  __dirname,
  '../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
)
const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const BOOTSTRAP = resolve(__dirname, 'electron-bootstrap.js')
const BASE_CDP_PORT = 19222

// ── Types ────────────────────────────────────────────────────────────

/**
 * Both of these are worker-scoped: one Electron process and one CDP port are
 * shared by every test a worker runs. They therefore belong in extend()'s
 * SECOND type parameter -- Playwright types the first as test-scoped, so
 * declaring them there while passing { scope: 'worker' } does not typecheck.
 */
interface ElectronWorkerFixtures {
  electronPage: Page
  cdpPort: number
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Wait for CDP /json/list to return a page-level target. */
async function waitForPageWsUrl(port: number, timeoutMs = 25_000): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = (await resp.json()) as Array<{
        type: string
        webSocketDebuggerUrl: string
        url: string
      }>
      const pageTarget = targets.find((t) => t.type === 'page')
      if (pageTarget?.webSocketDebuggerUrl) {
        return pageTarget.webSocketDebuggerUrl
      }
    } catch {
      // CDP not ready yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`No CDP page target on port ${port} after ${timeoutMs}ms`)
}

// ── Fixture ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export const test = base.extend<{}, ElectronWorkerFixtures>({
  // Per-worker CDP port to avoid conflicts when running in parallel
  cdpPort: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      await use(BASE_CDP_PORT + workerInfo.workerIndex)
    },
    { scope: 'worker' }
  ],

  electronPage: [
    async ({ cdpPort }, use) => {
      let electronProcess: ChildProcess | null = null
      let browser: Browser | null = null

      try {
        // Strip ELECTRON_RUN_AS_NODE so Electron runs in full GUI mode
        const env: Record<string, string> = {}
        for (const [k, v] of Object.entries(process.env)) {
          if (k !== 'ELECTRON_RUN_AS_NODE' && v !== undefined) {
            env[k] = v
          }
        }
        env.NODE_ENV = 'test'
        env.E2E_CDP_PORT = String(cdpPort)

        // When CLAUDE_SHIM_DIR is set, prepend it to PATH so the shim
        // intercepts `spawn('claude')` in cli-executor.ts.
        if (process.env.CLAUDE_SHIM_DIR) {
          const shimDir = resolve(__dirname, '../../', process.env.CLAUDE_SHIM_DIR)
          env.PATH = `${shimDir}:${env.PATH ?? ''}`
          // Absolute, so main can re-prepend it after buildEnvWithPath()'s own
          // /usr/local/bin prepends — otherwise a real `claude` install wins and
          // the "shim" test quietly exercises the live CLI.
          env.CLAUDE_SHIM_DIR = shimDir
        }

        // Spawn Electron with CDP port.
        // Electron 42+ ignores app.commandLine.appendSwitch for --remote-debugging-port
        // when called from a -r preload, so pass it directly on the CLI.
        electronProcess = spawn(
          ELECTRON_BIN,
          [`--remote-debugging-port=${cdpPort}`, '-r', BOOTSTRAP, MAIN_ENTRY],
          { env, stdio: ['pipe', 'pipe', 'pipe'] }
        )

        // Forward stderr for debugging (suppress noisy DevTools lines)
        electronProcess.stderr?.on('data', (d: Buffer) => {
          const msg = d.toString().trim()
          if (msg && !msg.includes('DevTools listening')) {
            console.log(`  [electron:err] ${msg.substring(0, 300)}`)
          }
        })

        // Wait for CDP to become available on the debugging port
        await waitForPageWsUrl(cdpPort)

        // Connect Playwright via CDP.
        // Electron 42+ requires connectOverCDP (chromium.connect expects a
        // Playwright server, not a raw CDP endpoint).
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, {
          timeout: 30_000
        })
        const contexts = browser.contexts()
        const context = contexts[0] || (await browser.newContext())

        // The app shows splash.html first, then navigates to index.html.
        // Wait for the main page (non-splash) to appear.
        let page: Page | null = null
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline) {
          const allPages = context.pages()
          const mainPage = allPages.find((p) => p.url().includes('index.html'))
          if (mainPage) {
            page = mainPage
            break
          }
          // Listen for new pages (splash → main transition creates a new page)
          if (!page) {
            const newPagePromise = context
              .waitForEvent('page', { timeout: 5_000 })
              .catch(() => null)
            const newPage = await newPagePromise
            if (newPage && newPage.url().includes('index.html')) {
              page = newPage
              break
            }
          }
          await new Promise((r) => setTimeout(r, 500))
        }

        if (!page) {
          // Fallback: use whatever page is available
          const fallbackPages = context.pages()
          page = fallbackPages[fallbackPages.length - 1] || (await context.newPage())
        }

        // Wait for DOM + initial renders to settle
        await page.waitForLoadState('domcontentloaded')
        await page.waitForTimeout(3_000)

        // Set E2E testing flag so workspace transition animations are skipped.
        // The renderer runs with contextIsolation + sandbox, so process.env is
        // unreachable — this window flag is the only way isE2ETesting() returns true.
        await page.evaluate(() => {
          ;(window as unknown as Record<string, unknown>).__E2E_TESTING__ = true
        })

        // Provide the ready page to the test
        // eslint-disable-next-line react-hooks/rules-of-hooks -- Playwright's fixture `use` callback, not React's `use` hook
        await use(page)
      } finally {
        // ── Teardown ─────────────────────────────────────────────
        if (browser) {
          await browser.close().catch(() => {})
        }
        if (electronProcess && !electronProcess.killed) {
          electronProcess.kill('SIGTERM')
          await new Promise((r) => setTimeout(r, 2_000))
          if (!electronProcess.killed) {
            electronProcess.kill('SIGKILL')
          }
        }
      }
    },
    { scope: 'worker', timeout: 60_000 }
  ]
})

export { expect }
