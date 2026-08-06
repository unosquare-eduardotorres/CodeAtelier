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
    // The panel renders data-testid="workspace-settings-panel". This used to
    // look for "workspace-settings", which matched nothing -- so every spec
    // guarding on `hasPanel` silently test.skip()'d instead of running.
    this.settingsPanel = page.locator('[data-testid="workspace-settings-panel"]')
  }

  /**
   * Locator for one tab. Every tab button carries the same
   * data-testid="workspace-settings-tab", so the id is read off the companion
   * data-tab-id attribute; `settings-tab-<id>` was never rendered.
   */
  getTab(tabId: string): Locator {
    return this.page.locator(`[data-testid="workspace-settings-tab"][data-tab-id="${tabId}"]`)
  }

  /** Open a specific settings tab by its id. */
  async openTab(tabId: string): Promise<void> {
    await this.getTab(tabId).click()
    await this.page.waitForTimeout(300)
  }

  /** Check if a specific tab is the active one. */
  async isTabActive(tabId: string): Promise<boolean> {
    const classList = await this.getTab(tabId).getAttribute('class')
    return classList?.includes('bg-primary-muted') ?? false
  }

  /** Get all settings tab locators. */
  getAllTabs(): Locator {
    return this.page.locator('[data-testid="workspace-settings-tab"]')
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
