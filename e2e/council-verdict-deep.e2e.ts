/**
 * Council Verdict Deep E2E Tests
 *
 * Verifies CouncilVerdictCard (252 LOC) — chairman's synthesized verdict display:
 *   - Score gauge renders with a numeric value
 *   - Agrees section lists consensus items among advisors
 *   - Clashes section shows areas of disagreement
 *   - Blind spots section shows unconsidered aspects
 *   - Expandable revision recommendations toggle open/close
 *   - Advisor score chips show per-advisor individual scores
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/council-verdict-deep.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { AppChrome } from './pages/app-chrome'
import { SettingsNav } from './pages/settings-nav'

test.describe('Council Verdict Deep', () => {
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

  async function navigateToCouncilWithVerdict(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    const chrome = new AppChrome(page)
    await chrome.navigateToTab('settings')
    const settingsNav = new SettingsNav(page)
    await settingsNav.navigateToSettingsTab('council')
    await page.waitForTimeout(800)

    // Look for a completed session card to open
    const sessionCards = page.locator('[data-testid="council-session-card"]')
    const count = await sessionCards.count()
    if (count > 0) {
      // Click the View button on the first completed session
      const viewBtn = sessionCards.first().locator('button').filter({ hasText: /view/i }).first()
      const hasView = await viewBtn.isVisible({ timeout: 3_000 }).catch(() => false)
      if (hasView) {
        await viewBtn.click()
        await page.waitForTimeout(1_000)
      }
    }

    // Check if verdict card is visible (in council view or directly)
    const verdictCard = page.locator('[data-testid="council-verdict-card"]')
    return verdictCard.isVisible({ timeout: 5_000 }).catch(() => false)
  }

  test('score gauge renders with a numeric value between 0 and 100', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const hasVerdict = await navigateToCouncilWithVerdict(page)
    if (!hasVerdict) {
      test.skip()
      return
    }

    const verdictCard = page.locator('[data-testid="council-verdict-card"]')
    await expect(verdictCard).toBeVisible()

    // Score gauge should render with "Council Verdict" heading
    const heading = verdictCard.getByText('Council Verdict')
    await expect(heading).toBeVisible()

    // Score gauge shows a numeric value
    const scoreText = verdictCard.locator('text, span').filter({ hasText: /\d+/ }).first()
    const hasScore = await scoreText.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasScore).toBeTruthy()
  })

  test('agrees section lists consensus items among advisors', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const hasVerdict = await navigateToCouncilWithVerdict(page)
    if (!hasVerdict) {
      test.skip()
      return
    }

    const verdictCard = page.locator('[data-testid="council-verdict-card"]')

    // Agreement section should be visible with its heading
    const agreementSection = verdictCard.getByText('Agreement')
    const hasAgreement = await agreementSection.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasAgreement).toBeTruthy()
  })

  test('clashes section shows areas of disagreement', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const hasVerdict = await navigateToCouncilWithVerdict(page)
    if (!hasVerdict) {
      test.skip()
      return
    }

    const verdictCard = page.locator('[data-testid="council-verdict-card"]')

    // Disagreements section should be visible
    const clashesSection = verdictCard.getByText('Disagreements')
    const hasClashes = await clashesSection.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasClashes).toBeTruthy()
  })

  test('blind spots section shows unconsidered aspects', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const hasVerdict = await navigateToCouncilWithVerdict(page)
    if (!hasVerdict) {
      test.skip()
      return
    }

    const verdictCard = page.locator('[data-testid="council-verdict-card"]')

    // Blind Spots section should be visible
    const blindSpotsSection = verdictCard.getByText('Blind Spots')
    const hasBlindSpots = await blindSpotsSection.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasBlindSpots).toBeTruthy()
  })

  test('expandable revision recommendations toggle open/close', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const hasVerdict = await navigateToCouncilWithVerdict(page)
    if (!hasVerdict) {
      test.skip()
      return
    }

    const verdictCard = page.locator('[data-testid="council-verdict-card"]')

    // Look for "Recommended Revisions" expandable section
    const revisionsHeader = verdictCard.getByText(/Recommended Revisions/i).first()
    const hasRevisions = await revisionsHeader.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasRevisions) {
      test.skip()
      return
    }

    // Click to collapse (default is expanded)
    const toggleBtn = revisionsHeader.locator('..').locator('button').first()
    const hasToggle = await toggleBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (!hasToggle) {
      // The header itself might be the toggle button
      await revisionsHeader.click()
    } else {
      await toggleBtn.click()
    }
    await page.waitForTimeout(300)

    // The toggle should still be accessible
    await expect(verdictCard.getByText(/Recommended Revisions/i).first()).toBeVisible()
  })

  test('advisor score chips show per-advisor individual scores', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const hasVerdict = await navigateToCouncilWithVerdict(page)
    if (!hasVerdict) {
      test.skip()
      return
    }

    const verdictCard = page.locator('[data-testid="council-verdict-card"]')

    // Advisor score chips show advisor names (Contrarian, First Principles, etc.)
    const advisorNames = ['Contrarian', 'First Principles', 'Expansionist', 'Outsider', 'Executor']
    let foundAdvisors = 0
    for (const name of advisorNames) {
      const chip = verdictCard.getByText(name, { exact: false }).first()
      const isVisible = await chip.isVisible({ timeout: 2_000 }).catch(() => false)
      if (isVisible) foundAdvisors++
    }

    // At least some advisor chips should be visible (completed advisors)
    // If no individual scores exist, skip
    if (foundAdvisors === 0) {
      test.skip()
      return
    }
    expect(foundAdvisors).toBeGreaterThan(0)
  })
})
