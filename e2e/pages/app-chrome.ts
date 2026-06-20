/**
 * AppChrome — Page Object Model for app-level navigation.
 *
 * Encapsulates selectors and actions for:
 *   - Sidebar tab navigation (chats, goals, health, settings)
 *   - Workspace settings access
 *   - Workspace open detection
 *   - Home navigation
 */
import type { Page } from '@playwright/test'

/** Sidebar navigation tab names. */
type SidebarTab = 'chats' | 'goals' | 'health' | 'settings'

export class AppChrome {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  // ── Queries ──────────────────────────────────────────────────────

  /** Check if a workspace is currently open (chat panel or sidebar visible). */
  async isWorkspaceOpen(): Promise<boolean> {
    const chatPanel = this.page.locator('[data-testid="chat-panel"]')
    const sidebar = this.page.locator('[data-testid="unified-sidebar"]')
    const hasChat = await chatPanel.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasSidebar = await sidebar.isVisible({ timeout: 1_000 }).catch(() => false)
    return hasChat || hasSidebar
  }

  // ── Actions ──────────────────────────────────────────────────────

  /** Navigate to a sidebar tab. Tries data-testid first, then aria-label/text. */
  async navigateToTab(tab: SidebarTab): Promise<void> {
    // Try data-testid convention: sidebar-tab-{name}
    const byTestId = this.page.locator(`[data-testid="sidebar-tab-${tab}"]`)
    if (await byTestId.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await byTestId.click()
      await this.page.waitForTimeout(800)
      return
    }

    // Fallback: button with matching text
    const byText = this.page
      .getByRole('button', { name: new RegExp(tab, 'i') })
      .first()
    if (await byText.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await byText.click()
      await this.page.waitForTimeout(800)
      return
    }

    // Fallback: aria-label
    const byLabel = this.page.locator(`[aria-label="${tab}"], [aria-label="${tab[0].toUpperCase() + tab.slice(1)}"]`).first()
    if (await byLabel.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await byLabel.click()
      await this.page.waitForTimeout(800)
    }
  }

  /** Open the workspace settings modal. */
  async openWorkspaceSettings(): Promise<void> {
    const settingsBtn = this.page.locator('[aria-label="Workspace Settings"]')
    if (await settingsBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await settingsBtn.click()
      await this.page.waitForTimeout(800)
    }
  }

  /** Navigate to the home/welcome screen. */
  async goHome(): Promise<void> {
    const homeBtn = this.page.locator('[aria-label="Home"]')
    if (await homeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await homeBtn.click()
      await this.page.waitForTimeout(800)
    }
  }
}
