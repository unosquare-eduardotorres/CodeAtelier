/**
 * WelcomePage POM — Welcome screen and workspace selection.
 *
 * Covers the WelcomeModal flow (first launch) and WelcomeScreen
 * with workspace card grid.
 */
import type { Page, Locator } from '@playwright/test'

export class WelcomePage {
  readonly page: Page

  // Welcome screen
  readonly welcomeScreen: Locator
  readonly addWorkspaceCard: Locator

  // Welcome modal (first-launch)
  readonly welcomeModal: Locator

  constructor(page: Page) {
    this.page = page
    this.welcomeScreen = page.locator('[data-testid="welcome-screen"]')
    this.addWorkspaceCard = page.locator('[data-testid="add-workspace-card"]')
    this.welcomeModal = page.locator('[role="dialog"]').first()
  }

  async isVisible(): Promise<boolean> {
    return this.welcomeScreen.isVisible({ timeout: 5_000 }).catch(() => false)
  }

  async isWelcomeModalVisible(): Promise<boolean> {
    return this.welcomeModal.isVisible({ timeout: 3_000 }).catch(() => false)
  }

  /**
   * Complete the first-launch welcome modal.
   * Fills the profile name, selects an avatar, and clicks through.
   */
  async completeWelcomeModal(name: string): Promise<void> {
    // Fill name input
    const nameInput = this.page.locator('input').first()
    await nameInput.fill(name)

    // Click Continue (first step)
    const continueBtn = this.page
      .getByRole('button', { name: /continue/i })
      .first()
    if (await continueBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await continueBtn.click()
      await this.page.waitForTimeout(500)
    }

    // Select an avatar
    const avatarBtn = this.page.locator('button img').first()
    if (await avatarBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await avatarBtn.click()
      await this.page.waitForTimeout(300)
    }

    // Click "Get Started" or equivalent submit button
    const submitBtn = this.page
      .getByRole('button', { name: /get started|save|let.*go/i })
      .first()
    if (await submitBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await submitBtn.click()
      await this.page.waitForTimeout(2_000)
    }
  }

  /** Click a workspace card by name. */
  async clickWorkspace(name: string): Promise<void> {
    const card = this.page.getByRole('button', { name: new RegExp(`Open workspace.*${name}`, 'i') })
    await card.click()
    await this.page.waitForTimeout(1_500)
  }

  /** Click the "Add Workspace" card. */
  async clickAddWorkspace(): Promise<void> {
    await this.addWorkspaceCard.click()
    await this.page.waitForTimeout(500)
  }

  /** Get all workspace card locators. */
  getWorkspaceCards(): Locator {
    return this.page.locator('[data-testid^="workspace-card-"]')
  }
}
