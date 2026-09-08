/**
 * Verification depth + testability ledger E2E — offline, no shim.
 *
 * The feature this covers exists because UI was shipped unwired and untested.
 * Shipping ITS OWN ui untested would be the same mistake twice, so this spec
 * drives the two surfaces a user actually touches:
 *
 *   1. the depth selector on the creation form — renders, switches, and the
 *      caveat text (what this level still does not prove) follows the choice
 *   2. the depth badge + caveat on the detail view of a blueprint created at
 *      depth `e2e` — before this, the depth was visible ONLY in the creation
 *      form, so a finished run never said which level of proof "complete"
 *      referred to
 *   3. the testability-ledger export button, on the detail view and on the
 *      amber UNPROVEN banner
 *   4. the follow-up-ideas dialog — opened, loaded from main, and closed. This
 *      one IS clickable end to end (no native dialog), so it is clicked.
 *
 * KNOWN LIMIT — the export CLICK is not exercised. The handler opens a native
 * `dialog.showSaveDialog`, and this fixture connects to the RENDERER over raw
 * CDP with no main-process handle to stub it, so a click would park the run on
 * a modal no Playwright API can dismiss. Presence and enablement are asserted
 * here; the Markdown the button writes is pinned by the pure-function tests in
 * `src/shared/__tests__/testability-ledger.test.ts`. This is exactly the class
 * of "could not be tested, and here is the blocker" gap the ledger exists to
 * record — recorded here rather than discovered later.
 *
 * Run:
 *   npx electron-vite build
 *   npx playwright test e2e/blueprint-verification-depth.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import type { Page } from '@playwright/test'
import { WelcomePage } from './pages/welcome-page'
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

test.setTimeout(120_000)

function makeRepoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-verification-depth-'))
  writeFileSync(join(dir, 'README.md'), '# E2E verification depth workspace\n')
  return dir
}

async function createWorkspace(page: Page, name: string, repoPath: string): Promise<string> {
  return page.evaluate(
    async ([n, p]) => {
      const ws = await (window as any).api.createWorkspace({ name: n, repoPath: p })
      return ws.id as string
    },
    [name, repoPath]
  )
}

/** A draft blueprint at a given depth — created over IPC, never started. */
async function createBlueprintAtDepth(
  page: Page,
  workspaceId: string,
  title: string,
  depth: string
): Promise<string> {
  return page.evaluate(
    async ([wsId, t, d]) => {
      const created = (await (window as any).api.blueprintCreate({
        workspaceId: wsId,
        title: t,
        description: 'Verification depth surface probe',
        settingsJson: { verificationDepth: d }
      })) as { id: string }
      return created.id
    },
    [workspaceId, title, depth]
  )
}

/** Reload, pick the workspace, land on the Blueprints page. */
async function openBlueprintsPage(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    ;(window as unknown as Record<string, unknown>).__E2E_TESTING__ = true
  })
  await page.waitForTimeout(3_000)

  const welcomePage = new WelcomePage(page)
  if (await welcomePage.isWelcomeModalVisible()) {
    await welcomePage.completeWelcomeModal('E2E Test')
  }

  const wsItems = page.locator('[data-testid="workspace-item"]')
  if (
    await wsItems
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)
  ) {
    await wsItems.first().click()
    await page.waitForTimeout(3_000)
  }

  const bpNav = page.getByRole('button', { name: /^blueprints$/i })
  if (await bpNav.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await bpNav.click()
    await page.waitForTimeout(800)
  }
  await expect(page.locator('[data-testid="blueprint-page"]')).toBeVisible({ timeout: 15_000 })
}

test.describe('Blueprint verification depth', () => {
  test('the depth selector switches and its caveat follows the choice', async ({
    electronPage: page
  }) => {
    const repoDir = makeRepoDir()
    await createWorkspace(page, 'E2E Depth Selector', repoDir)
    await openBlueprintsPage(page)

    const input = page.locator('[data-testid="blueprint-input-view"]')
    await expect(input).toBeVisible({ timeout: 15_000 })

    const standard = input.locator('[data-testid="verification-depth-standard"]')
    const e2e = input.locator('[data-testid="verification-depth-e2e"]')
    await expect(standard).toBeVisible()
    await expect(e2e).toBeVisible()

    // Default is `standard` — today's behaviour, unchanged for anyone who
    // never touches the control.
    await expect(standard).toHaveAttribute('aria-checked', 'true')
    await expect(e2e).toHaveAttribute('aria-checked', 'false')

    // The caveat is the point of the control: it names what the SELECTED level
    // still does not prove.
    await expect(input.getByText(/does not prove the app runs/i)).toBeVisible()

    await e2e.click()
    await expect(e2e).toHaveAttribute('aria-checked', 'true')
    await expect(standard).toHaveAttribute('aria-checked', 'false')
    await expect(input.getByText(/needs an e2e command/i)).toBeVisible()
  })

  test('a blueprint created at depth e2e shows its depth on the detail view', async ({
    electronPage: page
  }) => {
    const repoDir = makeRepoDir()
    const workspaceId = await createWorkspace(page, 'E2E Depth Detail', repoDir)
    const title = 'Depth badge probe'
    const blueprintId = await createBlueprintAtDepth(page, workspaceId, title, 'e2e')
    expect(blueprintId).toBeTruthy()

    await openBlueprintsPage(page)

    const item = page.locator('[data-testid="blueprint-page"]').getByText(title).first()
    await expect(item).toBeVisible({ timeout: 15_000 })
    await item.click()
    await page.waitForTimeout(1_500)

    // U2 — the depth the run was verified at, on the run itself.
    const badge = page.locator('[data-testid="blueprint-depth-badge"]').first()
    await expect(badge).toBeVisible({ timeout: 10_000 })
    await expect(badge).toHaveText(/end-to-end/i)

    const caveat = page.locator('[data-testid="blueprint-depth-caveat"]').first()
    await expect(caveat).toBeVisible()
    await expect(caveat).toHaveText(/needs an e2e command/i)

    // U4 — the export affordance. Click deliberately not exercised: see the
    // KNOWN LIMIT note at the top of this file.
    const exportBtn = page.locator('[data-testid="blueprint-export-testability"]')
    await expect(exportBtn).toBeVisible({ timeout: 10_000 })
    await expect(exportBtn).toBeEnabled()
  })

  test('the follow-up ideas dialog opens and round-trips through main', async ({
    electronPage: page
  }) => {
    // Unlike the export, this button opens no native dialog, so its CLICK is
    // coverable end to end — and a button that mounts but is wired to nothing is
    // precisely the defect this whole feature exists to catch. Asserting only
    // that it renders would repeat the mistake.
    const repoDir = makeRepoDir()
    const workspaceId = await createWorkspace(page, 'E2E Followup Ideas', repoDir)
    const title = 'Follow-up ideas probe'
    const blueprintId = await createBlueprintAtDepth(page, workspaceId, title, 'e2e')

    await openBlueprintsPage(page)

    const item = page.locator('[data-testid="blueprint-page"]').getByText(title).first()
    await expect(item).toBeVisible({ timeout: 15_000 })
    await item.click()
    await page.waitForTimeout(1_500)

    const openBtn = page.locator('[data-testid="blueprint-followup-ideas"]')
    await expect(openBtn).toBeVisible({ timeout: 10_000 })
    await openBtn.click()

    const dialog = page.locator('[data-testid="testability-followup-dialog"]')
    await expect(dialog).toBeVisible({ timeout: 10_000 })

    // The loading state must resolve — if the IPC were unwired this would hang
    // on the spinner forever, which is the failure mode worth catching.
    await expect(dialog.getByText(/Collecting what this blueprint never proved/i)).toHaveCount(0, {
      timeout: 15_000
    })

    // A never-started blueprint has proven nothing AND recorded nothing, so the
    // honest list is empty and Create must be unavailable rather than creating
    // an idea about nothing.
    await expect(dialog.getByText(/Nothing unproven was recorded/i)).toBeVisible({
      timeout: 10_000
    })
    await expect(page.locator('[data-testid="testability-followup-create"]')).toBeDisabled()

    // Both new channels answer over the real preload bridge.
    const roundTrip = await page.evaluate(async (id) => {
      const api = (window as any).api
      const entries = await api.blueprintTestabilityEntries({ blueprintId: id })
      const linked = await api.blueprintLinkTestabilityIdeas({ blueprintId: id, entryKeys: [] })
      return { count: entries.entries.length, refs: entries.convertedIdeaRefs, linked }
    }, blueprintId)

    expect(roundTrip.count).toBe(0)
    expect(roundTrip.refs).toEqual({})
    expect(roundTrip.linked.created).toBe(0)
    expect(roundTrip.linked.ideaIds).toEqual([])

    await page.locator('[data-testid="testability-followup-dialog"]').getByText('Cancel').click()
    await expect(dialog).toHaveCount(0)
  })
})
