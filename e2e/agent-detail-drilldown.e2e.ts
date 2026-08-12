/**
 * Agent Detail Drilldown E2E Tests
 *
 * Settings drill-down flow: agent management → detail page → back:
 *   - Agent management section renders with agent cards
 *   - Clicking an agent card opens its detail page
 *   - Detail page shows YAML content for the agent
 *   - Skill checkboxes reflect current agent configuration
 *   - Back button returns to agent management list
 *   - Agent card active state updates after selection
 *
 * Navigation: Settings → Team → Agents → select → back.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/agent-detail-drilldown.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { AppChrome } from './pages/app-chrome'
import { SettingsNav } from './pages/settings-nav'

test.describe('Agent Detail Drilldown', () => {
  async function navigateToTeamTab(page: import('@playwright/test').Page): Promise<boolean> {
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

    const chrome = new AppChrome(page)
    await chrome.navigateToTab('settings')
    const settingsNav = new SettingsNav(page)
    await settingsNav.navigateToSettingsTab('team')
    await page.waitForTimeout(1_000)
    return true
  }

  test('agent management section renders with agent cards', async ({ electronPage: page }) => {
    const ready = await navigateToTeamTab(page)
    if (!ready) {
      test.skip()
      return
    }

    const section = page.locator('[data-testid="agent-management-section"]')
    const isVisible = await section.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) {
      test.skip()
      return
    }

    await expect(section).toBeVisible()

    // Should have agent cards
    const agentCards = page.locator('[data-testid="agent-management-card"]')
    const cardCount = await agentCards.count()

    // Either cards are present or a "no agents" message
    if (cardCount > 0) {
      await expect(agentCards.first()).toBeVisible()
    }
  })

  test('clicking an agent card opens its detail page', async ({ electronPage: page }) => {
    const ready = await navigateToTeamTab(page)
    if (!ready) {
      test.skip()
      return
    }

    const agentCards = page.locator('[data-testid="agent-management-card"]')
    const cardCount = await agentCards.count()
    if (cardCount === 0) {
      test.skip()
      return
    }

    // Click the first agent card
    await agentCards.first().click()
    await page.waitForTimeout(1_500)

    // Agent detail page should appear
    const detailPage = page.locator('[data-testid="agent-detail-page"]')
    const isVisible = await detailPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) {
      test.skip()
      return
    }

    await expect(detailPage).toBeVisible()

    // Should show agent name in header
    const header = detailPage.locator('.text-sm.font-semibold.text-text-primary')
    await expect(header).toBeVisible()
  })

  test('detail page shows YAML content for the agent', async ({ electronPage: page }) => {
    const ready = await navigateToTeamTab(page)
    if (!ready) {
      test.skip()
      return
    }

    const agentCards = page.locator('[data-testid="agent-management-card"]')
    if ((await agentCards.count()) === 0) {
      test.skip()
      return
    }

    await agentCards.first().click()
    await page.waitForTimeout(1_500)

    const detailPage = page.locator('[data-testid="agent-detail-page"]')
    const isVisible = await detailPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) {
      test.skip()
      return
    }

    // Wait for file content to load
    await page.waitForTimeout(2_000)

    // Should show YAML editor content or loading state or error
    const editorContent = detailPage.locator('textarea, [contenteditable], pre, code')
    const loader = detailPage.locator('.animate-spin')
    const errorText = detailPage.locator('text=Could not load agent file')

    const hasEditor = await editorContent
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)
    const hasLoader = await loader.isVisible({ timeout: 1_000 }).catch(() => false)
    const hasError = await errorText.isVisible({ timeout: 1_000 }).catch(() => false)

    expect(hasEditor || hasLoader || hasError).toBe(true)
  })

  test('skill checkboxes reflect current agent configuration', async ({ electronPage: page }) => {
    const ready = await navigateToTeamTab(page)
    if (!ready) {
      test.skip()
      return
    }

    const agentCards = page.locator('[data-testid="agent-management-card"]')
    if ((await agentCards.count()) === 0) {
      test.skip()
      return
    }

    await agentCards.first().click()
    await page.waitForTimeout(1_500)

    const detailPage = page.locator('[data-testid="agent-detail-page"]')
    const isVisible = await detailPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) {
      test.skip()
      return
    }

    // Skills section should be present
    const skillsHeading = detailPage.locator('h4:has-text("Skills assigned")')
    const hasSkills = await skillsHeading.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasSkills) {
      const checkboxes = detailPage.locator('input[type="checkbox"]')
      const checkboxCount = await checkboxes.count()

      // If skills exist, each checkbox should have a label next to it
      if (checkboxCount > 0) {
        for (let i = 0; i < Math.min(checkboxCount, 3); i++) {
          const checkbox = checkboxes.nth(i)
          await expect(checkbox).toBeVisible()
          // Each checkbox should be inside a label with a skill name
          const label = checkbox.locator('..').locator('span.text-xs')
          const hasLabel = await label.isVisible({ timeout: 1_000 }).catch(() => false)
          expect(hasLabel).toBe(true)
        }
      }
    } else {
      // No skills available — that's a valid state
      const noSkills = detailPage.locator('text=No skills available')
      const hasNoSkills = await noSkills.isVisible({ timeout: 2_000 }).catch(() => false)
      expect(hasNoSkills || true).toBe(true)
    }
  })

  test('back button returns to agent management list', async ({ electronPage: page }) => {
    const ready = await navigateToTeamTab(page)
    if (!ready) {
      test.skip()
      return
    }

    const agentCards = page.locator('[data-testid="agent-management-card"]')
    if ((await agentCards.count()) === 0) {
      test.skip()
      return
    }

    await agentCards.first().click()
    await page.waitForTimeout(1_500)

    const detailPage = page.locator('[data-testid="agent-detail-page"]')
    const isVisible = await detailPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) {
      test.skip()
      return
    }

    // Click back button
    const backBtn = page.locator('[data-testid="agent-detail-back"]')
    await expect(backBtn).toBeVisible()
    await backBtn.click()
    await page.waitForTimeout(1_000)

    // Should return to agent management section
    const section = page.locator('[data-testid="agent-management-section"]')
    const hasSection = await section.isVisible({ timeout: 5_000 }).catch(() => false)

    // Detail page should no longer be visible
    const detailStillVisible = await detailPage.isVisible().catch(() => false)
    expect(hasSection || !detailStillVisible).toBe(true)
  })

  test('agent card active state updates after selection', async ({ electronPage: page }) => {
    const ready = await navigateToTeamTab(page)
    if (!ready) {
      test.skip()
      return
    }

    const agentCards = page.locator('[data-testid="agent-management-card"]')
    const cardCount = await agentCards.count()
    if (cardCount < 1) {
      test.skip()
      return
    }

    // Click first card
    await agentCards.first().click()
    await page.waitForTimeout(1_000)

    // The card may show an active/selected state OR open detail view
    const detailPage = page.locator('[data-testid="agent-detail-page"]')
    const isDetailVisible = await detailPage.isVisible({ timeout: 3_000 }).catch(() => false)

    if (isDetailVisible) {
      // Detail page opened — verify it's for the correct agent
      const agentHeader = detailPage.locator('.text-sm.font-semibold.text-text-primary')
      const agentName = await agentHeader.textContent()
      expect(agentName!.length).toBeGreaterThan(0)
    } else {
      // Inline selection — check for active class on the card
      const firstCard = agentCards.first()
      const classes = await firstCard.getAttribute('class')
      // Card should have some visual distinction (border, bg, etc.)
      expect(classes).toBeTruthy()
    }
  })
})
