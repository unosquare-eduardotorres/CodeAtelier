/**
 * Design wizard — Fullstack E2E Test
 *
 * Walks the three-step wizard (Brief → Commands → Scope) against a workspace
 * seeded over IPC into a throwaway directory, so every assertion goes through
 * the real renderer → preload → IPC → main stack.
 *
 * Per the convention `health-kind-smoke` documents: `electron-fixture.ts` only
 * creates a throwaway `E2E_USER_DATA` when `CLAUDE_SHIM_DIR` is set. Without it
 * the app boots into the developer profile, no seeded workspace exists, and the
 * spec would skip while reporting coverage the suite does not have — hence the
 * hard `test.skip` below rather than a soft in-test guard.
 *
 * WHAT THIS PROVES: the wizard renders and advances; the brief chips populate
 * the brief; `design:route` always returns a usable preselect (model answer or
 * keyword fallback); the incompatibility matrix disables conflicting cards
 * rather than letting an unrunnable set be assembled; and `design:scopeTree`
 * derives its suggested directory from the real filesystem.
 *
 * WHAT IT DOES NOT PROVE: that a design run produces good findings. Starting a
 * run here would spawn the Impeccable detector and a real agent session — that
 * is P7.4's job, not a wizard test's.
 *
 * Run:
 *   npx electron-vite build
 *   CLAUDE_SHIM_DIR=e2e/helpers/claude-shim \
 *     npx playwright test --project=electron --workers=1 e2e/design-wizard.e2e.ts
 *
 * Use `--workers=1`. Parallel workers contend over the CDP endpoint.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { AppChrome } from './pages/app-chrome'
import { SettingsNav } from './pages/settings-nav'

const IS_SHIM = !!process.env.CLAUDE_SHIM_DIR

test.skip(!IS_SHIM, 'Set CLAUDE_SHIM_DIR=e2e/helpers/claude-shim for an isolated profile')

// Boot + workspace creation + a renderer reload + a routed LLM round trip.
test.setTimeout(240_000)

const WORKSPACE_NAME = 'E2E design wizard'

const tempDirs: string[] = []
const createdWorkspaceIds: string[] = []

/**
 * A throwaway repo whose design-relevant files are concentrated in one
 * directory.
 *
 * The shape matters: `pickSuggestedDir` descends the densest chain only while a
 * child still holds 80% of the workspace's design surface. Four of the five
 * design files live in `src/components`, so the derivation must land there and
 * not stop at `src` — which is exactly the "not the whole project" property
 * P3.7.9 made a requirement.
 */
function makeRepoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-design-'))
  mkdirSync(join(dir, 'src', 'components'), { recursive: true })
  mkdirSync(join(dir, 'src', 'styles'), { recursive: true })

  for (const name of ['Button', 'Card', 'Panel', 'Modal']) {
    writeFileSync(
      join(dir, 'src', 'components', `${name}.tsx`),
      `export default function ${name}(): JSX.Element {\n  return <div className="p-4">${name}</div>\n}\n`
    )
  }
  writeFileSync(join(dir, 'src', 'styles', 'main.css'), ':root { --gap: 8px; }\n')
  // Not design-relevant — proves the extension filter is applied, since it must
  // not appear in any directory count.
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const version = 1\n')
  writeFileSync(join(dir, 'README.md'), '# E2E design wizard workspace\n')

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
 * IPC — `loadWorkspaces()` runs once in the boot effect.
 */
async function reloadRenderer(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    ;(window as unknown as Record<string, unknown>).__E2E_TESTING__ = true
  })
  await page.waitForTimeout(4_000)
  const welcome = new WelcomePage(page)
  if (await welcome.isWelcomeModalVisible()) {
    await welcome.completeWelcomeModal('E2E Test')
  }
}

async function goHome(page: Page): Promise<void> {
  const homeBtn = page.locator('[aria-label="Home"]')
  if (await homeBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await homeBtn.click()
    await page.waitForTimeout(1_000)
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

/** Open Settings → Audit Design for a freshly-seeded workspace. */
async function openDesignTab(page: Page, workspaceId: string): Promise<void> {
  await reloadRenderer(page)
  await goHome(page)
  await openWorkspaceCard(page, workspaceId)

  const chrome = new AppChrome(page)
  await chrome.navigateToTab('settings')
  const settingsNav = new SettingsNav(page)
  expect(await settingsNav.navigateToSettingsTab('design')).toBe(true)
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

test.describe('Design wizard', () => {
  test('brief chip → routed preselect → conflict blocking → derived scope → runnable', async ({
    electronPage: page
  }) => {
    const welcome = new WelcomePage(page)
    if (await welcome.isWelcomeModalVisible()) {
      await welcome.completeWelcomeModal('E2E Test')
    }

    const workspaceId = await createWorkspace(page, WORKSPACE_NAME, makeRepoDir())
    expect(workspaceId).toBeTruthy()

    await openDesignTab(page, workspaceId)

    // ── 1. Landing: a workspace with no runs shows the empty state + CTA ──
    await expect(page.locator('[data-testid="design-page"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-testid="design-landing"]')).toBeVisible({ timeout: 15_000 })

    await page.locator('[data-testid="design-start-btn"]').first().click()
    await expect(page.locator('[data-testid="design-configure"]')).toBeVisible({ timeout: 10_000 })

    // ── 2. Brief step: a catalogue chip populates the textarea ──
    await expect(page.locator('[data-testid="design-brief-step"]')).toBeVisible()
    const chips = page.locator('[data-testid="design-brief-chip"]')
    await expect(chips).toHaveCount(6)

    // The "generic and AI-made" chip is the one the keyword table maps to
    // critique + distill, so the fallback path has a defined expectation.
    const chip = chips.filter({ hasText: /generic/i }).first()
    const chipText = (await chip.textContent())?.trim() ?? ''
    await chip.click()
    await expect(page.locator('[data-testid="design-brief-input"]')).toHaveValue(chipText)

    // ── 3. Commands step: the route always resolves to a usable preselect ──
    await page.locator('[data-testid="design-next-btn"]').click()
    await expect(page.locator('[data-testid="design-cards-step"]')).toBeVisible({ timeout: 10_000 })

    // Model answer or keyword fallback — either way a rationale lands and the
    // wizard is never left waiting. This is the degradation contract, observed
    // end to end rather than stubbed.
    const rationale = page.locator('[data-testid="design-route-rationale"]')
    await expect(rationale).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('[data-testid="design-route-pending"]')).toHaveCount(0)
    const usedFallback = await rationale.getAttribute('data-used-fallback')
    expect(['true', 'false']).toContain(usedFallback)

    // Whatever routed, at least one evaluate card must be selected — refine
    // cards never execute, so a run without one has no pass to attach findings.
    const selectedEvaluate = page.locator(
      '[data-testid="design-command-card"][data-selected="true"]'
    )
    expect(await selectedEvaluate.count()).toBeGreaterThan(0)

    // ── 4. Conflict blocking: bolder and quieter are mutually exclusive ──
    const card = (id: string): ReturnType<Page['locator']> =>
      page.locator(`[data-testid="design-command-card"][data-command-id="${id}"]`)

    // Clear the routed selection first. "generic" routes to critique+distill,
    // and distill already rules out bolder — so without this the pair under test
    // would start blocked by an unrelated card. Deselecting only ever unblocks,
    // so this loop cannot deadlock, and the first click pins the selection
    // against a late route landing.
    const selectedCards = page.locator('[data-testid="design-command-card"][data-selected="true"]')
    for (let guard = 0; (await selectedCards.count()) > 0 && guard < 20; guard++) {
      await selectedCards.first().click()
    }
    await expect(selectedCards).toHaveCount(0)

    await card('bolder').click()
    await expect(card('bolder')).toHaveAttribute('data-selected', 'true')
    await expect(card('quieter')).toHaveAttribute('data-blocked', 'true')
    await expect(card('quieter')).toBeDisabled()

    // An unrunnable set must not be advanceable either.
    await expect(card('distill')).toBeDisabled()

    // Releasing the blocker frees the card again.
    await card('bolder').click()
    await expect(card('quieter')).toHaveAttribute('data-blocked', 'false')
    await expect(card('quieter')).toBeEnabled()

    // ── 5. Scope step: the default is derived, not whole-project ──
    // Next is disabled on an empty selection, so re-arm with an evaluate pass.
    await expect(page.locator('[data-testid="design-next-btn"]')).toBeDisabled()
    await card('critique').click()
    await expect(page.locator('[data-testid="design-next-btn"]')).toBeEnabled()

    await page.locator('[data-testid="design-next-btn"]').click()
    await expect(page.locator('[data-testid="design-scope-step"]')).toBeVisible({ timeout: 10_000 })

    const scopeSelect = page.locator('[data-testid="design-scope-select"]')
    await expect(scopeSelect).toBeVisible({ timeout: 20_000 })
    // 4 of the 5 design files live here; index.ts is filtered out by extension.
    await expect(scopeSelect).toHaveValue('src/components')
    await expect(scopeSelect.locator('option[value="src/components"]')).toHaveText(
      /src\/components \(4 files\)/
    )

    // Whole-project is available, but only as an opt-in that says what it costs.
    await expect(page.locator('[data-testid="design-scope-warning"]')).toHaveCount(0)
    await scopeSelect.selectOption('__project__')
    await expect(page.locator('[data-testid="design-scope-warning"]')).toBeVisible()

    // ── 6. Run is reachable and enabled with a valid selection ──
    const runBtn = page.locator('[data-testid="design-run-btn"]')
    await expect(runBtn).toBeVisible()
    await expect(runBtn).toBeEnabled()
    // Deliberately NOT clicked — starting a run spawns the detector and a real
    // agent session, which is P7.4's gate, not this spec's.
  })

  test('the wizard can be skipped without a brief, and steps back', async ({
    electronPage: page
  }) => {
    const workspaceId = createdWorkspaceIds[0]
    expect(workspaceId, 'the first test seeds the workspace this one reuses').toBeTruthy()

    await openDesignTab(page, workspaceId)
    await page.locator('[data-testid="design-start-btn"]').first().click()
    await expect(page.locator('[data-testid="design-brief-step"]')).toBeVisible({ timeout: 10_000 })

    // With no brief the primary action reads Skip, and no route call is made.
    const next = page.locator('[data-testid="design-next-btn"]')
    await expect(next).toHaveText(/Skip/)
    await next.click()

    await expect(page.locator('[data-testid="design-cards-step"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="design-route-rationale"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="design-route-pending"]')).toHaveCount(0)

    // Back returns to the brief without losing the wizard.
    await page.locator('[data-testid="design-back-btn"]').click()
    await expect(page.locator('[data-testid="design-brief-step"]')).toBeVisible()

    // Back again leaves the wizard entirely, returning to history.
    await page.locator('[data-testid="design-back-btn"]').click()
    await expect(page.locator('[data-testid="design-landing"]')).toBeVisible({ timeout: 10_000 })
  })
})
