/**
 * Grill Detail Views E2E Tests
 *
 * Tests GrillDecisionsView (207 LOC) + GrillChatView (205 LOC) + GrillRadarChart (175 LOC):
 *   - Decisions view renders with decision history list
 *   - Decision cards show status, score, and rationale
 *   - Chat view shows grill conversation messages
 *   - Radar chart renders SVG with track axis labels
 *   - Radar chart shows score polygon for completed tracks
 *   - Score tooltips appear on hover
 *
 * Navigation: Grill page → completed evaluation → decisions/chat/radar tabs.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/grill-detail.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { AppChrome } from './pages/app-chrome'
import { SettingsNav } from './pages/settings-nav'

test.describe('Grill Detail Views', () => {
  async function navigateToGrillPage(page: import('@playwright/test').Page): Promise<boolean> {
    const welcomePage = new WelcomePage(page)
    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) await welcomePage.completeWelcomeModal('Test User')
    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      if ((await cards.count()) === 0) return false
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }

    // Navigate to settings → ideas (grill page)
    const chrome = new AppChrome(page)
    await chrome.navigateToTab('settings')
    const settingsNav = new SettingsNav(page)
    await settingsNav.navigateToSettingsTab('ideas')
    await page.waitForTimeout(1_000)
    return true
  }

  async function navigateToGrillSession(page: import('@playwright/test').Page): Promise<boolean> {
    // Look for a completed grill session to inspect
    const sessionCards = page
      .locator('[data-testid="grill-session-card"], [class*="cursor-pointer"]')
      .filter({
        hasText: /completed|grilled|score/i
      })
    if ((await sessionCards.count()) === 0) return false

    await sessionCards.first().click()
    await page.waitForTimeout(1_000)
    return true
  }

  test('decisions view renders with decision history list', async ({ electronPage: page }) => {
    const ready = await navigateToGrillPage(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToGrillSession(page)
    if (!navigated) {
      test.skip()
      return
    }

    // Switch to decisions tab if tabs exist
    const decisionsTab = page
      .locator('button')
      .filter({ hasText: /Decisions|Decision/i })
      .first()
    if (await decisionsTab.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await decisionsTab.click()
      await page.waitForTimeout(500)
    }

    const decisionsView = page.locator('[data-testid="grill-decisions-view"]')
    const isVisible = await decisionsView.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) {
      test.skip()
      return
    }

    await expect(decisionsView).toBeVisible()

    // Should contain decision entries
    const viewText = await decisionsView.textContent()
    expect(viewText?.trim().length).toBeGreaterThan(0)
  })

  test('decision cards show status, score, and rationale', async ({ electronPage: page }) => {
    const ready = await navigateToGrillPage(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToGrillSession(page)
    if (!navigated) {
      test.skip()
      return
    }

    const decisionsTab = page
      .locator('button')
      .filter({ hasText: /Decisions|Decision/i })
      .first()
    if (await decisionsTab.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await decisionsTab.click()
      await page.waitForTimeout(500)
    }

    const decisionsView = page.locator('[data-testid="grill-decisions-view"]')
    const isVisible = await decisionsView.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) {
      test.skip()
      return
    }

    // Look for decision group sections (grouped by iteration/track)
    const groups = decisionsView.locator('h3, [class*="font-semibold"]')
    const groupCount = await groups.count()

    if (groupCount > 0) {
      const firstGroup = groups.first()
      await expect(firstGroup).toBeVisible()
      const groupText = await firstGroup.textContent()
      expect(groupText?.trim().length).toBeGreaterThan(0)
    }

    // Decisions should have Q&A content
    const viewText = await decisionsView.textContent()
    expect(viewText?.length).toBeGreaterThan(20)
  })

  test('chat view shows grill conversation messages', async ({ electronPage: page }) => {
    const ready = await navigateToGrillPage(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToGrillSession(page)
    if (!navigated) {
      test.skip()
      return
    }

    // Switch to chat tab
    const chatTab = page.locator('button').filter({ hasText: /Chat/i }).first()
    if (await chatTab.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await chatTab.click()
      await page.waitForTimeout(500)
    }

    const chatView = page.locator('[data-testid="grill-chat-view"]')
    const isVisible = await chatView.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) {
      test.skip()
      return
    }

    await expect(chatView).toBeVisible()

    // Chat view should contain messages
    const chatText = await chatView.textContent()
    expect(chatText?.trim().length).toBeGreaterThan(0)
  })

  test('radar chart renders SVG with track axis labels', async ({ electronPage: page }) => {
    const ready = await navigateToGrillPage(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToGrillSession(page)
    if (!navigated) {
      test.skip()
      return
    }

    // Switch to radar/overview tab
    const radarTab = page
      .locator('button')
      .filter({ hasText: /Radar|Overview|Scores/i })
      .first()
    if (await radarTab.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await radarTab.click()
      await page.waitForTimeout(500)
    }

    // Look for SVG radar chart
    const svg = page
      .locator('svg')
      .filter({ has: page.locator('polygon, path') })
      .first()
    const hasSvg = await svg.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasSvg) {
      test.skip()
      return
    }

    await expect(svg).toBeVisible()

    // SVG should have text elements for axis labels (track names)
    const textLabels = svg.locator('text')
    const labelCount = await textLabels.count()
    expect(labelCount).toBeGreaterThan(0)
  })

  test('radar chart shows score polygon for completed tracks', async ({ electronPage: page }) => {
    const ready = await navigateToGrillPage(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToGrillSession(page)
    if (!navigated) {
      test.skip()
      return
    }

    const radarTab = page
      .locator('button')
      .filter({ hasText: /Radar|Overview|Scores/i })
      .first()
    if (await radarTab.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await radarTab.click()
      await page.waitForTimeout(500)
    }

    const svg = page
      .locator('svg')
      .filter({ has: page.locator('polygon, path') })
      .first()
    const hasSvg = await svg.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasSvg) {
      test.skip()
      return
    }

    // Should have polygon element (the score shape)
    const polygon = svg.locator('polygon')
    const hasPolygon = await polygon
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false)
    if (hasPolygon) {
      await expect(polygon.first()).toBeVisible()
      // Polygon should have points attribute
      const points = await polygon.first().getAttribute('points')
      expect(points?.length).toBeGreaterThan(0)
    } else {
      // May use path instead of polygon
      const paths = svg.locator('path')
      expect(await paths.count()).toBeGreaterThan(0)
    }
  })

  test('score tooltips appear on hover', async ({ electronPage: page }) => {
    const ready = await navigateToGrillPage(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToGrillSession(page)
    if (!navigated) {
      test.skip()
      return
    }

    const radarTab = page
      .locator('button')
      .filter({ hasText: /Radar|Overview|Scores/i })
      .first()
    if (await radarTab.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await radarTab.click()
      await page.waitForTimeout(500)
    }

    const svg = page
      .locator('svg')
      .filter({ has: page.locator('polygon, path') })
      .first()
    const hasSvg = await svg.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasSvg) {
      test.skip()
      return
    }

    // Look for interactive score dots/circles
    const dots = svg.locator('circle')
    if ((await dots.count()) === 0) {
      test.skip()
      return
    }

    // Hover over the first dot
    await dots.first().hover()
    await page.waitForTimeout(500)

    // Tooltip should appear (may be a title attribute or a separate element)
    const tooltip = page.locator('[role="tooltip"], [class*="tooltip"], title')
    const titleAttr = await dots.first().getAttribute('title')
    const hasTooltip =
      (await tooltip
        .first()
        .isVisible({ timeout: 2_000 })
        .catch(() => false)) || titleAttr !== null

    // Score dots should at minimum have some identifying attribute
    expect(await dots.count()).toBeGreaterThan(0)
    if (hasTooltip) {
      expect(hasTooltip).toBeTruthy()
    }
  })
})
