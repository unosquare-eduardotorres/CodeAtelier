/**
 * SettingsNav — Page Object Model for workspace settings navigation.
 *
 * Encapsulates selectors and actions for:
 *   - Navigating to the Settings sidebar tab
 *   - Selecting any of the 16 workspace settings sub-tabs
 *   - Verifying the active settings tab
 *
 * The 16 settings tabs are organized into two groups:
 *   Tools:         health, goals, council, ideas, plans, blueprints
 *   Configuration: specialist, team, repository, brain (memory), code-intelligence,
 *                  integrations, models, documents, tokens, events
 */
import type { Page } from '@playwright/test'

/** All valid workspace settings sub-tab identifiers. */
export type SettingsTab =
  | 'specialist'
  | 'health'
  | 'goals'
  | 'council'
  | 'ideas'
  | 'plans'
  | 'blueprints'
  | 'models'
  | 'repository'
  | 'code-intelligence'
  | 'integrations'
  | 'team'
  | 'memory'
  | 'documents'
  | 'tokens'
  | 'events'

/** Human-readable labels for settings tabs (used as text fallback). */
const TAB_LABELS: Record<SettingsTab, string> = {
  specialist: 'Specialist',
  // Relabelled in the nav (was 'Health') — the tab id is unchanged.
  health: 'Audit Code',
  goals: 'Goals',
  council: 'Council',
  ideas: 'Ideas',
  plans: 'Plans',
  blueprints: 'Blueprints',
  models: 'Models',
  repository: 'Repository',
  'code-intelligence': 'Code Intelligence',
  integrations: 'Integrations',
  team: 'Team',
  memory: 'Brain',
  documents: 'Documents',
  tokens: 'Tokens',
  events: 'Events'
}

export class SettingsNav {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  // ── Actions ──────────────────────────────────────────────────────

  /**
   * Navigate to a specific workspace settings tab.
   *
   * 1. Clicks the Settings sidebar tab (if not already active)
   * 2. Clicks the target sub-tab button
   * 3. Waits for the settings content to render
   *
   * @returns true if navigation succeeded, false if the settings tab or sub-tab was not found
   */
  async navigateToSettingsTab(tab: SettingsTab): Promise<boolean> {
    // Step 1: Ensure the Settings sidebar tab is active
    const settingsTab = this.page.locator('[data-testid="sidebar-tab-settings"]')
    const hasSettingsTab = await settingsTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasSettingsTab) return false

    await settingsTab.click()
    await this.page.waitForTimeout(800)

    // Step 2: Click the target settings sub-tab
    const label = TAB_LABELS[tab]

    // Try button with matching text in the sidebar nav
    const tabButton = this.page
      .locator('nav button, [role="tab"]')
      .filter({ hasText: new RegExp(`^${label}$`, 'i') })
      .first()
    const hasTabButton = await tabButton.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasTabButton) {
      await tabButton.click()
      await this.page.waitForTimeout(800)
      return true
    }

    // Fallback: try any button with the label text
    const fallbackBtn = this.page.getByRole('button', { name: new RegExp(label, 'i') }).first()
    const hasFallback = await fallbackBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasFallback) {
      await fallbackBtn.click()
      await this.page.waitForTimeout(800)
      return true
    }

    // Fallback: try by title attribute (collapsed sidebar shows title)
    const byTitle = this.page.locator(`button[title="${label}"]`).first()
    const hasTitle = await byTitle.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasTitle) {
      await byTitle.click()
      await this.page.waitForTimeout(800)
      return true
    }

    return false
  }

  /**
   * Open Models and switch to its Configure tab.
   *
   * The Models page opens on "In Use", which is read-only by design — every
   * editable control (provider cards, routing, save bar) lives behind Configure.
   */
  async navigateToModelsConfigure(): Promise<boolean> {
    if (!(await this.navigateToSettingsTab('models'))) return false

    const configureTab = this.page.locator('[data-testid="models-tab-configure"]')
    const hasTab = await configureTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasTab) return false

    await configureTab.click()
    await this.page.waitForTimeout(500)
    return true
  }

  // ── Queries ──────────────────────────────────────────────────────

  /** Check if the settings sidebar view is currently active. */
  async isSettingsViewActive(): Promise<boolean> {
    const settingsTab = this.page.locator('[data-testid="sidebar-tab-settings"]')
    if (!(await settingsTab.isVisible({ timeout: 2_000 }).catch(() => false))) return false

    // Check if settings nav items are visible (any settings menu button)
    const navItems = this.page.locator('nav button').first()
    return navItems.isVisible({ timeout: 2_000 }).catch(() => false)
  }
}
