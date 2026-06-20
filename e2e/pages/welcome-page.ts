/**
 * WelcomePage — Page Object Model for the welcome/home screen.
 *
 * Encapsulates selectors and actions for:
 *   - Welcome modal (first-launch profile setup)
 *   - Home screen workspace card list
 *   - Navigation to workspace
 */
import type { Locator, Page } from '@playwright/test'

export class WelcomePage {
  private readonly page: Page

  /** The welcome modal dialog (first-launch flow). */
  private readonly welcomeModal: Locator
  /** The workspace card list on the home screen. */
  private readonly workspaceCards: Locator

  constructor(page: Page) {
    this.page = page
    this.welcomeModal = page.locator('[role="dialog"]').first()
    this.workspaceCards = page.locator(
      '[data-testid="workspace-item"], .group[class*="cursor-pointer"], [class*="hover:bg-"]'
    )
  }

  // ── Queries ──────────────────────────────────────────────────────

  /** Check if we're on the welcome/home screen (no workspace open). */
  async isVisible(): Promise<boolean> {
    // Home screen has workspace cards or an "Add Project" CTA
    const homeIndicators = this.page.locator(
      '[data-testid="welcome-screen"], [data-testid="home-screen"], button:has-text("Add Project")'
    )
    const hasHome = await homeIndicators.first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasHome) return true

    // Fallback: check for workspace cards
    const cardCount = await this.workspaceCards.count()
    if (cardCount > 0) return true

    // Check if there's no chat panel visible (meaning we're on welcome)
    const chatPanel = this.page.locator('[data-testid="chat-panel"]')
    const hasChat = await chatPanel.isVisible({ timeout: 1_000 }).catch(() => false)
    return !hasChat
  }

  /** Check if the first-launch welcome modal is showing. */
  async isWelcomeModalVisible(): Promise<boolean> {
    return this.welcomeModal.isVisible({ timeout: 3_000 }).catch(() => false)
  }

  /** Return the workspace card locator list. */
  getWorkspaceCards(): Locator {
    return this.workspaceCards
  }

  // ── Actions ──────────────────────────────────────────────────────

  /**
   * Complete the welcome modal flow (name entry + avatar selection).
   * Safe to call even if the modal has already been dismissed.
   */
  async completeWelcomeModal(name: string): Promise<void> {
    const isShowing = await this.isWelcomeModalVisible()
    if (!isShowing) return

    // Step 1: Fill in name
    const nameInput = this.welcomeModal.locator('input').first()
    if (await nameInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await nameInput.fill(name)
    }

    // Click Continue (step 1 → step 2)
    const continueBtn = this.welcomeModal
      .getByRole('button', { name: /continue/i })
      .first()
    if (await continueBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await continueBtn.click()
      await this.page.waitForTimeout(1_000)
    }

    // Step 2: Select an avatar (click first avatar-like button)
    const avatarBtn = this.welcomeModal
      .locator('button')
      .filter({ has: this.page.locator('img') })
      .first()
    if (await avatarBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await avatarBtn.click()
      await this.page.waitForTimeout(500)
    }

    // Click "Get Started" to complete
    const getStarted = this.welcomeModal
      .getByRole('button', { name: /get started|let.*go/i })
      .first()
    if (await getStarted.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await getStarted.click()
      await this.page.waitForTimeout(2_000)
    }
  }
}
