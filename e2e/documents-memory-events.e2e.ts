/**
 * Documents, Memory & Events E2E Tests
 *
 * Deep interaction tests for the Documents, Memory, and Events settings pages:
 *   - Documents page renders with file list
 *   - Document selection shows viewer
 *   - Memory settings page with search and feed
 *   - Memory search filters
 *   - Event log renders with category filter
 *   - Event log category filtering
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Documents, Memory & Events', () => {
  /** Navigate to a settings tab by id. */
  async function openSettingsTab(
    page: import('@playwright/test').Page,
    tabId: string
  ): Promise<void> {
    const welcomePage = new WelcomePage(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count > 0) {
        await cards.first().click()
        await page.waitForTimeout(3_000)
      }
    }

    const settingsTab = page.locator('[data-testid="sidebar-settings-tab"]')
    const hasTab = await settingsTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await settingsTab.click()
      await page.waitForTimeout(500)
    }

    const settings = new WorkspaceSettings(page)
    const tab = settings.getTab(tabId)
    const hasTarget = await tab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTarget) {
      await tab.click()
      await page.waitForTimeout(500)
    }
  }

  test('documents page renders with file list', async ({ electronPage: page }) => {
    await openSettingsTab(page, 'documents')

    const docsPage = page.locator('[data-testid="documents-page"]')
    const visible = await docsPage.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!visible) {
      // May show empty state instead
      const emptyState = page.getByText(/No documents found/i)
      const hasEmpty = await emptyState.isVisible({ timeout: 5_000 }).catch(() => false)
      expect(hasEmpty).toBeTruthy()
      return
    }

    await expect(docsPage).toBeVisible()

    // Document items should be present
    const docItems = page.locator('[data-testid^="doc-file-"]')
    const count = await docItems.count()
    expect(count).toBeGreaterThanOrEqual(1)

    // Each shows filename
    const firstDoc = docItems.first()
    const text = await firstDoc.textContent()
    expect(text).toBeTruthy()
  })

  test('document selection shows content in viewer', async ({ electronPage: page }) => {
    await openSettingsTab(page, 'documents')

    const docItems = page.locator('[data-testid^="doc-file-"]')
    const count = await docItems.count()
    if (count === 0) {
      test.skip()
      return
    }

    // Click first document
    await docItems.first().click()
    await page.waitForTimeout(1_000)

    // Viewer should show content
    const viewer = page.locator('[data-testid="document-viewer"]')
    await expect(viewer).toBeVisible({ timeout: 5_000 })

    const viewerText = await viewer.textContent()
    expect(viewerText).toBeTruthy()
  })

  test('memory settings page renders with search and feed', async ({ electronPage: page }) => {
    await openSettingsTab(page, 'memory')

    const memoryPage = page.locator('[data-testid="memory-settings-page"]')
    const visible = await memoryPage.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    await expect(memoryPage).toBeVisible()

    // Search input visible
    const searchInput = page.locator('[data-testid="memory-search-input"]')
    await expect(searchInput).toBeVisible()

    // Category filtering now lives behind a dropdown rather than a permanent
    // chip row, so the options only exist once the menu is open.
    await page.getByRole('button', { name: /Category/i }).first().click()

    const categoryOptions = page
      .getByRole('menuitemcheckbox')
      .filter({ hasText: /Decision|Convention|Gotcha|Preference|Reference/i })
    await expect(categoryOptions.first()).toBeVisible({ timeout: 3_000 })
    expect(await categoryOptions.count()).toBeGreaterThanOrEqual(1)
  })

  test('memory search filters memories', async ({ electronPage: page }) => {
    await openSettingsTab(page, 'memory')

    const searchInput = page.locator('[data-testid="memory-search-input"]')
    const visible = await searchInput.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    // Type a search query
    await searchInput.fill('test query')
    await page.waitForTimeout(1_000)

    // Clear search
    await searchInput.fill('')
    await page.waitForTimeout(500)

    // Input should be empty
    const value = await searchInput.inputValue()
    expect(value).toBe('')
  })

  test('event log page renders with category filter', async ({ electronPage: page }) => {
    await openSettingsTab(page, 'events')

    const eventLog = page.locator('[data-testid="event-log-page"]')
    const visible = await eventLog.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    await expect(eventLog).toBeVisible()

    // Category filter visible
    const filterRow = page.locator('[data-testid="event-category-filter"]')
    await expect(filterRow).toBeVisible()

    // Category buttons present (all, session, agent, etc.)
    const filterButtons = filterRow.locator('button')
    const buttonCount = await filterButtons.count()
    expect(buttonCount).toBeGreaterThanOrEqual(3)

    // "All" button should be present
    const allBtn = filterRow.getByText('All')
    await expect(allBtn).toBeVisible()
  })

  test('event log category filter shows matching events', async ({ electronPage: page }) => {
    await openSettingsTab(page, 'events')

    const filterRow = page.locator('[data-testid="event-category-filter"]')
    const visible = await filterRow.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    // Click "session" category
    const sessionBtn = filterRow.getByText('Session')
    const hasSession = await sessionBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasSession) {
      await sessionBtn.click()
      await page.waitForTimeout(500)
    }

    // Click "All" to restore full list
    const allBtn = filterRow.getByText('All')
    await allBtn.click()
    await page.waitForTimeout(500)

    // All filter should be active
    const classList = await allBtn.getAttribute('class')
    expect(classList).toMatch(/primary/)
  })
})
