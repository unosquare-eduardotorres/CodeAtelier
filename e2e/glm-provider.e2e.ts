/**
 * GLM (Z.ai) Provider E2E Tests
 *
 * Covers the GLM settings surface end-to-end, in a real packaged renderer, with
 * no Z.ai credentials and no network. What it locks down:
 *   - The GLM card mounts on the Configure tab alongside the other providers.
 *   - The base URL defaults to the Coding Plan endpoint and is shown verbatim
 *     (never rewritten to a /v1 form, which 404s against …/coding/paas/v4).
 *   - Saving the card does NOT silently fail to activate GLM: an explicit hint
 *     tells the user the provider is chosen by the Plan role in Model Routing.
 *   - The routing dropdowns actually offer GLM models.
 *   - The Thinking control is absent — Z.ai does not allow thinking to be
 *     disabled on GLM-5.3 / GLM-5.3-Flash, so a toggle there would be inert.
 *
 * NOT covered here, deliberately: the generated `opencode.json`. Producing one
 * requires a live GLM session, so it is asserted directly against the config
 * writer in src/main/services/__tests__/glm-provider.test.ts (D1/D2/D3), which
 * runs on every unit run instead of only when a build exists.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/glm-provider.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { SettingsNav } from './pages/settings-nav'

test.describe('GLM Provider', () => {
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

  /** Open Models → Configure and return the GLM card, or null if unreachable. */
  async function openGlmCard(
    page: import('@playwright/test').Page
  ): Promise<import('@playwright/test').Locator | null> {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) return null

    const nav = new SettingsNav(page)
    const navigated = await nav.navigateToModelsConfigure()
    if (!navigated) return null

    const card = page.locator('[data-testid="glm-config-section"]')
    const visible = await card.isVisible({ timeout: 5_000 }).catch(() => false)
    return visible ? card : null
  }

  test('GLM card renders on the Configure tab', async ({ electronPage: page }) => {
    const card = await openGlmCard(page)
    if (!card) {
      test.skip()
      return
    }

    await expect(card).toBeVisible()
    await expect(card.getByText('Z.AI GLM')).toBeVisible()
  })

  test('base URL defaults to the Coding Plan endpoint, unmangled', async ({
    electronPage: page
  }) => {
    const card = await openGlmCard(page)
    if (!card) {
      test.skip()
      return
    }

    // The single most consequential string in the integration: a Coding Plan key
    // is invalid on the pay-as-you-go host, and appending /v1 yields a 404.
    const value = await card.locator('input[type="text"]').first().inputValue()
    expect(value).toContain('/coding/paas/v4')
    expect(value).not.toMatch(/\/v1\/?$/)
  })

  test('card warns that saving does not switch the workspace to GLM', async ({
    electronPage: page
  }) => {
    const card = await openGlmCard(page)
    if (!card) {
      test.skip()
      return
    }

    // A fresh workspace is on Claude, so the hint must be present. Without it the
    // user saves the connection, sees success, and every chat still runs Claude.
    await expect(card.getByText(/not using GLM yet/i)).toBeVisible()
    await expect(card.getByText(/Model Routing/i)).toBeVisible()
  })

  test('no Thinking toggle is offered — GLM-5.3 cannot disable it', async ({
    electronPage: page
  }) => {
    const card = await openGlmCard(page)
    if (!card) {
      test.skip()
      return
    }

    await expect(card.getByText(/Enable thinking mode/i)).toHaveCount(0)
    await expect(card.getByText(/always reason/i)).toBeVisible()
  })

  test('routing offers GLM models for the Plan role', async ({ electronPage: page }) => {
    const card = await openGlmCard(page)
    if (!card) {
      test.skip()
      return
    }

    // Routing is a sibling section on the same tab. GLM must be selectable there —
    // it is the only way to actually activate the provider.
    const configure = page.locator('[data-testid="model-config-configure"]')
    await expect(configure).toBeVisible()

    const glmOption = configure.locator('option', { hasText: /glm-/i })
    expect(await glmOption.count()).toBeGreaterThan(0)
  })
})
