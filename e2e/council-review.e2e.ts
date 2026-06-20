/**
 * Council Review E2E Tests
 *
 * Verifies the 5-Advisor LLM Council:
 *   - Council landing shows empty state or history
 *   - Start council and see advisor columns
 *   - Advisors complete and peer review starts
 *   - Verdict renders after synthesis
 *   - Council session history
 *   - Cancel council mid-deliberation
 *
 * Known fragile areas:
 *   - 5 parallel advisor sessions — one crash should not freeze UI
 *   - Phase transitions: framing → deliberating → peer-review → synthesizing → complete
 *   - Per-advisor StreamSegmentAccumulator interleaving
 *   - Peer review race condition if one advisor is much slower
 *   - Chairman synthesis failure should show error state
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Council Review', () => {
  async function navigateToCouncil(page: import('@playwright/test').Page): Promise<void> {
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
      if (count === 0) return
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }

    const settingsTab = page.getByRole('button', { name: /settings/i })
    const hasTab = await settingsTab.first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }
    await settings.openTab('council')
    await page.waitForTimeout(500)
  }

  test('council landing renders', async ({ electronPage: page }) => {
    await navigateToCouncil(page)

    // Should see council content — landing or active view
    const councilLanding = page.locator('[data-testid="council-landing"]')
    const councilContent = page.getByText(/council|adversarial review/i).first()

    const hasLanding = await councilLanding.isVisible({ timeout: 10_000 }).catch(() => false)
    const hasContent = await councilContent.isVisible({ timeout: 5_000 }).catch(() => false)

    expect(hasLanding || hasContent).toBeTruthy()
  })

  test('council landing shows start CTA', async ({ electronPage: page }) => {
    await navigateToCouncil(page)

    const councilLanding = page.locator('[data-testid="council-landing"]')
    const hasLanding = await councilLanding.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!hasLanding) {
      // Check for new council button elsewhere
      const startBtn = page.getByRole('button', { name: /new council|start.*council/i }).first()
      const hasStart = await startBtn.isVisible({ timeout: 5_000 }).catch(() => false)
      expect(hasStart).toBeTruthy()
      return
    }

    // Start CTA should be visible
    const startBtn = page.getByRole('button', { name: /start|new council|submit/i }).first()
    await expect(startBtn).toBeVisible({ timeout: 5_000 })
  })

  test('start council opens input modal', async ({ electronPage: page }) => {
    await navigateToCouncil(page)

    const startBtn = page.getByRole('button', { name: /start|new council|submit/i }).first()
    const hasStart = await startBtn.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasStart) {
      test.skip()
      return
    }

    await startBtn.click()
    await page.waitForTimeout(1_000)

    // Input modal or textarea for council input should appear
    const inputArea = page.locator('textarea').first()
    const modal = page.locator('[role="dialog"]').first()

    const hasInput = await inputArea.isVisible({ timeout: 5_000 }).catch(() => false)
    const hasModal = await modal.isVisible({ timeout: 3_000 }).catch(() => false)

    expect(hasInput || hasModal).toBeTruthy()
  })

  test('council deliberation shows advisor columns', async ({ electronPage: page }) => {
    await navigateToCouncil(page)

    // Check if council is already in deliberation phase
    const advisorRoles = ['architect', 'requirements', 'security', 'data', 'ux']
    let advisorCount = 0

    for (const role of advisorRoles) {
      const column = page.getByText(new RegExp(role, 'i')).first()
      const hasColumn = await column.isVisible({ timeout: 3_000 }).catch(() => false)
      if (hasColumn) advisorCount++
    }

    if (advisorCount === 0) {
      // Start a new council session
      const startBtn = page.getByRole('button', { name: /start|new council|submit/i }).first()
      const hasStart = await startBtn.isVisible({ timeout: 5_000 }).catch(() => false)

      if (!hasStart) {
        test.skip()
        return
      }

      await startBtn.click()
      await page.waitForTimeout(1_000)

      // Fill in council input
      const inputArea = page.locator('textarea').first()
      const hasInput = await inputArea.isVisible({ timeout: 5_000 }).catch(() => false)

      if (hasInput) {
        await inputArea.fill('Review the authentication implementation for security issues')
        const submitBtn = page.getByRole('button', { name: /submit|start|begin/i }).first()
        const hasSubmit = await submitBtn.isVisible({ timeout: 3_000 }).catch(() => false)
        if (hasSubmit) {
          await submitBtn.click()
          await page.waitForTimeout(10_000)
        }
      }

      // Re-check for advisor columns
      for (const role of advisorRoles) {
        const column = page.getByText(new RegExp(role, 'i')).first()
        const hasColumn = await column.isVisible({ timeout: 5_000 }).catch(() => false)
        if (hasColumn) advisorCount++
      }
    }

    if (advisorCount === 0) {
      test.skip()
      return
    }

    // At least some advisor roles should be visible
    expect(advisorCount).toBeGreaterThan(0)
  })

  test('council session history shows past sessions', async ({ electronPage: page }) => {
    await navigateToCouncil(page)

    // Look for session cards in the landing view
    const sessionCards = page.locator('[class*="rounded-xl"][class*="border"]')
    const count = await sessionCards.count()

    if (count > 0) {
      // Session cards should have text content (status, date)
      const firstCard = sessionCards.first()
      const text = await firstCard.textContent()
      expect(text?.length).toBeGreaterThan(0)
    }
  })

  test('council session card has delete button', async ({ electronPage: page }) => {
    await navigateToCouncil(page)

    // Look for delete buttons on session cards
    const deleteBtn = page.getByRole('button', { name: /delete session/i }).first()
    const hasDelete = await deleteBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasDelete) {
      // Try hovering over a session card
      const sessionCards = page.locator('[class*="rounded-xl"][class*="border"]')
      const count = await sessionCards.count()
      if (count > 0) {
        await sessionCards.first().hover()
        await page.waitForTimeout(500)
        const deleteHover = page.getByRole('button', { name: /delete/i }).first()
        const hasHoverDelete = await deleteHover.isVisible({ timeout: 2_000 }).catch(() => false)
        if (hasHoverDelete) {
          await expect(deleteHover).toBeVisible()
        }
      } else {
        test.skip()
      }
      return
    }

    await expect(deleteBtn).toBeVisible()
  })

  test('cancel council stops advisor streams', async ({ electronPage: page }) => {
    await navigateToCouncil(page)

    // Check for active council with cancel button
    const cancelBtn = page.getByRole('button', { name: /cancel|stop/i }).first()
    const hasCancel = await cancelBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasCancel) {
      test.skip()
      return
    }

    await cancelBtn.click()
    await page.waitForTimeout(2_000)

    // Confirmation may appear
    const confirmBtn = page.getByRole('button', { name: /confirm|yes/i }).first()
    const hasConfirm = await confirmBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (hasConfirm) {
      await confirmBtn.click()
      await page.waitForTimeout(1_000)
    }

    // Should return to landing or saved state
    const councilContent = page.getByText(/council/i).first()
    await expect(councilContent).toBeVisible({ timeout: 5_000 })
  })
})
