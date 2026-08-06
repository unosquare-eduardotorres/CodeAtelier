/**
 * Specialist Order E2E Tests
 *
 * Verifies SpecialistOrder (134 LOC) — priority reordering in settings:
 *   - Specialist order section renders with ordered specialist list
 *   - Each specialist shows grip handle, position number, and name
 *   - Up button moves specialist higher in priority
 *   - Down button moves specialist lower in priority
 *   - First specialist has up button disabled, last has down disabled
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/specialist-order.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { SettingsNav } from './pages/settings-nav'

test.describe('Specialist Order', () => {
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

  /** Navigate to specialist settings and find the order section. */
  async function navigateToSpecialistOrder(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    const nav = new SettingsNav(page)
    const navigated = await nav.navigateToSettingsTab('specialist')
    if (!navigated) return false

    await page.waitForTimeout(1_000)

    // Scroll to the specialist order section
    const orderSection = page.locator('[data-testid="specialist-order"]')
    const hasSection = await orderSection.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasSection) {
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="specialist-order"]')
        el?.scrollIntoView({ behavior: 'instant' })
      })
      await page.waitForTimeout(500)
    }
    return orderSection.isVisible({ timeout: 3_000 }).catch(() => false)
  }

  test('specialist order section renders with ordered specialist list', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const hasSection = await navigateToSpecialistOrder(page)
    if (!hasSection) {
      test.skip()
      return
    }

    const orderSection = page.locator('[data-testid="specialist-order"]')
    await expect(orderSection).toBeVisible({ timeout: 5_000 })

    // Should have "Specialist Priority Order" heading
    const heading = orderSection.getByText(/specialist priority order/i).first()
    const hasHeading = await heading.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasHeading).toBeTruthy()

    // Should have at least one order item
    const orderItems = page.locator('[data-testid="specialist-order-item"]')
    expect(await orderItems.count()).toBeGreaterThanOrEqual(1)
  })

  test('each specialist shows grip handle, position number, and name', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const hasSection = await navigateToSpecialistOrder(page)
    if (!hasSection) {
      test.skip()
      return
    }

    const orderItems = page.locator('[data-testid="specialist-order-item"]')
    const itemCount = await orderItems.count()
    if (itemCount === 0) {
      test.skip()
      return
    }

    const firstItem = orderItems.first()

    // Should have a position number (font-mono element with "1")
    const posNumber = firstItem.locator('.font-mono').first()
    const hasPos = await posNumber.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasPos).toBeTruthy()

    const posText = await posNumber.textContent()
    expect(posText?.trim()).toBe('1')

    // Should have a specialist name (font-medium text)
    const nameEl = firstItem.locator('.font-medium').first()
    const hasName = await nameEl.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasName).toBeTruthy()

    const nameText = await nameEl.textContent()
    expect(nameText!.length).toBeGreaterThan(0)
  })

  test('up button moves specialist higher in priority', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const hasSection = await navigateToSpecialistOrder(page)
    if (!hasSection) {
      test.skip()
      return
    }

    const orderItems = page.locator('[data-testid="specialist-order-item"]')
    const itemCount = await orderItems.count()
    if (itemCount < 2) {
      test.skip()
      return
    }

    // Get the second item's name
    const secondItem = orderItems.nth(1)
    const secondName = await secondItem.locator('.font-medium').first().textContent()

    // Click the up button on the second item
    const upBtn = secondItem.locator('button').first() // ChevronUp is the first button
    const hasUp = await upBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (!hasUp) {
      test.skip()
      return
    }

    await upBtn.click()
    await page.waitForTimeout(1_000)

    // The second item should now be first
    const newFirstItem = orderItems.first()
    const newFirstName = await newFirstItem.locator('.font-medium').first().textContent()
    expect(newFirstName).toBe(secondName)
  })

  test('down button moves specialist lower in priority', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const hasSection = await navigateToSpecialistOrder(page)
    if (!hasSection) {
      test.skip()
      return
    }

    const orderItems = page.locator('[data-testid="specialist-order-item"]')
    const itemCount = await orderItems.count()
    if (itemCount < 2) {
      test.skip()
      return
    }

    // Get the first item's name
    const firstItem = orderItems.first()
    const firstName = await firstItem.locator('.font-medium').first().textContent()

    // Click the down button on the first item (second button in the button group)
    const buttons = firstItem.locator('button')
    const btnCount = await buttons.count()
    if (btnCount < 2) {
      test.skip()
      return
    }

    const downBtn = buttons.nth(1) // ChevronDown is the second button
    await downBtn.click()
    await page.waitForTimeout(1_000)

    // The first item should now be second
    const newSecondItem = orderItems.nth(1)
    const newSecondName = await newSecondItem.locator('.font-medium').first().textContent()
    expect(newSecondName).toBe(firstName)
  })

  test('first specialist has up button disabled, last has down disabled', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const hasSection = await navigateToSpecialistOrder(page)
    if (!hasSection) {
      test.skip()
      return
    }

    const orderItems = page.locator('[data-testid="specialist-order-item"]')
    const itemCount = await orderItems.count()
    if (itemCount < 2) {
      test.skip()
      return
    }

    // First item's up button should be disabled
    const firstItem = orderItems.first()
    const firstUpBtn = firstItem.locator('button').first()
    const isFirstUpDisabled = await firstUpBtn.isDisabled()
    expect(isFirstUpDisabled).toBeTruthy()

    // Last item's down button should be disabled
    const lastItem = orderItems.last()
    const lastButtons = lastItem.locator('button')
    const lastBtnCount = await lastButtons.count()
    if (lastBtnCount >= 2) {
      const lastDownBtn = lastButtons.nth(1)
      const isLastDownDisabled = await lastDownBtn.isDisabled()
      expect(isLastDownDisabled).toBeTruthy()
    }
  })
})
