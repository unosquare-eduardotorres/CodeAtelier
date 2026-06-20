/**
 * Specialist Build E2E Tests
 *
 * Tests specialist generation, build progress, and skill management:
 *   - Generate specialist modal appears for pending specialist
 *   - Stack drift banner shows when tech stack changes
 *   - Specialist settings page shows skill cards
 *   - Specialist prompt tab shows system prompt
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Specialist Build', () => {
  /**
   * Helper: Ensure workspace is open.
   */
  async function ensureWorkspaceOpen(
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

    return settings
  }

  test('Generate specialist modal appears for pending specialist', async ({ electronPage: page }) => {
    await ensureWorkspaceOpen(page)

    // Look for the generate specialist modal — only appears for pending/no specialist
    const modal = page.locator('[data-testid="generate-specialist-modal"]')
    const isVisible = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!isVisible) {
      // Specialist already built — skip
      test.skip()
      return
    }

    // Modal should show generate/retry button
    const actionBtn = page.locator('[data-testid="generate-specialist-action"]')
    await expect(actionBtn).toBeVisible()
    const btnText = await actionBtn.textContent()
    expect(btnText).toMatch(/Generate Now|Retry|Building/)

    // "Maybe later" dismiss button visible
    const dismissBtn = modal.locator('button', { hasText: /Maybe later|Dismiss/ })
    await expect(dismissBtn).toBeVisible()

    // Close modal
    const closeBtn = modal.locator('button[aria-label="Close"]')
    if (await closeBtn.isEnabled()) {
      await closeBtn.click()
      await page.waitForTimeout(500)
    }
  })

  test('Stack drift banner shows when tech stack changes', async ({ electronPage: page }) => {
    await ensureWorkspaceOpen(page)

    // Look for stack drift banner — only appears when tech stack has changed
    const banner = page.locator('[data-testid="stack-drift-banner"]')
    const isVisible = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!isVisible) {
      // No drift detected — skip
      test.skip()
      return
    }

    // Shows tech change information
    const text = await banner.textContent()
    expect(text?.toLowerCase()).toContain('tech stack')

    // "Rebuild prompt" button visible
    const rebuildBtn = page.locator('[data-testid="stack-drift-rebuild"]')
    await expect(rebuildBtn).toBeVisible()
    await expect(rebuildBtn).toContainText('Rebuild prompt')

    // "Update skills only" button visible
    const skillsBtn = banner.locator('button', { hasText: 'Update skills only' })
    await expect(skillsBtn).toBeVisible()

    // Dismiss (X) button visible
    const dismissBtn = banner.locator('button[aria-label="Dismiss"]')
    await expect(dismissBtn).toBeVisible()
  })

  test('Specialist settings page shows skill cards', async ({ electronPage: page }) => {
    const settings = await ensureWorkspaceOpen(page)

    // Open settings and navigate to specialist tab
    const settingsBtn = page.getByRole('button', { name: 'Settings' })
    if (await settingsBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await settingsBtn.click()
      await page.waitForTimeout(1_000)
    }

    await settings.openTab('specialist')
    await page.waitForTimeout(1_000)

    // Look for skill cards
    const skillCards = page.locator('[data-testid^="skill-card-"]')
    const count = await skillCards.count()

    if (count === 0) {
      // No skills — specialist may not be built
      test.skip()
      return
    }

    // Verify first skill card structure
    const firstCard = skillCards.first()
    await expect(firstCard).toBeVisible()

    // Card should have skill name text
    const nameText = firstCard.locator('h5')
    await expect(nameText).toBeVisible()

    // Card should have toggle/attach action
    const actionBtn = firstCard.locator('button')
    const actionCount = await actionBtn.count()
    expect(actionCount).toBeGreaterThanOrEqual(1)
  })

  test('Specialist prompt tab shows system prompt', async ({ electronPage: page }) => {
    const settings = await ensureWorkspaceOpen(page)

    // Open settings and navigate to specialist tab
    const settingsBtn = page.getByRole('button', { name: 'Settings' })
    if (await settingsBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await settingsBtn.click()
      await page.waitForTimeout(1_000)
    }

    await settings.openTab('specialist')
    await page.waitForTimeout(1_000)

    // Look for Prompt sub-tab
    const promptTab = page.locator('button', { hasText: /^Prompt$/i })
    if (await promptTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await promptTab.click()
      await page.waitForTimeout(500)

      // System prompt preview or edit area should be visible
      const promptPreview = page.locator('pre, textarea, [class*="font-mono"]').first()
      const isShown = await promptPreview.isVisible({ timeout: 3_000 }).catch(() => false)
      if (isShown) {
        const content = await promptPreview.textContent()
        expect(content?.length).toBeGreaterThan(0)
      }

      // Edit button may be visible
      const editBtn = page.locator('button', { hasText: /edit/i })
      if (await editBtn.isVisible().catch(() => false)) {
        await expect(editBtn).toBeVisible()
      }
    } else {
      // Prompt tab not available — specialist not built
      test.skip()
    }
  })
})
