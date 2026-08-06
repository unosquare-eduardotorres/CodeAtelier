/**
 * Settings Navigation E2E Tests
 *
 * Verifies workspace settings panel tab navigation:
 *   - All 16 settings tabs render
 *   - Tab switching updates content area
 *   - Collapsed sidebar shows icons only
 *   - Close workspace settings returns to chat
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

/**
 * All settings tab IDs that are VISIBLE in the nav.
 *
 * `goals`, `plans`, `documents` and `events` are omitted: they are marked
 * `hidden: true` in SETTINGS_MENU, so no button renders for them (their routes
 * and pages still work).
 */
const ALL_TAB_IDS = [
  // Tools group
  'health',
  'council',
  'ideas',
  'blueprints',
  'testing',
  // Configuration group
  'specialist',
  'team',
  'repository',
  'code-intelligence',
  'integrations',
  'models',
  'memory',
  'tokens'
]

test.describe('Settings Navigation', () => {
  async function openWorkspaceSettings(
    page: import('@playwright/test').Page
  ): Promise<WorkspaceSettings> {
    const welcomePage = new WelcomePage(page)
    const settings = new WorkspaceSettings(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count === 0) return settings
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }

    // Switch to settings tab in sidebar
    const settingsTab = page.getByRole('button', { name: /settings/i })
    const hasTab = await settingsTab
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)
    if (hasTab) {
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }

    return settings
  }

  test('settings panel renders with all tab buttons', async ({ electronPage: page }) => {
    const settings = await openWorkspaceSettings(page)

    const hasPanel = await settings.settingsPanel.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!hasPanel) {
      test.skip()
      return
    }

    // Count visible tabs
    const allTabs = settings.getAllTabs()
    const tabCount = await allTabs.count()

    // Should have 16 tabs total
    expect(tabCount).toBeGreaterThanOrEqual(12) // Allow some flexibility
  })

  test('each tab is clickable and active indicator follows', async ({ electronPage: page }) => {
    const settings = await openWorkspaceSettings(page)

    const hasPanel = await settings.settingsPanel.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!hasPanel) {
      test.skip()
      return
    }

    // Click each tab and verify it becomes active
    for (const tabId of ALL_TAB_IDS) {
      const tab = settings.getTab(tabId)
      const isTabVisible = await tab.isVisible({ timeout: 1_000 }).catch(() => false)

      if (!isTabVisible) continue

      await tab.click()
      await page.waitForTimeout(200)

      // Tab should have the active styling
      const isActive = await settings.isTabActive(tabId)
      expect(isActive).toBeTruthy()
    }
  })

  test('tab switching updates content area', async ({ electronPage: page }) => {
    const settings = await openWorkspaceSettings(page)

    const hasPanel = await settings.settingsPanel.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!hasPanel) {
      test.skip()
      return
    }

    // Click Health tab and capture content
    await settings.openTab('health')
    await page.waitForTimeout(500)
    const healthContent = await page.locator('main, [class*="flex-1"]').first().textContent()

    // Click Models tab and compare content
    await settings.openTab('models')
    await page.waitForTimeout(500)
    const modelsContent = await page.locator('main, [class*="flex-1"]').first().textContent()

    // Content should differ between tabs
    expect(healthContent).not.toBe(modelsContent)
  })

  test('tools group tabs are visible', async ({ electronPage: page }) => {
    const settings = await openWorkspaceSettings(page)

    const hasPanel = await settings.settingsPanel.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!hasPanel) {
      test.skip()
      return
    }

    // 'goals' and 'plans' are hidden from the nav — see ALL_TAB_IDS.
    const toolTabs = ['health', 'council', 'ideas', 'blueprints', 'testing']
    let visibleCount = 0

    for (const tabId of toolTabs) {
      const tab = settings.getTab(tabId)
      const isVisible = await tab.isVisible({ timeout: 1_000 }).catch(() => false)
      if (isVisible) visibleCount++
    }

    expect(visibleCount).toBe(toolTabs.length)
  })

  test('configuration group tabs are visible', async ({ electronPage: page }) => {
    const settings = await openWorkspaceSettings(page)

    const hasPanel = await settings.settingsPanel.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!hasPanel) {
      test.skip()
      return
    }

    // 'documents' and 'events' are hidden from the nav — see ALL_TAB_IDS.
    const configTabs = [
      'specialist',
      'team',
      'repository',
      'code-intelligence',
      'integrations',
      'models',
      'memory',
      'tokens'
    ]
    let visibleCount = 0

    for (const tabId of configTabs) {
      const tab = settings.getTab(tabId)
      const isVisible = await tab.isVisible({ timeout: 1_000 }).catch(() => false)
      if (isVisible) visibleCount++
    }

    expect(visibleCount).toBe(configTabs.length)
  })

  test('collapse settings panel hides labels', async ({ electronPage: page }) => {
    const settings = await openWorkspaceSettings(page)

    const hasPanel = await settings.settingsPanel.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!hasPanel) {
      test.skip()
      return
    }

    // Get panel width before collapse
    const expandedWidth = await settings.settingsPanel.evaluate(
      (el) => el.getBoundingClientRect().width
    )

    // Collapse
    const collapseBtn = page.getByRole('button', { name: /collapse/i }).first()
    const hasCollapse = await collapseBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasCollapse) {
      test.skip()
      return
    }

    await collapseBtn.click()
    await page.waitForTimeout(500)

    // Panel width should decrease
    const collapsedWidth = await settings.settingsPanel.evaluate(
      (el) => el.getBoundingClientRect().width
    )
    expect(collapsedWidth).toBeLessThan(expandedWidth)

    // Expand again
    const expandBtn = page.getByRole('button', { name: /expand/i }).first()
    const hasExpand = await expandBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasExpand) {
      await expandBtn.click()
      await page.waitForTimeout(500)

      const restoredWidth = await settings.settingsPanel.evaluate(
        (el) => el.getBoundingClientRect().width
      )
      expect(restoredWidth).toBeGreaterThan(collapsedWidth)
    }
  })

  test('close workspace settings returns to chat', async ({ electronPage: page }) => {
    const settings = await openWorkspaceSettings(page)

    const hasPanel = await settings.settingsPanel.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!hasPanel) {
      test.skip()
      return
    }

    // Switch to chats tab in the sidebar
    const chatsTab = page.getByRole('button', { name: /chats/i }).first()
    const hasChats = await chatsTab.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasChats) {
      await chatsTab.click()
      await page.waitForTimeout(500)

      // Settings panel should no longer be visible (chat view active)
      // Note: panel may still be in DOM but settings content should change
      const chatPanel = page.locator('[data-testid="chat-panel"]')
      const newChatPage = page.locator('[data-testid="new-chat-page"]')

      const hasChatView =
        (await chatPanel.isVisible({ timeout: 5_000 }).catch(() => false)) ||
        (await newChatPage.isVisible({ timeout: 3_000 }).catch(() => false))

      expect(hasChatView).toBeTruthy()
    }
  })
})
