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

interface ElectronFixtures {
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

export const test = base.extend<ElectronFixtures>({
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

        // Spawn Electron with the bootstrap preload that sets the CDP port
        electronProcess = spawn(ELECTRON_BIN, ['-r', BOOTSTRAP, MAIN_ENTRY], {
          env,
          stdio: ['pipe', 'pipe', 'pipe']
        })

        // Forward stderr for debugging (suppress noisy DevTools lines)
        electronProcess.stderr?.on('data', (d: Buffer) => {
          const msg = d.toString().trim()
          if (msg && !msg.includes('DevTools listening')) {
            console.log(`  [electron:err] ${msg.substring(0, 300)}`)
          }
        })

        // Wait for a page target to appear on the CDP port
        const pageWsUrl = await waitForPageWsUrl(cdpPort)

        // Connect Playwright to the page WebSocket
        // NOTE: use chromium.connect (not connectOverCDP) — the latter hangs
        // with Electron's non-standard CDP implementation.
        browser = await chromium.connect(pageWsUrl, { timeout: 30_000 })
        const contexts = browser.contexts()
        const context = contexts[0] || (await browser.newContext())
        const pages = context.pages()
        const page = pages[0] || (await context.newPage())

        // Wait for DOM + initial renders to settle
        await page.waitForLoadState('domcontentloaded')
        await page.waitForTimeout(3_000)

        // Provide the ready page to the test
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
