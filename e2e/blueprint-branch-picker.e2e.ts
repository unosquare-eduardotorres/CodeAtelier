/**
 * Blueprint branch picker E2E — the round trip nothing else exercises.
 *
 * `blueprint:branchOptions` is a new channel with a new preload binding feeding
 * a component that had never been rendered. Unit tests cover the payload
 * shaping, but three seams sit between that function and the user, and every
 * one of them fails silently:
 *
 *   - the channel is registered in the main process under the name the preload
 *     calls (a typo yields a rejected promise the picker renders as a small
 *     "could not read branches" line, not a crash);
 *   - the preload actually exposes `blueprintBranchOptions` on the bridge;
 *   - the picker mounts inside the create form and populates its select from
 *     what came back, rather than showing an empty dropdown forever.
 *
 * The bridge test runs against whatever workspace the harness has open, so it
 * asserts the SHAPE of a real answer rather than fixed branch names — the repo
 * under test is not ours to predict. What it does assert exactly is the failure
 * mode: an unknown workspace must be refused, not answered with an empty list
 * that the picker would render as "this repo has no branches".
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

type TestPage = import('@playwright/test').Page

test.describe('Blueprint branch picker', () => {
  /** Open a workspace and the new-blueprint form. False when none is available. */
  async function navigateToBlueprintInput(page: TestPage): Promise<boolean> {
    const welcomePage = new WelcomePage(page)
    const settings = new WorkspaceSettings(page)

    if (await welcomePage.isWelcomeModalVisible()) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    if (await welcomePage.isVisible()) {
      const cards = welcomePage.getWorkspaceCards()
      if ((await cards.count()) === 0) return false
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }

    // The sidebar testid, not `getByRole('button', { name: /settings/i })` —
    // that also matches the app-level Settings button, which is a different
    // page with no blueprints tab on it. Two sibling specs make exactly this
    // mistake and have been silently skipping ever since.
    const settingsTab = page.locator('[data-testid="sidebar-settings-tab"]')
    if (await settingsTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await settingsTab.click()
      await page.waitForTimeout(500)
    }

    const blueprintsTab = settings.getTab('blueprints')
    if (!(await blueprintsTab.isVisible({ timeout: 3_000 }).catch(() => false))) return false
    await blueprintsTab.click()
    await page.waitForTimeout(500)

    const newBtn = page.getByRole('button', { name: /new blueprint|create/i }).first()
    if (await newBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await newBtn.click()
      await page.waitForTimeout(1_000)
    }

    return page
      .locator('[data-testid="blueprint-input-view"]')
      .isVisible({ timeout: 5_000 })
      .catch(() => false)
  }

  // ── Bridge ─────────────────────────────────────────────────────────────

  test('blueprintBranchOptions answers over the real bridge', async ({ electronPage: page }) => {
    const result = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          api: {
            listWorkspaces: () => Promise<{ id: string }[]>
            blueprintBranchOptions?: (a: { workspaceId: string }) => Promise<unknown>
          }
        }
      ).api

      if (typeof api.blueprintBranchOptions !== 'function') {
        return { exposed: false as const }
      }

      const workspaces = await api.listWorkspaces()
      if (workspaces.length === 0) return { exposed: true as const, workspaces: 0 }

      const options = (await api.blueprintBranchOptions({
        workspaceId: workspaces[0].id
      })) as {
        repoHasCommits: boolean
        currentBranch: string | null
        branches: { name: string; isPrimaryHead: boolean; heldBy: unknown }[]
      }

      // An id no workspace has must be refused. Answering it with an empty list
      // would render as "this repository has no commits yet" — a confident,
      // wrong statement about a repository we never looked at.
      let unknownRejected = false
      try {
        await api.blueprintBranchOptions({ workspaceId: 'e2e-not-a-real-workspace' })
      } catch {
        unknownRejected = true
      }

      return {
        exposed: true as const,
        workspaces: workspaces.length,
        options,
        unknownRejected,
        // The picker marks exactly one branch as the checkout's HEAD, and only
        // when the repo reports one.
        primaryHeadCount: options.branches.filter((b) => b.isPrimaryHead).length
      }
    })

    // The preload binding missing entirely is the one failure worth failing on
    // rather than skipping — it is the whole surface under test.
    expect(result.exposed).toBe(true)

    if (!('options' in result) || !result.options) {
      test.skip()
      return
    }

    expect(typeof result.options.repoHasCommits).toBe('boolean')
    expect(Array.isArray(result.options.branches)).toBe(true)
    expect(result.unknownRejected).toBe(true)

    if (result.options.repoHasCommits) {
      // A repo with commits has at least one branch, and the picker needs a
      // name for every entry or its <option> values are empty strings.
      expect(result.options.branches.length).toBeGreaterThan(0)
      for (const branch of result.options.branches) {
        expect(typeof branch.name).toBe('string')
        expect(branch.name.length).toBeGreaterThan(0)
        expect(typeof branch.isPrimaryHead).toBe('boolean')
      }
      expect(result.primaryHeadCount).toBeLessThanOrEqual(1)
      if (result.options.currentBranch) {
        expect(result.primaryHeadCount).toBe(1)
      }
    } else {
      expect(result.options.branches).toHaveLength(0)
      expect(result.options.currentBranch).toBeNull()
    }
  })

  // ── Picker ─────────────────────────────────────────────────────────────

  test('the picker renders its four modes in the create form', async ({ electronPage: page }) => {
    if (!(await navigateToBlueprintInput(page))) {
      test.skip()
      return
    }

    const inputView = page.locator('[data-testid="blueprint-input-view"]')
    await expect(inputView.getByText('Branch', { exact: true })).toBeVisible({ timeout: 10_000 })

    // "New branch" is the default and must be preselected — a blueprint created
    // without touching this control has to behave exactly as it did before the
    // picker existed.
    for (const label of ['New branch', 'Branch from…', 'Work on…', 'Workspace checkout']) {
      await expect(inputView.getByRole('button', { name: label })).toBeVisible()
    }

    // The spinner must resolve. A picker stuck on "Reading branches…" is what a
    // rejected or never-settled IPC call looks like from the outside.
    await expect(inputView.getByText('Reading branches…')).toHaveCount(0, { timeout: 10_000 })
  })

  test('choosing "Branch from…" reveals a select populated from the repository', async ({
    electronPage: page
  }) => {
    if (!(await navigateToBlueprintInput(page))) {
      test.skip()
      return
    }

    const inputView = page.locator('[data-testid="blueprint-input-view"]')
    const forkButton = inputView.getByRole('button', { name: 'Branch from…' })
    if (!(await forkButton.isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.skip()
      return
    }

    // Disabled means the repo reported no commits, which is a legitimate state
    // with nothing to select from.
    if (await forkButton.isDisabled()) {
      await expect(inputView.getByText(/no commits yet/i)).toBeVisible()
      return
    }

    await forkButton.click()
    await page.waitForTimeout(500)

    const select = inputView.locator('select')
    await expect(select).toBeVisible({ timeout: 5_000 })

    // The placeholder plus at least one real branch. Placeholder alone is the
    // exact symptom of the round trip failing quietly.
    const options = select.locator('option')
    expect(await options.count()).toBeGreaterThan(1)
    await expect(options.first()).toHaveText(/Choose a base branch/i)

    const secondValue = await options.nth(1).getAttribute('value')
    expect(secondValue).toBeTruthy()
  })
})
