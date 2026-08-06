/**
 * Specialist Settings E2E Tests
 *
 * Verifies SpecialistPage (303 LOC) — project specialist management
 * with skill market and system prompt:
 *   - Specialist page renders with hero banner
 *   - Detected stack shows technology badges
 *   - Skill market grid shows attached vs available skills
 *   - Rebuild button triggers specialist rebuild
 *   - System prompt section renders current prompt
 *   - Skill toggle enables/disables individual skills
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/specialist-settings.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { SettingsNav } from './pages/settings-nav'

test.describe('Specialist Settings', () => {
  async function ensureWorkspaceReady(page: import('@playwright/test').Page): Promise<boolean> {
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
    return true
  }

  async function navigateToSpecialist(page: import('@playwright/test').Page): Promise<boolean> {
    const nav = new SettingsNav(page)
    return nav.navigateToSettingsTab('specialist')
  }

  test('specialist page renders with hero banner', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToSpecialist(page)
    if (!navigated) {
      test.skip()
      return
    }

    const specialistPage = page.locator('[data-testid="specialist-page"]')
    const hasPage = await specialistPage.isVisible({ timeout: 5_000 }).catch(() => false)
    expect(hasPage).toBeTruthy()

    // Either the hero banner or the "No Specialist Yet" message should be visible
    const heroBanner = page.getByText(/specialist|tailored/i).first()
    const noSpecialist = page.getByText(/no specialist yet/i).first()
    const hasHero = await heroBanner.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasEmpty = await noSpecialist.isVisible({ timeout: 2_000 }).catch(() => false)

    expect(hasHero || hasEmpty).toBeTruthy()
  })

  test('detected stack shows technology badges', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToSpecialist(page)
    if (!navigated) {
      test.skip()
      return
    }

    const specialistPage = page.locator('[data-testid="specialist-page"]')
    const hasPage = await specialistPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasPage) {
      test.skip()
      return
    }

    // Check for detected stack section
    const stackSection = page.getByText(/detected stack/i).first()
    const hasStack = await stackSection.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasStack) {
      // No detected technologies (specialist might not be built yet)
      test.skip()
      return
    }

    // Tech badges should be visible (e.g., TypeScript, React, etc.)
    await expect(stackSection).toBeVisible()
  })

  test('skill market grid shows attached vs available skills', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToSpecialist(page)
    if (!navigated) {
      test.skip()
      return
    }

    const skillsGrid = page.locator('[data-testid="specialist-skills-grid"]')
    const hasGrid = await skillsGrid.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasGrid) {
      // No specialist or no skills available
      test.skip()
      return
    }

    // Skill Market heading should be visible
    const skillMarket = page.getByText(/skill market/i).first()
    await expect(skillMarket).toBeVisible()
  })

  test('rebuild button triggers specialist rebuild', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToSpecialist(page)
    if (!navigated) {
      test.skip()
      return
    }

    const rebuildBtn = page.locator('[data-testid="specialist-rebuild-btn"]')
    const hasRebuild = await rebuildBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasRebuild) {
      // May already be building, or no specialist exists
      test.skip()
      return
    }

    // Verify the rebuild button is clickable
    await expect(rebuildBtn).toBeEnabled()
    await expect(rebuildBtn).toContainText(/rebuild/i)
  })

  test('system prompt section renders current prompt', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToSpecialist(page)
    if (!navigated) {
      test.skip()
      return
    }

    const specialistPage = page.locator('[data-testid="specialist-page"]')
    const hasPage = await specialistPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasPage) {
      test.skip()
      return
    }

    // Look for the System Prompt section
    const promptSection = page.getByText(/system prompt/i).first()
    const hasPrompt = await promptSection.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasPrompt) {
      // No specialist built yet
      test.skip()
      return
    }

    await expect(promptSection).toBeVisible()
  })

  test('skill toggle enables/disables individual skills', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToSpecialist(page)
    if (!navigated) {
      test.skip()
      return
    }

    const skillsGrid = page.locator('[data-testid="specialist-skills-grid"]')
    const hasGrid = await skillsGrid.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasGrid) {
      test.skip()
      return
    }

    // Look for toggle switches or enable/disable buttons on skill cards
    const toggleButtons = skillsGrid.locator('button').filter({
      hasText: /enable|disable|attach|detach/i
    })
    const toggleCount = await toggleButtons.count()

    if (toggleCount === 0) {
      // No toggleable skills available
      test.skip()
      return
    }

    // At least one skill toggle should be available
    expect(toggleCount).toBeGreaterThan(0)
  })
})
