/**
 * WorkspaceSettings POM — Workspace settings panel and tab navigation.
 *
 * Covers tab switching, panel collapse/expand, and tab content verification.
 */
import type { Page, Locator } from '@playwright/test'

export class WorkspaceSettings {
  readonly page: Page

  // Settings panel
  readonly settingsPanel: Locator

  constructor(page: Page) {
    this.page = page
    this.settingsPanel = page.locator('[data-testid="workspace-settings"]')
  }

  /** Open a specific settings tab by its id. */
  async openTab(tabId: string): Promise<void> {
    const tab = this.page.locator(`[data-testid="settings-tab-${tabId}"]`)
    await tab.click()
    await this.page.waitForTimeout(300)
  }

  /** Check if a specific tab is the active one. */
  async isTabActive(tabId: string): Promise<boolean> {
    const tab = this.page.locator(`[data-testid="settings-tab-${tabId}"]`)
    const classList = await tab.getAttribute('class')
    return classList?.includes('bg-primary-muted') ?? false
  }

  /** Get all settings tab locators. */
  getAllTabs(): Locator {
    return this.page.locator('[data-testid^="settings-tab-"]')
  }

  /** Get a tab button by its id. */
  getTab(tabId: string): Locator {
    return this.page.locator(`[data-testid="settings-tab-${tabId}"]`)
  }

  /** Collapse the settings panel. */
  async collapse(): Promise<void> {
    const collapseBtn = this.page.getByRole('button', { name: /collapse/i })
    await collapseBtn.click()
    await this.page.waitForTimeout(300)
  }

  /** Expand the settings panel. */
  async expand(): Promise<void> {
    const expandBtn = this.page.getByRole('button', { name: /expand/i })
    await expandBtn.click()
    await this.page.waitForTimeout(300)
  }

  /** Close workspace settings panel. */
  async close(): Promise<void> {
    const closeBtn = this.page.getByRole('button', { name: /close workspace settings/i })
    await closeBtn.click()
    await this.page.waitForTimeout(300)
  }
}
