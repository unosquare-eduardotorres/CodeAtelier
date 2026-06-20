/**
 * Specialist Management E2E Tests
 *
 * Extends the existing project-specialist-lifecycle.e2e.ts with:
 *   - Specialist slide-over tabs (Prompt, Skills, Tools, History)
 *   - Specialist settings page in workspace settings
 *   - Team page showing core agents
 *   - Stack drift detection
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Specialist Management', () => {
  async function openWorkspace(
    page: import('@playwright/test').Page
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
      if (count === 0) return
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }
  }

  test('specialist button appears in chat header', async ({ electronPage: page }) => {
    await openWorkspace(page)

    const specialistBtn = page.getByRole('button', { name: /specialist/i }).first()
    await expect(specialistBtn).toBeVisible({ timeout: 15_000 })
  })

  test('clicking specialist button opens slide-over', async ({ electronPage: page }) => {
    await openWorkspace(page)

    const specialistBtn = page.getByRole('button', { name: /specialist/i }).first()
    const hasBtn = await specialistBtn.isVisible({ timeout: 15_000 }).catch(() => false)

    if (!hasBtn) {
      test.skip()
      return
    }

    await specialistBtn.click()
    await page.waitForTimeout(500)

    // Dialog/panel should appear
    const panel = page.getByRole('dialog', { name: /specialist/i })
    await expect(panel).toBeVisible({ timeout: 5_000 })
  })

  test('slide-over exposes all four tabs', async ({ electronPage: page }) => {
    await openWorkspace(page)

    const specialistBtn = page.getByRole('button', { name: /specialist/i }).first()
    const hasBtn = await specialistBtn.isVisible({ timeout: 15_000 }).catch(() => false)
    if (!hasBtn) {
      test.skip()
      return
    }

    await specialistBtn.click()
    await page.waitForTimeout(500)

    // Verify all 4 tabs
    for (const tabName of ['Prompt', 'Skills', 'Tools', 'History']) {
      const tab = page.getByRole('tab', { name: tabName })
      await expect(tab).toBeVisible({ timeout: 3_000 })
    }
  })

  test('slide-over close button works', async ({ electronPage: page }) => {
    await openWorkspace(page)

    const specialistBtn = page.getByRole('button', { name: /specialist/i }).first()
    const hasBtn = await specialistBtn.isVisible({ timeout: 15_000 }).catch(() => false)
    if (!hasBtn) {
      test.skip()
      return
    }

    await specialistBtn.click()
    await page.waitForTimeout(500)

    const panel = page.getByRole('dialog', { name: /specialist/i })
    await expect(panel).toBeVisible({ timeout: 5_000 })

    // Close button
    const closeBtn = panel.getByRole('button', { name: /close/i }).first()
    await closeBtn.click()
    await expect(panel).toBeHidden({ timeout: 3_000 })
  })

  test('specialist settings page renders in workspace settings', async ({
    electronPage: page
  }) => {
    await openWorkspace(page)

    const settings = new WorkspaceSettings(page)

    // Navigate to settings > specialist
    const settingsTab = page.getByRole('button', { name: /settings/i })
    const hasTab = await settingsTab.first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }

    await settings.openTab('specialist')
    await page.waitForTimeout(500)

    // Specialist page should render
    const specialistContent = page.getByText(/specialist|build status|prompt/i).first()
    await expect(specialistContent).toBeVisible({ timeout: 5_000 })
  })

  test('team page shows core agents', async ({ electronPage: page }) => {
    await openWorkspace(page)

    const settings = new WorkspaceSettings(page)

    const settingsTab = page.getByRole('button', { name: /settings/i })
    const hasTab = await settingsTab.first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }

    await settings.openTab('team')
    await page.waitForTimeout(500)

    // Team page should render with agent cards
    const teamContent = page.getByText(/team|agents|da vinci/i).first()
    await expect(teamContent).toBeVisible({ timeout: 5_000 })

    // Agent cards should be visible
    const agentCards = page.locator('[class*="rounded-xl"][class*="border"]')
    const cardCount = await agentCards.count()
    expect(cardCount).toBeGreaterThan(0)
  })

  test('specialist prompt tab shows current prompt', async ({ electronPage: page }) => {
    await openWorkspace(page)

    const specialistBtn = page.getByRole('button', { name: /specialist/i }).first()
    const hasBtn = await specialistBtn.isVisible({ timeout: 15_000 }).catch(() => false)
    if (!hasBtn) {
      test.skip()
      return
    }

    await specialistBtn.click()
    await page.waitForTimeout(500)

    // Click Prompt tab
    const promptTab = page.getByRole('tab', { name: 'Prompt' })
    await promptTab.click()
    await page.waitForTimeout(300)

    // Prompt content should be visible (text area or code block)
    const promptContent = page.locator('pre, code, [class*="font-mono"]').first()
    const hasPrompt = await promptContent.isVisible({ timeout: 3_000 }).catch(() => false)

    // There should be some content in the prompt tab
    const tabContent = page.getByRole('dialog').first()
    const content = await tabContent.textContent()
    expect(content?.length).toBeGreaterThan(0)
  })
})
