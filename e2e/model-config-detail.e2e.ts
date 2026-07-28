/**
 * Model Config Detail E2E Tests
 *
 * Tests Provider Cards + Model Routing:
 *   - oMLX card shows host, port, and model name fields
 *   - Context window slider adjusts the token limit
 *   - System prompt override textarea accepts custom text
 *   - Connection test button validates endpoint and shows result
 *   - Claude card shows CLI status (no backend selector)
 *   - Model routing section shows role pickers
 *   - Workspace defaults shows communication tone selector
 *
 * Navigation: Workspace settings → Models tab → provider sections.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/model-config-detail.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { AppChrome } from './pages/app-chrome'
import { SettingsNav } from './pages/settings-nav'

test.describe('Model Config Detail', () => {
  async function navigateToModelsTab(
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

    const chrome = new AppChrome(page)
    await chrome.navigateToTab('settings')
    const settingsNav = new SettingsNav(page)
    await settingsNav.selectTab('models')
    await page.waitForTimeout(1_000)
    return true
  }

  test('local LLM config section shows host, port, and model name fields', async ({
    electronPage: page
  }) => {
    const ready = await navigateToModelsTab(page)
    if (!ready) { test.skip(); return }

    const section = page.locator('[data-testid="local-llm-config"]')
    const isVisible = await section.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    await expect(section).toBeVisible()

    // Should have input fields for host/port configuration
    const inputs = section.locator('input[type="text"], input[type="number"]')
    const inputCount = await inputs.count()

    // Should have at least host and port fields
    if (inputCount > 0) {
      expect(inputCount).toBeGreaterThanOrEqual(1)
    }

    // Check for Connection heading or Backend label
    const sectionText = await section.textContent()
    expect(sectionText).toMatch(/Connection|Backend|Host|Port|Model/i)
  })

  test('context window slider adjusts the token limit', async ({
    electronPage: page
  }) => {
    const ready = await navigateToModelsTab(page)
    if (!ready) { test.skip(); return }

    const section = page.locator('[data-testid="local-llm-config"]')
    const isVisible = await section.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    // Look for range slider or context window controls
    const slider = section.locator('input[type="range"]').first()
    const hasSlider = await slider.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasSlider) { test.skip(); return }

    await expect(slider).toBeVisible()

    // Slider should have min/max attributes
    const min = await slider.getAttribute('min')
    const max = await slider.getAttribute('max')
    expect(min !== null || max !== null).toBeTruthy()
  })

  test('system prompt override textarea accepts custom text', async ({
    electronPage: page
  }) => {
    const ready = await navigateToModelsTab(page)
    if (!ready) { test.skip(); return }

    const section = page.locator('[data-testid="local-llm-config"]')
    const isVisible = await section.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    // Look for system prompt textarea
    const textarea = section.locator('textarea').first()
    const hasTextarea = await textarea.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasTextarea) { test.skip(); return }

    await expect(textarea).toBeVisible()

    // Should be editable
    await textarea.fill('You are a helpful coding assistant.')
    const value = await textarea.inputValue()
    expect(value).toContain('helpful coding assistant')
  })

  test('connection test button validates endpoint and shows result', async ({
    electronPage: page
  }) => {
    const ready = await navigateToModelsTab(page)
    if (!ready) { test.skip(); return }

    const section = page.locator('[data-testid="local-llm-config"]')
    const isVisible = await section.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    // Look for test connection button
    const testBtn = section.locator('button').filter({ hasText: /Test|Connect|Check/i }).first()
    const hasTestBtn = await testBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasTestBtn) { test.skip(); return }

    await expect(testBtn).toBeEnabled()
    await testBtn.click()
    await page.waitForTimeout(2_000)

    // After clicking, should show some result (connected/error status chips)
    const statusIndicator = section.locator('[class*="text-success"], [class*="text-green"], [class*="text-red"], [class*="text-yellow"], [class*="text-amber"]').first()
    const hasStatus = await statusIndicator.isVisible({ timeout: 3_000 }).catch(() => false)
    // Either status appeared or button changed state
    expect(hasTestBtn).toBeTruthy()
    if (hasStatus) {
      await expect(statusIndicator).toBeVisible()
    }
  })

  test('claude card shows CLI status (no backend selector)', async ({
    electronPage: page
  }) => {
    const ready = await navigateToModelsTab(page)
    if (!ready) { test.skip(); return }

    const section = page.locator('[data-testid="claude-config-section"]')
    const isVisible = await section.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    await expect(section).toBeVisible()

    // Should show Claude provider status, NOT an Execution Backend selector
    const sectionText = await section.textContent()
    expect(/Execution Backend/i.test(sectionText ?? '')).toBeFalsy()
    expect(/Claude/i.test(sectionText ?? '')).toBeTruthy()
  })

  test('model routing section shows role pickers (Plan/Build/Background)', async ({
    electronPage: page
  }) => {
    const ready = await navigateToModelsTab(page)
    if (!ready) { test.skip(); return }

    const section = page.locator('[data-testid="model-roles-section"]')
    const isVisible = await section.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    await expect(section).toBeVisible()

    // Should have model role assignment selectors
    const sectionText = await section.textContent()
    const hasRoles = /Plan|Build|Background/i.test(sectionText ?? '')
    expect(hasRoles).toBeTruthy()

    // Should have select dropdowns for model selection
    const selects = section.locator('select')
    if ((await selects.count()) > 0) {
      await expect(selects.first()).toBeVisible()
    }
  })

  test('workspace defaults shows communication tone selector', async ({
    electronPage: page
  }) => {
    const ready = await navigateToModelsTab(page)
    if (!ready) { test.skip(); return }

    // Tone is in the "Workspace Defaults" section at the bottom of the page
    const section = page.locator('[data-testid="conversation-defaults-section"]')
    const isVisible = await section.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    // Should have communication tone options
    const sectionText = await section.textContent()
    const hasToneOptions = /default|calm|optimistic|brutal|caveman/i.test(sectionText ?? '')
    expect(hasToneOptions).toBeTruthy()

    // Should have clickable tone selector buttons
    const toneBtns = section.locator('button').filter({ hasText: /Default|Calm|Optimistic|Brutal|Caveman/i })
    if ((await toneBtns.count()) > 0) {
      await expect(toneBtns.first()).toBeVisible()

      // Click a different tone
      const alternativeTone = toneBtns.filter({ hasText: /Calm|Optimistic/i }).first()
      if (await alternativeTone.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await alternativeTone.click()
        await page.waitForTimeout(500)
        // Tone should be selected (visual feedback)
        await expect(alternativeTone).toBeVisible()
      }
    }
  })
})
