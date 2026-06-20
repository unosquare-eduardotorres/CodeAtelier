/**
 * Model Configuration E2E Tests
 *
 * Verifies the model configuration settings under workspace Settings → Models tab:
 *   - Provider toggle between Claude and Local LLM
 *   - Claude cost preference buttons
 *   - Fast mode toggle
 *   - Executor backend section
 *   - Local LLM config with connection test
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Model Configuration', () => {
  /**
   * Helper: Navigate to Settings → Models tab.
   */
  async function navigateToModelsTab(
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

    // Open settings and navigate to Models tab
    const settingsBtn = page.getByRole('button', { name: 'Settings' })
    if (await settingsBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await settingsBtn.click()
      await page.waitForTimeout(1_000)
    }

    await settings.openTab('models')
    await page.waitForTimeout(500)

    return settings
  }

  test('Provider toggle switches between Claude and Local LLM', async ({ electronPage: page }) => {
    await navigateToModelsTab(page)

    // Provider toggle container visible
    const providerToggle = page.locator('[data-testid="provider-toggle"]')
    await expect(providerToggle).toBeVisible({ timeout: 10_000 })

    // Claude and Local LLM buttons visible
    const claudeBtn = page.locator('[data-testid="provider-claude"]')
    const localBtn = page.locator('[data-testid="provider-local-llm"]')
    await expect(claudeBtn).toBeVisible()
    await expect(localBtn).toBeVisible()

    // Click Local LLM — config section should appear
    await localBtn.click()
    await page.waitForTimeout(1_000)
    const localConfig = page.locator('[data-testid="local-llm-config"]')
    await expect(localConfig).toBeVisible({ timeout: 5_000 })

    // Click Claude — Claude config section should appear
    await claudeBtn.click()
    await page.waitForTimeout(1_000)
    const claudeConfig = page.locator('[data-testid="claude-config-section"]')
    await expect(claudeConfig).toBeVisible({ timeout: 5_000 })
  })

  test('Claude config shows cost preference buttons', async ({ electronPage: page }) => {
    await navigateToModelsTab(page)

    // Ensure Claude provider is selected
    const claudeBtn = page.locator('[data-testid="provider-claude"]')
    if (await claudeBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await claudeBtn.click()
      await page.waitForTimeout(500)
    }

    const claudeConfig = page.locator('[data-testid="claude-config-section"]')
    await expect(claudeConfig).toBeVisible({ timeout: 10_000 })

    // Economy/Balanced/Power buttons visible
    const economyBtn = page.locator('[data-testid="cost-preference-economy"]')
    const balancedBtn = page.locator('[data-testid="cost-preference-balanced"]')
    const powerBtn = page.locator('[data-testid="cost-preference-power"]')
    await expect(economyBtn).toBeVisible()
    await expect(balancedBtn).toBeVisible()
    await expect(powerBtn).toBeVisible()

    // Click economy — should become active
    await economyBtn.click()
    await page.waitForTimeout(500)
    const economyClass = await economyBtn.getAttribute('class')
    expect(economyClass).toContain('border-primary')

    // Click power — should become active
    await powerBtn.click()
    await page.waitForTimeout(500)
    const powerClass = await powerBtn.getAttribute('class')
    expect(powerClass).toContain('border-primary')
  })

  test('Fast mode toggle switches state', async ({ electronPage: page }) => {
    await navigateToModelsTab(page)

    // Ensure Claude provider
    const claudeBtn = page.locator('[data-testid="provider-claude"]')
    if (await claudeBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await claudeBtn.click()
      await page.waitForTimeout(500)
    }

    const toggle = page.locator('[data-testid="fast-mode-toggle"]')
    await expect(toggle).toBeVisible({ timeout: 10_000 })

    // Get initial state
    const initialChecked = await toggle.getAttribute('aria-checked')

    // Click toggle
    await toggle.click()
    await page.waitForTimeout(500)

    // State should change
    const newChecked = await toggle.getAttribute('aria-checked')
    expect(newChecked).not.toBe(initialChecked)

    // Click again — should revert
    await toggle.click()
    await page.waitForTimeout(500)
    const revertedChecked = await toggle.getAttribute('aria-checked')
    expect(revertedChecked).toBe(initialChecked)
  })

  test('Executor backend section shows CLI/OpenCode options', async ({ electronPage: page }) => {
    await navigateToModelsTab(page)

    // Ensure Claude provider is selected
    const claudeBtn = page.locator('[data-testid="provider-claude"]')
    if (await claudeBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await claudeBtn.click()
      await page.waitForTimeout(500)
    }

    const executorSection = page.locator('[data-testid="executor-backend-section"]')
    await expect(executorSection).toBeVisible({ timeout: 10_000 })

    // CLI and OpenCode buttons visible
    const cliButton = executorSection.locator('button', { hasText: 'Claude CLI' })
    const openCodeButton = executorSection.locator('button', { hasText: 'OpenCode' })
    await expect(cliButton).toBeVisible()
    await expect(openCodeButton).toBeVisible()

    // One should be active (has border-primary)
    const cliClass = await cliButton.getAttribute('class')
    const openCodeClass = await openCodeButton.getAttribute('class')
    const oneIsActive =
      (cliClass?.includes('border-primary') ?? false) ||
      (openCodeClass?.includes('border-primary') ?? false)
    expect(oneIsActive).toBeTruthy()
  })

  test('Local LLM config shows connection test button', async ({ electronPage: page }) => {
    await navigateToModelsTab(page)

    // Switch to Local LLM provider
    const localBtn = page.locator('[data-testid="provider-local-llm"]')
    await expect(localBtn).toBeVisible({ timeout: 10_000 })
    await localBtn.click()
    await page.waitForTimeout(1_000)

    const localConfig = page.locator('[data-testid="local-llm-config"]')
    await expect(localConfig).toBeVisible({ timeout: 5_000 })

    // Test connection button visible
    const testBtn = page.locator('[data-testid="local-llm-test-connection"]')
    await expect(testBtn).toBeVisible()

    // Button has "Test" text
    await expect(testBtn).toHaveText(/Test/)
  })
})
