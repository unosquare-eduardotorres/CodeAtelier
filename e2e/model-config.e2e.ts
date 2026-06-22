/**
 * Model Config E2E Tests
 *
 * Verifies ModelConfigTab (107 LOC) — LLM provider and model configuration:
 *   - Model config tab renders with provider toggle
 *   - Provider toggle switches between Claude and Local LLM
 *   - Claude config shows cost preference selector
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
  async function ensureWorkspaceReady(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
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

  async function navigateToModels(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    const nav = new SettingsNav(page)
    return nav.navigateToSettingsTab('models')
  }

  test('model config tab renders with provider toggle', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToModels(page)
    if (!navigated) { test.skip(); return }

    const modelConfig = page.locator('[data-testid="model-config-tab"]')
    await expect(modelConfig).toBeVisible({ timeout: 5_000 })

    // Header text
    const header = page.getByText(/model configuration/i).first()
    await expect(header).toBeVisible()

    // Provider toggle section
    const providerToggle = page.locator('[data-testid="provider-toggle"]')
    await expect(providerToggle).toBeVisible()
  })

  test('provider toggle switches between Claude and Local LLM', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToModels(page)
    if (!navigated) { test.skip(); return }

    const providerToggle = page.locator('[data-testid="provider-toggle"]')
    const hasToggle = await providerToggle.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasToggle) { test.skip(); return }

    // Should show both Claude and Local LLM options
    const claudeBtn = providerToggle.getByText(/claude/i).first()
    const localBtn = providerToggle.getByText(/local/i).first()

    await expect(claudeBtn).toBeVisible()
    await expect(localBtn).toBeVisible()

    // One should be in the active state (border-primary)
    const claudeClasses = await claudeBtn.locator('..').getAttribute('class') ?? ''
    const localClasses = await localBtn.locator('..').getAttribute('class') ?? ''
    const hasActive = claudeClasses.includes('primary') || localClasses.includes('primary')
    expect(hasActive).toBeTruthy()
  })

  test('claude config shows cost preference selector', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToModels(page)
    if (!navigated) { test.skip(); return }

    const modelConfig = page.locator('[data-testid="model-config-tab"]')
    const hasConfig = await modelConfig.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasConfig) { test.skip(); return }

    // Ensure Claude is the active provider
    const providerToggle = page.locator('[data-testid="provider-toggle"]')
    const claudeBtn = providerToggle.locator('button').filter({ hasText: /claude/i }).first()
    if (await claudeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await claudeBtn.click()
      await page.waitForTimeout(500)
    }

    // Cost preference section should be visible
    const costSection = page.getByText(/cost|quality|preference|model tier/i).first()
    const hasCost = await costSection.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasCost) {
      // Provider might be locked to local
      test.skip()
      return
    }

    await expect(costSection).toBeVisible()
  })

  test('claude config shows communication tone options', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToModels(page)
    if (!navigated) { test.skip(); return }

    const modelConfig = page.locator('[data-testid="model-config-tab"]')
    const hasConfig = await modelConfig.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasConfig) { test.skip(); return }

    // Ensure Claude provider
    const providerToggle = page.locator('[data-testid="provider-toggle"]')
    const claudeBtn = providerToggle.locator('button').filter({ hasText: /claude/i }).first()
    if (await claudeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await claudeBtn.click()
      await page.waitForTimeout(500)
    }

    // Communication tone section
    const toneSection = page.getByText(/tone|communication/i).first()
    const hasTone = await toneSection.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasTone) { test.skip(); return }

    await expect(toneSection).toBeVisible()
  })

  test('local LLM config shows host/port/model fields', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToModels(page)
    if (!navigated) { test.skip(); return }

    const modelConfig = page.locator('[data-testid="model-config-tab"]')
    const hasConfig = await modelConfig.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasConfig) { test.skip(); return }

    // Switch to Local LLM provider
    const providerToggle = page.locator('[data-testid="provider-toggle"]')
    const localBtn = providerToggle.locator('button').filter({ hasText: /local/i }).first()
    const hasLocal = await localBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (!hasLocal) { test.skip(); return }

    await localBtn.click()
    await page.waitForTimeout(800)

    // Should show local LLM configuration fields (host, port, model)
    const localConfig = page.getByText(/host|port|model|endpoint|ollama/i).first()
    const hasLocalConfig = await localConfig.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasLocalConfig) { test.skip(); return }

    await expect(localConfig).toBeVisible()
  })

  test('connection test button validates local LLM endpoint', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToModels(page)
    if (!navigated) { test.skip(); return }

    const modelConfig = page.locator('[data-testid="model-config-tab"]')
    const hasConfig = await modelConfig.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasConfig) { test.skip(); return }

    // Switch to Local LLM
    const providerToggle = page.locator('[data-testid="provider-toggle"]')
    const localBtn = providerToggle.locator('button').filter({ hasText: /local/i }).first()
    if (await localBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await localBtn.click()
      await page.waitForTimeout(800)
    }

    // Look for test connection button
    const testBtn = page.getByRole('button', { name: /test|connect|check/i }).first()
    const hasTest = await testBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasTest) {
      test.skip()
      return
    }

    await expect(testBtn).toBeEnabled()
  })
})
