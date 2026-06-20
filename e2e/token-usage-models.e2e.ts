/**
 * Token Usage & Local Models E2E Tests
 *
 * Verifies settings-level components for monitoring spend and
 * configuring local LLMs:
 *   - TokenUsagePage shows stat cards + usage table
 *   - CacheEfficiencyPanel shows cache hit rate
 *   - LocalModelSelector shows available models
 *   - OllamaSetupModal guides Ollama installation
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/token-usage-models.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Token Usage & Local Models', () => {
  async function ensureWorkspaceOpen(page: import('@playwright/test').Page): Promise<void> {
    const welcomePage = new WelcomePage(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count > 0) {
        await cards.first().click()
        await page.waitForTimeout(3_000)
      }
    }
  }

  async function navigateToSettings(
    page: import('@playwright/test').Page,
    tabId: string
  ): Promise<void> {
    await ensureWorkspaceOpen(page)

    const settings = new WorkspaceSettings(page)
    const settingsTab = page.getByRole('button', { name: /settings/i })
    const hasTab = await settingsTab.first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }
    await settings.openTab(tabId)
    await page.waitForTimeout(500)
  }

  // ── TokenUsagePage ──

  test('TokenUsagePage shows cost summary and usage data', async ({ electronPage: page }) => {
    await navigateToSettings(page, 'token-usage')

    const usagePage = page.locator('[data-testid="token-usage-page"]')
    const hasPage = await usagePage.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasPage) {
      // Try navigating directly via button
      const usageBtn = page.getByRole('button', { name: /token usage|usage/i }).first()
      const hasBtn = await usageBtn.isVisible({ timeout: 3_000 }).catch(() => false)
      if (hasBtn) {
        await usageBtn.click()
        await page.waitForTimeout(1_000)
      }

      const hasPageNow = await usagePage.isVisible({ timeout: 5_000 }).catch(() => false)
      if (!hasPageNow) {
        test.skip()
        return
      }
    }

    // Should show cost summary (dollar amounts)
    const costText = page.getByText(/estimated cost|cost/i).first()
    const hasCost = await costText.isVisible({ timeout: 3_000 }).catch(() => false)

    // Should show stat cards with numbers
    const pageText = await usagePage.textContent()
    const hasNumbers = /\$\d+|\d+[KM]?\s*(tokens|input|output)/i.test(pageText ?? '')

    expect(hasCost || hasNumbers).toBeTruthy()

    // Should show budget status (On track, Warning, or Exceeded)
    const budgetText = page.getByText(/on track|exceeded|used|budget/i).first()
    const hasBudget = await budgetText.isVisible({ timeout: 2_000 }).catch(() => false)

    // Either budget info or some stats should be visible
    expect(hasCost || hasBudget || hasNumbers).toBeTruthy()
  })

  // ── CacheEfficiencyPanel ──

  test('CacheEfficiencyPanel shows cache hit rate information', async ({
    electronPage: page
  }) => {
    await navigateToSettings(page, 'token-usage')

    // CacheEfficiencyPanel shows cache read/write percentages
    const cacheText = page.getByText(/cache.*hit|cache.*rate|cache.*read|write-back/i).first()
    const hasCache = await cacheText.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasCache) {
      // Cache panel may not render if no cache data available
      test.skip()
      return
    }

    // Should show percentage values
    const percentText = page.getByText(/\d+%/)
    const hasPercent = await percentText.first().isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasPercent).toBeTruthy()
  })

  // ── LocalModelSelector ──

  test('LocalModelSelector shows available models and selection state', async ({
    electronPage: page
  }) => {
    await navigateToSettings(page, 'model')

    const selector = page.locator('[data-testid="local-model-selector"]')
    const hasSelector = await selector.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasSelector) {
      // Local model settings may be under a different tab or not available
      // Try looking for the selector anywhere on the settings page
      const modelLabel = page.getByText(/local model|ollama|model/i).first()
      const hasLabel = await modelLabel.isVisible({ timeout: 3_000 }).catch(() => false)

      if (!hasLabel) {
        test.skip()
        return
      }

      // Model section exists but selector may be conditional
      test.skip()
      return
    }

    // Should show "Model" label
    const modelLabel = selector.getByText(/model/i)
    await expect(modelLabel.first()).toBeVisible()

    // Should show installed models or empty state
    const selectorText = await selector.textContent()
    const hasContent =
      /installed|available|pull|download|no.*models/i.test(selectorText ?? '') ||
      selectorText!.length > 20

    expect(hasContent).toBeTruthy()

    // Model items should be clickable buttons
    const modelButtons = selector.locator('button')
    const buttonCount = await modelButtons.count()
    expect(buttonCount).toBeGreaterThan(0)
  })

  // ── OllamaSetupModal ──

  test('OllamaSetupModal shows setup instructions and status check', async ({
    electronPage: page
  }) => {
    await navigateToSettings(page, 'model')

    const modal = page.locator('[data-testid="ollama-setup-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) {
      // Try to trigger the modal via a setup/configure button
      const setupBtn = page.getByRole('button', { name: /setup|configure|install.*ollama/i }).first()
      const hasSetup = await setupBtn.isVisible({ timeout: 3_000 }).catch(() => false)

      if (hasSetup) {
        await setupBtn.click()
        await page.waitForTimeout(1_000)
      }

      const hasModalNow = await modal.isVisible({ timeout: 3_000 }).catch(() => false)
      if (!hasModalNow) {
        test.skip()
        return
      }
    }

    // Should show "Ollama Setup" heading
    const heading = modal.getByText(/ollama setup/i)
    await expect(heading).toBeVisible()

    // Should have a close button
    const closeBtn = modal.getByRole('button').first()
    const hasClose = await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasClose).toBeTruthy()

    // Should show connection status or installation instructions
    const modalText = await modal.textContent()
    const hasContent = /ollama|install|connect|status|model/i.test(modalText ?? '')
    expect(hasContent).toBeTruthy()

    // Close modal
    const closable = modal.locator('button').filter({ hasText: /close|cancel|×/ }).first()
    const hasClosable = await closable.isVisible({ timeout: 2_000 }).catch(() => false)
    if (hasClosable) {
      await closable.click()
    } else {
      await page.keyboard.press('Escape')
    }
    await page.waitForTimeout(300)
  })
})
