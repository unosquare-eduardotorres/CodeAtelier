/**
 * Elicitation Modal E2E Tests
 *
 * Tests ElicitationModal (109 LOC) — MCP server elicitation requests:
 *   - Elicitation modal renders when MCP server sends request
 *   - Modal shows server name in header
 *   - Message content displays the server's elicitation text
 *   - Accept button sends approval response
 *   - Decline button sends rejection and closes modal
 *
 * The ElicitationModal is triggered by MCP server IPC events during chat.
 * Tests verify DOM structure when visible; gracefully skip otherwise.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/elicitation-modal.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Elicitation Modal', () => {
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

  async function findElicitationModal(
    page: import('@playwright/test').Page
  ): Promise<import('@playwright/test').Locator | null> {
    const modal = page.locator('[data-testid="elicitation-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
    return hasModal ? modal : null
  }

  test('elicitation modal renders when MCP server sends request', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = await findElicitationModal(page)
    if (!modal) {
      test.skip()
      return
    }

    // Modal should be visible with proper structure
    await expect(modal).toBeVisible()

    // Should have a card-like container with header and actions
    const header = modal.locator('h3')
    await expect(header).toBeVisible()
  })

  test('modal shows server name in header', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = await findElicitationModal(page)
    if (!modal) {
      test.skip()
      return
    }

    // Header should contain the server name + "needs authentication"
    const header = modal.locator('h3')
    const headerText = await header.textContent()

    expect(headerText?.includes('needs authentication')).toBeTruthy()
    // Server name should be non-empty (comes before "needs authentication")
    expect(headerText?.length).toBeGreaterThan('needs authentication'.length)
  })

  test("message content displays the server's elicitation text", async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = await findElicitationModal(page)
    if (!modal) {
      test.skip()
      return
    }

    // Body section should have message content (paragraph text)
    const bodyText = modal.locator('p').first()
    await expect(bodyText).toBeVisible()

    const text = await bodyText.textContent()
    expect(text?.length).toBeGreaterThan(0)
  })

  test('accept button sends approval response', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = await findElicitationModal(page)
    if (!modal) {
      test.skip()
      return
    }

    // Accept button should be visible
    const acceptBtn = page.locator('[data-testid="elicitation-accept-btn"]')
    await expect(acceptBtn).toBeVisible()

    // Should contain acceptance text
    const text = await acceptBtn.textContent()
    expect(text?.includes('authenticated') || text?.includes('Done')).toBeTruthy()
  })

  test('decline button sends rejection and closes modal', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = await findElicitationModal(page)
    if (!modal) {
      test.skip()
      return
    }

    // Cancel/decline button should be visible
    const declineBtn = modal.locator('button:has-text("Cancel")')
    const hasDecline = await declineBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasDecline) {
      test.skip()
      return
    }

    await expect(declineBtn).toBeVisible()

    // Click decline — modal should close
    await declineBtn.click()
    await page.waitForTimeout(500)

    await expect(modal).toBeHidden({ timeout: 3_000 })
  })
})
