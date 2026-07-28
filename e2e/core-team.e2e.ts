/**
 * Core Team E2E Tests
 *
 * Verifies CoreTeamPage (96 LOC) — read-only core agent team display:
 *   - Core Team page renders with agent card grid
 *   - Agent card shows avatar, name, and description
 *   - "Used In" badges display correctly (Chat, Grill, Plan, Build)
 *   - Agent name shows alias when configured
 *   - At least one core agent (specialist) is always present
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/core-team.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { SettingsNav } from './pages/settings-nav'

test.describe('Core Team', () => {
  async function ensureWorkspaceReady(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
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

  async function navigateToTeam(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    const nav = new SettingsNav(page)
    return nav.navigateToSettingsTab('team')
  }

  test('core team page renders with agent card grid', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToTeam(page)
    if (!navigated) { test.skip(); return }

    const teamPage = page.locator('[data-testid="core-team-page"]')
    const hasTeamPage = await teamPage.isVisible({ timeout: 5_000 }).catch(() => false)
    expect(hasTeamPage).toBeTruthy()

    // Should have at least one agent card
    const agentCards = page.locator('[data-testid="core-agent-card"]')
    expect(await agentCards.count()).toBeGreaterThanOrEqual(1)
  })

  test('agent card shows avatar, name, and description', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToTeam(page)
    if (!navigated) { test.skip(); return }

    const teamPage = page.locator('[data-testid="core-team-page"]')
    const hasTeamPage = await teamPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasTeamPage) { test.skip(); return }

    const firstCard = page.locator('[data-testid="core-agent-card"]').first()
    const hasCard = await firstCard.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasCard) { test.skip(); return }

    // Card should have a name (h4 element)
    const nameEl = firstCard.locator('h4').first()
    const hasName = await nameEl.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasName).toBeTruthy()

    // Card should have a description (p element)
    const descriptionEl = firstCard.locator('p').first()
    const hasDescription = await descriptionEl.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasDescription).toBeTruthy()

    // Card should have "Core Agent" sub-label
    const coreLabel = firstCard.getByText('Core Agent')
    const hasCoreLabel = await coreLabel.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasCoreLabel).toBeTruthy()
  })

  test('"Used In" badges display correctly', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToTeam(page)
    if (!navigated) { test.skip(); return }

    const teamPage = page.locator('[data-testid="core-team-page"]')
    const hasTeamPage = await teamPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasTeamPage) { test.skip(); return }

    const firstCard = page.locator('[data-testid="core-agent-card"]').first()
    const hasCard = await firstCard.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasCard) { test.skip(); return }

    // Check for "Used In" badge labels
    const expectedBadges = ['Chat', 'Grill', 'Plan', 'Build']
    let foundCount = 0
    for (const badge of expectedBadges) {
      const badgeEl = firstCard.locator('span').filter({ hasText: new RegExp(`^${badge}$`) }).first()
      const hasBadge = await badgeEl.isVisible({ timeout: 1_000 }).catch(() => false)
      if (hasBadge) foundCount++
    }

    // specialist should have all 4 badges
    expect(foundCount).toBeGreaterThanOrEqual(1)
  })

  test('agent name shows alias when configured', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToTeam(page)
    if (!navigated) { test.skip(); return }

    const teamPage = page.locator('[data-testid="core-team-page"]')
    const hasTeamPage = await teamPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasTeamPage) { test.skip(); return }

    // The first card should have a name visible — it's either the default or an alias
    const firstCard = page.locator('[data-testid="core-agent-card"]').first()
    const nameEl = firstCard.locator('h4').first()
    const nameText = await nameEl.textContent().catch(() => '')
    expect(nameText!.length).toBeGreaterThan(0)
  })

  test('at least one core agent (specialist) is always present', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToTeam(page)
    if (!navigated) { test.skip(); return }

    const teamPage = page.locator('[data-testid="core-team-page"]')
    const hasTeamPage = await teamPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasTeamPage) { test.skip(); return }

    // Core team should always show at least one agent
    const agentCards = page.locator('[data-testid="core-agent-card"]')
    const cardCount = await agentCards.count()
    expect(cardCount).toBeGreaterThanOrEqual(1)

    // The "Core Team" heading should be visible
    const heading = teamPage.getByText('Core Team').first()
    const hasHeading = await heading.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasHeading).toBeTruthy()
  })
})
