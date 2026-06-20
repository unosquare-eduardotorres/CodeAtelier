/**
 * AppChrome POM — navigation and top-level app elements.
 *
 * Wraps the header buttons, status bar, and global navigation
 * so tests don't repeat aria-label/testid selectors.
 */
import type { Page, Locator } from '@playwright/test'

export class AppChrome {
  readonly page: Page

  // Header buttons
  readonly homeButton: Locator
  readonly settingsButton: Locator
  readonly helpButton: Locator
  readonly bugTrackerButton: Locator

  // Layout elements
  readonly statusBar: Locator
  readonly appHeader: Locator

  constructor(page: Page) {
    this.page = page
    this.homeButton = page.getByRole('button', { name: 'Home' })
    this.settingsButton = page.getByRole('button', { name: 'Settings' })
    this.helpButton = page.getByRole('button', { name: 'Help' })
    this.bugTrackerButton = page.getByRole('button', { name: 'Bug Tracker' })
    this.statusBar = page.locator('[data-testid="status-bar"]')
    this.appHeader = page.locator('[data-testid="app-header"]')
  }

  async goHome(): Promise<void> {
    await this.homeButton.click()
    await this.page.waitForTimeout(500)
  }

  async openSettings(): Promise<void> {
    await this.settingsButton.click()
    await this.page.waitForTimeout(500)
  }

  async openHelp(): Promise<void> {
    await this.helpButton.click()
    await this.page.waitForTimeout(500)
  }

  async openBugTracker(): Promise<void> {
    await this.bugTrackerButton.click()
    await this.page.waitForTimeout(500)
  }

  getStatusBar(): Locator {
    return this.statusBar
  }
}
