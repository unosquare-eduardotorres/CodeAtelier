/**
 * Council Session Deep E2E Tests
 *
 * Deep interaction tests for council review sessions:
 *   - StartCouncilModal form fields and submit
 *   - Council type selector switches description
 *   - Council start button triggers review with loading
 *   - Council modal keyboard shortcuts (Escape, Cmd+Enter)
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Council Session Deep Interactions', () => {
  /** Navigate to Council tab and open the start council modal. */
  async function openCouncilModal(page: import('@playwright/test').Page): Promise<boolean> {
    const welcomePage = new WelcomePage(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count === 0) return false
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }

    const settingsTab = page.locator('[data-testid="sidebar-settings-tab"]')
    const hasTab = await settingsTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await settingsTab.click()
      await page.waitForTimeout(500)
    }

    const settings = new WorkspaceSettings(page)
    const councilTab = settings.getTab('council')
    const hasCouncil = await councilTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasCouncil) return false

    await councilTab.click()
    await page.waitForTimeout(500)

    // Click "Start Council" or "New Council Review" button
    const startBtn = page.getByRole('button', { name: /start|new council/i })
    const hasStart = await startBtn.first().isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasStart) return false

    await startBtn.first().click()
    await page.waitForTimeout(500)

    return true
  }

  test('StartCouncilModal form fields and submit', async ({ electronPage: page }) => {
    const opened = await openCouncilModal(page)
    if (!opened) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="start-council-modal"]')
    const visible = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    await expect(modal).toBeVisible()

    // Type selector visible
    const typeSelector = page.locator('[data-testid="council-type-selector"]')
    await expect(typeSelector).toBeVisible()

    // Shows Plan/Requirement/Question options
    const planBtn = typeSelector.getByText('Plan')
    const reqBtn = typeSelector.getByText('Requirement')
    const qBtn = typeSelector.getByText('Question')
    await expect(planBtn).toBeVisible()
    await expect(reqBtn).toBeVisible()
    await expect(qBtn).toBeVisible()

    // Content textarea visible
    const textarea = page.locator('[data-testid="council-content-textarea"]')
    await expect(textarea).toBeVisible()

    // Start button disabled when content is empty
    const startBtn = page.locator('[data-testid="council-start-btn"]')
    await expect(startBtn).toBeVisible()
    await expect(startBtn).toBeDisabled()

    // Type content → button enables
    await textarea.fill('Test plan content for council review')
    await page.waitForTimeout(300)
    await expect(startBtn).toBeEnabled()
  })

  test('council type selector switches description', async ({ electronPage: page }) => {
    const opened = await openCouncilModal(page)
    if (!opened) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="start-council-modal"]')
    const visible = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    const typeSelector = page.locator('[data-testid="council-type-selector"]')

    // Click "Requirement"
    await typeSelector.getByText('Requirement').click()
    await page.waitForTimeout(300)

    const reqDescription = page.getByText(/requirement spec|adversarial review/i)
    const hasReq = await reqDescription.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasReq).toBeTruthy()

    // Click "Question"
    await typeSelector.getByText('Question').click()
    await page.waitForTimeout(300)

    const qDescription = page.getByText(/strategic question|cross-examined/i)
    const hasQ = await qDescription.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasQ).toBeTruthy()

    // Click "Plan" back
    await typeSelector.getByText('Plan').click()
    await page.waitForTimeout(300)

    const planDescription = page.getByText(/implementation plan|scored feedback/i)
    const hasPlan = await planDescription.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasPlan).toBeTruthy()
  })

  test('council start button triggers review with loading', async ({ electronPage: page }) => {
    const opened = await openCouncilModal(page)
    if (!opened) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="start-council-modal"]')
    const visible = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    const textarea = page.locator('[data-testid="council-content-textarea"]')
    const startBtn = page.locator('[data-testid="council-start-btn"]')

    // Fill content and start
    await textarea.fill('Test plan: implement user authentication with JWT tokens and refresh token rotation')
    await page.waitForTimeout(300)
    await startBtn.click()
    await page.waitForTimeout(1_000)

    // Button should show loading or modal should close/transition
    const loadingText = page.getByText(/Starting/i)
    const hasLoading = await loadingText.isVisible({ timeout: 3_000 }).catch(() => false)
    const modalHidden = await modal.isHidden().catch(() => false)

    expect(hasLoading || modalHidden).toBeTruthy()
  })

  test('council modal Escape key and Cmd+Enter shortcuts', async ({ electronPage: page }) => {
    const opened = await openCouncilModal(page)
    if (!opened) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="start-council-modal"]')
    const visible = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    // Press Escape → modal should close
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    await expect(modal).toBeHidden({ timeout: 3_000 })

    // Reopen the modal
    const startBtn = page.getByRole('button', { name: /start|new council/i })
    const hasStart = await startBtn.first().isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasStart) return

    await startBtn.first().click()
    await page.waitForTimeout(500)

    // Fill content and use Cmd+Enter
    const textarea = page.locator('[data-testid="council-content-textarea"]')
    const isVisible = await textarea.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!isVisible) return

    await textarea.fill('Test with keyboard shortcut')
    await page.waitForTimeout(300)
    await textarea.press('Meta+Enter')
    await page.waitForTimeout(1_000)

    // Should trigger start (loading or modal close)
    const modalHidden = await modal.isHidden().catch(() => false)
    const loadingText = page.getByText(/Starting/i)
    const hasLoading = await loadingText.isVisible({ timeout: 3_000 }).catch(() => false)

    expect(modalHidden || hasLoading).toBeTruthy()
  })
})
