/**
 * Jira Tickets panel E2E tests
 *
 * The panel owns Jira setup as well as browsing, so the path that has to keep
 * working without a Jira instance is the *setup* path: land on the tab, get the
 * connection card, get a credentials form to fill in.
 *
 * Everything that needs real Jira data (search results, ticket detail, comment
 * posting) is guarded and skipped — CI has no Jira site, and a spec that fails
 * for want of credentials teaches nobody anything.
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/jira-tickets.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'
import { AppChrome } from './pages/app-chrome'

test.describe('Jira Tickets panel', () => {
  /** Open a workspace and land on Settings → Jira. Returns false if no workspace. */
  async function navigateToJira(page: import('@playwright/test').Page): Promise<boolean> {
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

    await new AppChrome(page).navigateToTab('settings')
    await page.waitForTimeout(1_000)

    const jiraTab = settings.getTab('jira')
    if (!(await jiraTab.isVisible({ timeout: 3_000 }).catch(() => false))) return false
    await settings.openTab('jira')
    await page.waitForTimeout(500)
    return true
  }

  test('jira tab renders the tickets panel', async ({ electronPage: page }) => {
    if (!(await navigateToJira(page))) {
      test.skip()
      return
    }

    const panel = page.locator('[data-testid="jira-tickets-page"]')
    await expect(panel).toBeVisible({ timeout: 5_000 })
    await expect(panel).toContainText(/jira tickets/i)
  })

  test('setup path is reachable: connection card exposes a credentials form', async ({
    electronPage: page
  }) => {
    if (!(await navigateToJira(page))) {
      test.skip()
      return
    }

    // The card auto-reveals on an unconfigured workspace; on a configured one the
    // toggle brings it back. Either way the setup form must be one click away.
    const card = page.locator('[data-testid="integration-card-jira"]')
    if (!(await card.isVisible({ timeout: 3_000 }).catch(() => false))) {
      await page.locator('[data-testid="jira-connection-toggle"]').click()
      await page.waitForTimeout(300)
    }
    await expect(card).toBeVisible({ timeout: 5_000 })

    // The form lives in the card's expanded body.
    await card.locator('[data-testid="integration-expand-jira"]').click()
    await page.waitForTimeout(300)

    const form = card.locator('[data-testid="integration-credentials-form"]')
    await expect(form).toBeVisible({ timeout: 5_000 })
    expect(await form.locator('input, select').count()).toBeGreaterThan(0)
  })

  test('search box and quick filters render once connected', async ({ electronPage: page }) => {
    if (!(await navigateToJira(page))) {
      test.skip()
      return
    }

    const jqlInput = page.locator('[data-testid="jira-jql-input"]')
    const isConfigured = await jqlInput.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!isConfigured) {
      // No credentials on this machine — the browse half of the panel is hidden
      // by design, and that is asserted rather than skipped past.
      await expect(page.locator('[data-testid="jira-tickets-page"]')).toContainText(
        /connect jira above/i
      )
      test.skip()
      return
    }

    await expect(jqlInput).toHaveValue(/.+/)
    await expect(page.locator('[data-testid="jira-search-submit"]')).toBeVisible()
    await expect(page.getByRole('button', { name: 'My open tickets' })).toBeVisible()
  })

  test('list controls render once connected', async ({ electronPage: page }) => {
    if (!(await navigateToJira(page))) {
      test.skip()
      return
    }

    const controls = page.locator('[data-testid="jira-list-controls"]')
    if (!(await controls.isVisible({ timeout: 3_000 }).catch(() => false))) {
      // Unconfigured machine — the browse half of the panel is hidden by design.
      test.skip()
      return
    }

    // The filter, the sort field and the direction toggle are the three controls
    // that turn "whatever Jira returned" into a queue you can work from.
    await expect(page.locator('[data-testid="jira-filter-input"]')).toBeVisible()
    await expect(page.locator('[data-testid="jira-sort-field"]')).toBeVisible()
    await expect(page.locator('[data-testid="jira-sort-dir"]')).toBeVisible()
    await expect(page.locator('[data-testid="jira-group-toggle"]')).toBeVisible()

    // Sorting is a local operation while the whole result set is loaded, so
    // changing it must not clear the list or raise a search error.
    await page.locator('[data-testid="jira-sort-field"]').selectOption('priority')
    await page.waitForTimeout(500)
    await expect(page.locator('[data-testid="jira-search-error"]')).toHaveCount(0)
  })

  test('project scope control renders once connected', async ({ electronPage: page }) => {
    if (!(await navigateToJira(page))) {
      test.skip()
      return
    }

    const scope = page.locator('[data-testid="jira-scope-controls"]')
    if (!(await scope.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip()
      return
    }

    // One project control, always present. Board and sprint are deliberately
    // absent unless the Agile API answered — Jira Core 404s it.
    await expect(page.locator('[data-testid="jira-project-select"]')).toBeVisible()
    await expect(page.locator('[data-testid="jira-project-select"]')).toContainText(/all projects/i)
  })

  test('filter input narrows the loaded rows without a network round trip', async ({
    electronPage: page
  }) => {
    if (!(await navigateToJira(page))) {
      test.skip()
      return
    }

    const list = page.locator('[data-testid="jira-ticket-list"]')
    if (!(await list.isVisible({ timeout: 5_000 }).catch(() => false))) {
      // No credentials, or a query that returned nothing — either way there are
      // no rows to filter and the assertion would be vacuous.
      test.skip()
      return
    }

    await page.locator('[data-testid="jira-filter-input"]').fill('zzzznomatch')
    await page.waitForTimeout(300)
    await expect(page.locator('[data-testid="jira-tickets-page"]')).toContainText(
      /no loaded ticket matches/i
    )

    await page.locator('[data-testid="jira-filter-input"]').fill('')
    await page.waitForTimeout(300)
    await expect(list).toBeVisible()
  })
})
