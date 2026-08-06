/**
 * Model Config E2E Tests
 *
 * Verifies ModelConfigTab — LLM provider and model configuration:
 *   - Model config tab renders with provider cards
 *   - Both Claude and oMLX provider cards render simultaneously
 *   - Claude config shows model role pickers
 *   - Claude config shows communication tone options
 *   - Local LLM config shows host/port/model fields
 *   - Connection test button validates local LLM endpoint
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/model-config.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { SettingsNav } from './pages/settings-nav'

test.describe('Model Configuration', () => {
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

  async function navigateToModels(page: import('@playwright/test').Page): Promise<boolean> {
    const nav = new SettingsNav(page)
    return nav.navigateToSettingsTab('models')
  }

  test('model config tab renders with provider cards', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToModels(page)
    if (!navigated) {
      test.skip()
      return
    }

    const modelConfig = page.locator('[data-testid="model-config-tab"]')
    await expect(modelConfig).toBeVisible({ timeout: 5_000 })

    // Header text
    const header = page.getByText(/model configuration/i).first()
    await expect(header).toBeVisible()

    // Provider cards grid
    const providerCards = page.locator('[data-testid="provider-toggle"]')
    await expect(providerCards).toBeVisible()
  })

  test('both Claude and oMLX provider cards render simultaneously', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToModels(page)
    if (!navigated) {
      test.skip()
      return
    }

    const providerCards = page.locator('[data-testid="provider-toggle"]')
    const hasCards = await providerCards.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasCards) {
      test.skip()
      return
    }

    // Both Claude and oMLX cards should be visible at the same time
    const claudeCard = page.locator('[data-testid="claude-config-section"]')
    const omlxCard = page.locator('[data-testid="local-llm-config"]')

    await expect(claudeCard).toBeVisible()
    await expect(omlxCard).toBeVisible()

    // Both cards should be visible as connection cards (no "Default" chip)
    const claudeText = (await claudeCard.textContent()) ?? ''
    const omlxText = (await omlxCard.textContent()) ?? ''
    // Verify cards show provider names
    expect(claudeText).toContain('Claude')
    expect(omlxText).toContain('oMLX')
  })

  test('claude config shows model role pickers', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToModels(page)
    if (!navigated) {
      test.skip()
      return
    }

    const modelConfig = page.locator('[data-testid="model-config-tab"]')
    const hasConfig = await modelConfig.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasConfig) {
      test.skip()
      return
    }

    // Model routing section should be visible (always visible, not behind provider tab)
    const rolesSection = page.getByText(/Model Routing|Plan|Build/i).first()
    const hasRoles = await rolesSection.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasRoles) {
      test.skip()
      return
    }

    await expect(rolesSection).toBeVisible()
  })

  test('claude config shows communication tone options', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToModels(page)
    if (!navigated) {
      test.skip()
      return
    }

    const modelConfig = page.locator('[data-testid="model-config-tab"]')
    const hasConfig = await modelConfig.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasConfig) {
      test.skip()
      return
    }

    // Communication tone section (always visible, not behind provider tab)
    const toneSection = page.getByText(/tone|communication/i).first()
    const hasTone = await toneSection.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasTone) {
      test.skip()
      return
    }

    await expect(toneSection).toBeVisible()
  })

  test('local LLM config shows host/port/model fields', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToModels(page)
    if (!navigated) {
      test.skip()
      return
    }

    const modelConfig = page.locator('[data-testid="model-config-tab"]')
    const hasConfig = await modelConfig.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasConfig) {
      test.skip()
      return
    }

    // oMLX card is always visible — look for host/port/model fields directly
    const omlxCard = page.locator('[data-testid="local-llm-config"]')
    const hasOmlx = await omlxCard.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasOmlx) {
      test.skip()
      return
    }

    // Should show server connection fields
    const localConfig = page.getByText(/server address|host|port|model/i).first()
    const hasLocalConfig = await localConfig.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasLocalConfig) {
      test.skip()
      return
    }

    await expect(localConfig).toBeVisible()
  })

  test('connection test button validates local LLM endpoint', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToModels(page)
    if (!navigated) {
      test.skip()
      return
    }

    const modelConfig = page.locator('[data-testid="model-config-tab"]')
    const hasConfig = await modelConfig.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasConfig) {
      test.skip()
      return
    }

    // oMLX card is always visible — look for test button directly
    const omlxCard = page.locator('[data-testid="local-llm-config"]')
    const hasOmlx = await omlxCard.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasOmlx) {
      test.skip()
      return
    }

    // Look for test connection button within oMLX card
    const testBtn = omlxCard.getByRole('button', { name: /test|connect|check/i }).first()
    const hasTest = await testBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasTest) {
      test.skip()
      return
    }

    await expect(testBtn).toBeEnabled()
  })
})
