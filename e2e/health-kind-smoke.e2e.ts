/**
 * Health kind-scoped smoke — Fullstack E2E Test
 *
 * The other seven `health-*` specs run against the *real* developer profile:
 * `electron-fixture.ts` only creates a throwaway `E2E_USER_DATA` when
 * `CLAUDE_SHIM_DIR` is set, so without it the app boots into
 * `~/Library/Application Support/…`, every workspace directory on the machine is
 * missing, `ensureWorkspaceReady()` returns false, and every test calls
 * `test.skip()`. They are green and prove nothing.
 *
 * This spec seeds its own workspace over IPC — the pattern already used by
 * `blueprint-dag-scheduling`, `blueprint-quality-gates` and
 * `workspace-switch-streaming` — so the audit read paths get exercised for real
 * through the renderer → preload → IPC → repository → SQLite stack after the
 * shared-storage change that gave `audit_results` a `kind` discriminator.
 *
 * WHAT THIS PROVES: the kind-scoped audit read paths still work end-to-end and
 * a fresh workspace reads back as genuinely empty.
 *
 * WHAT IT DOES NOT PROVE: design-vs-code isolation. `DESIGN_START` returns
 * `notImplemented` until P3.1 and no `DESIGN_*` channel reaches the preload
 * until P4.6, so there is no way to create a `kind='design'` row from a running
 * app today. The kind-discriminator sweep belongs to P7.2 and is not claimed
 * here.
 *
 * Run:
 *   npx electron-vite build
 *   CLAUDE_SHIM_DIR=e2e/helpers/claude-shim \
 *     npx playwright test --project=electron --workers=1 e2e/health-kind-smoke.e2e.ts
 *
 * Use `--workers=1`. Parallel workers contend over the CDP endpoint and the
 * fixture fails to attach — that is a harness limitation, not an assertion.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { AppChrome } from './pages/app-chrome'
import { SettingsNav } from './pages/settings-nav'

const IS_SHIM = !!process.env.CLAUDE_SHIM_DIR

test.skip(!IS_SHIM, 'Set CLAUDE_SHIM_DIR=e2e/helpers/claude-shim for an isolated profile')

// Boot + workspace creation + a renderer reload.
test.setTimeout(180_000)

const WORKSPACE_NAME = 'E2E health kind smoke'

const tempDirs: string[] = []
const createdWorkspaceIds: string[] = []

/** A throwaway repo directory for a workspace (main auto-inits git). */
function makeRepoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-health-kind-'))
  writeFileSync(join(dir, 'README.md'), '# E2E health kind smoke workspace\n')
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

/**
 * Reload the renderer so the workspace list picks up the workspace created over
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

/**
 * Return to the welcome screen — the app's workspace-switch surface.
 *
 * Required even on a fresh profile: after the reload the app restores the most
 * recent workspace and boots straight into it, so there is no card list on
 * screen until we navigate home.
 */
async function goHome(page: Page): Promise<void> {
  const homeBtn = page.locator('[aria-label="Home"]')
  if (await homeBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await homeBtn.click()
    await page.waitForTimeout(1_000)
  }
}

/** Open the seeded workspace by id — never by name, which is not unique. */
async function openWorkspaceCard(page: Page, workspaceId: string): Promise<void> {
  const card = page.locator(`[data-testid="workspace-card"][data-workspace-id="${workspaceId}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await card.click()
  await expect(page.locator('[data-testid="unified-sidebar"]').first()).toBeVisible({
    timeout: 20_000
  })
}

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

test.describe('Health kind-scoped smoke', () => {
  test('a seeded workspace renders Audit Code and reads back as empty', async ({
    electronPage: page
  }) => {
    const welcome = new WelcomePage(page)
    if (await welcome.isWelcomeModalVisible()) {
      await welcome.completeWelcomeModal('E2E Test')
    }

    const workspaceId = await createWorkspace(page, WORKSPACE_NAME, makeRepoDir())
    expect(workspaceId).toBeTruthy()

    await reloadRenderer(page)
    await goHome(page)
    await openWorkspaceCard(page, workspaceId)

    // ── 1. Settings → Audit Code renders without crashing ──
    const chrome = new AppChrome(page)
    await chrome.navigateToTab('settings')
    const settingsNav = new SettingsNav(page)
    expect(await settingsNav.navigateToSettingsTab('health')).toBe(true)

    // A workspace with no audits lands on the history/empty state, so both the
    // page shell and the landing view must be present.
    await expect(page.locator('[data-testid="health-page"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-testid="health-landing"]')).toBeVisible({ timeout: 15_000 })

    // ── 2. auditGetHistory resolves to an empty list (does not throw) ──
    const history = await page.evaluate(
      async (id) => (window as any).api.auditGetHistory({ workspaceId: id }),
      workspaceId
    )
    expect(Array.isArray(history)).toBe(true)
    expect(history).toHaveLength(0)

    // ── 3. auditGetLatest resolves to null (does not throw) ──
    const latest = await page.evaluate(
      async (id) => (window as any).api.auditGetLatest({ workspaceId: id }),
      workspaceId
    )
    expect(latest).toBeNull()
  })
})
