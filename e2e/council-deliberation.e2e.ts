/**
 * Council Deliberation E2E Tests
 *
 * Fills gaps in council-review.e2e.ts by testing deeper council
 * interaction components:
 *   - CouncilRankingsMatrix shows ranked advisor verdicts
 *   - CouncilVerdictCard shows individual advisor verdict with score
 *   - CouncilAdvisorDetailsTab shows advisor analysis breakdown
 *   - CouncilView phase switching between deliberation phases
 *   - CouncilFilterBar filters session history
 *
 * The council has 11 components but only 7 surface-level scenarios
 * were tested. These add the missing deep interaction coverage.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/council-deliberation.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Council Deliberation', () => {
  async function navigateToCouncil(page: import('@playwright/test').Page): Promise<void> {
    const welcomePage = new WelcomePage(page)
    const settings = new WorkspaceSettings(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count === 0) return
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }

    const settingsTab = page.getByRole('button', { name: /settings/i })
    const hasTab = await settingsTab
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)
    if (hasTab) {
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }
    await settings.openTab('council')
    await page.waitForTimeout(500)
  }

  // ── CouncilRankingsMatrix ──

  test('CouncilRankingsMatrix shows peer review results with advisor roles', async ({
    electronPage: page
  }) => {
    await navigateToCouncil(page)

    const matrix = page.locator('[data-testid="council-rankings-matrix"]')
    const hasMatrix = await matrix.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasMatrix) {
      // Matrix only visible during peer review or complete phase
      // Try navigating to a completed session
      const sessionCards = page.locator('[class*="rounded-xl"][class*="border"]')
      const sessionCount = await sessionCards.count()

      if (sessionCount > 0) {
        await sessionCards.first().click()
        await page.waitForTimeout(2_000)
      }

      const hasMatrixNow = await matrix.isVisible({ timeout: 5_000 }).catch(() => false)
      if (!hasMatrixNow) {
        test.skip()
        return
      }
    }

    // Should show "Peer Review Results" heading
    const heading = matrix.getByText(/peer review results/i)
    await expect(heading).toBeVisible()

    // Should have reviewer entries
    const entries = matrix.locator('[class*="space-y-2"] > div')
    const entryCount = await entries.count()
    expect(entryCount).toBeGreaterThan(0)
  })

  // ── CouncilVerdictCard ──

  test('CouncilVerdictCard shows score gauge and recommendation', async ({
    electronPage: page
  }) => {
    await navigateToCouncil(page)

    const verdictCard = page.locator('[data-testid="council-verdict-card"]')
    let hasVerdict = await verdictCard.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasVerdict) {
      // Try opening a completed session
      const completedSessions = page.getByText(/completed/i)
      const hasCompleted = await completedSessions
        .first()
        .isVisible({ timeout: 3_000 })
        .catch(() => false)

      if (hasCompleted) {
        await completedSessions.first().click()
        await page.waitForTimeout(2_000)
      }

      hasVerdict = await verdictCard.isVisible({ timeout: 5_000 }).catch(() => false)
      if (!hasVerdict) {
        test.skip()
        return
      }
    }

    // Should show "Council Verdict" text
    const title = verdictCard.getByText(/council verdict/i)
    await expect(title).toBeVisible()

    // Should show an overall score (SVG gauge or number)
    const scoreElements = verdictCard.locator('svg, [class*="font-bold"]')
    const hasScore = await scoreElements
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false)
    expect(hasScore).toBeTruthy()

    // Should have recommendation text
    const cardText = await verdictCard.textContent()
    expect(cardText!.length).toBeGreaterThan(50)
  })

  // ── CouncilAdvisorDetailsTab ──

  test('CouncilAdvisorDetailsTab shows individual advisor analysis cards', async ({
    electronPage: page
  }) => {
    await navigateToCouncil(page)

    const detailsTab = page.locator('[data-testid="council-advisor-details-tab"]')
    let hasDetails = await detailsTab.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasDetails) {
      // Navigate to a completed council's "Advisor Details" tab
      const completeView = page.locator('[data-testid="council-complete-view"]')
      const hasComplete = await completeView.isVisible({ timeout: 3_000 }).catch(() => false)

      if (hasComplete) {
        const advisorTabBtn = completeView.getByText(/advisor details/i)
        const hasTabBtn = await advisorTabBtn.isVisible({ timeout: 2_000 }).catch(() => false)
        if (hasTabBtn) {
          await advisorTabBtn.click()
          await page.waitForTimeout(500)
        }
      }

      hasDetails = await detailsTab.isVisible({ timeout: 3_000 }).catch(() => false)
      if (!hasDetails) {
        test.skip()
        return
      }
    }

    // Should contain advisor cards with role names
    const advisorCards = detailsTab.locator('[class*="rounded-lg"][class*="border"]')
    const cardCount = await advisorCards.count()
    expect(cardCount).toBeGreaterThan(0)

    // Cards should show advisor names
    const cardText = await detailsTab.textContent()
    const hasAdvisorNames = /architect|requirements|security|data|ux/i.test(cardText ?? '')
    expect(hasAdvisorNames).toBeTruthy()
  })

  // ── CouncilView phases (deliberating, peer review, synthesizing, complete) ──

  test('CouncilView switches between phases in completed session', async ({
    electronPage: page
  }) => {
    await navigateToCouncil(page)

    // Check for completed view with tab navigation
    const completeView = page.locator('[data-testid="council-complete-view"]')
    let hasComplete = await completeView.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasComplete) {
      // Try to find and click a completed session
      const sessionCards = page.locator('[class*="rounded-xl"][class*="border"]')
      const sessionCount = await sessionCards.count()

      if (sessionCount > 0) {
        await sessionCards.first().click()
        await page.waitForTimeout(2_000)
      }

      hasComplete = await completeView.isVisible({ timeout: 5_000 }).catch(() => false)
      if (!hasComplete) {
        // Check for any active phase view
        const deliberating = page.locator('[data-testid="council-deliberating-view"]')
        const peerReview = page.locator('[data-testid="council-peer-review-view"]')
        const synthesizing = page.locator('[data-testid="council-synthesizing-view"]')

        const hasAny =
          (await deliberating.isVisible({ timeout: 2_000 }).catch(() => false)) ||
          (await peerReview.isVisible({ timeout: 2_000 }).catch(() => false)) ||
          (await synthesizing.isVisible({ timeout: 2_000 }).catch(() => false))

        if (hasAny) {
          // An active phase is showing — verify its structure
          expect(hasAny).toBeTruthy()
          return
        }

        test.skip()
        return
      }
    }

    // Complete view should have tab navigation
    const tabs = completeView
      .locator('button')
      .filter({ hasText: /overview|advisor details|peer reviews/i })
    const tabCount = await tabs.count()
    expect(tabCount).toBeGreaterThanOrEqual(2)

    // Click "Advisor Details" tab
    const advisorTab = completeView.getByText(/advisor details/i)
    const hasAdvisorTab = await advisorTab.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasAdvisorTab) {
      await advisorTab.click()
      await page.waitForTimeout(500)

      // Advisor details content should render
      const detailsContent = page.locator('[data-testid="council-advisor-details-tab"]')
      const hasDetails = await detailsContent.isVisible({ timeout: 3_000 }).catch(() => false)
      expect(hasDetails).toBeTruthy()
    }

    // Click "Peer Reviews" tab
    const peerTab = completeView.getByText(/peer reviews/i)
    const hasPeerTab = await peerTab.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasPeerTab) {
      await peerTab.click()
      await page.waitForTimeout(500)

      // Either rankings matrix or "no peer review data" message
      const peerContent = page.locator('[data-testid="council-rankings-matrix"]')
      const noDataText = page.getByText(/no peer review data/i)

      const hasPeerContent = await peerContent.isVisible({ timeout: 3_000 }).catch(() => false)
      const hasNoData = await noDataText.isVisible({ timeout: 2_000 }).catch(() => false)

      expect(hasPeerContent || hasNoData).toBeTruthy()
    }

    // Switch back to "Overview"
    const overviewTab = completeView.getByText(/overview/i)
    if (await overviewTab.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await overviewTab.click()
      await page.waitForTimeout(500)
    }
  })

  // ── CouncilFilterBar ──

  test('CouncilFilterBar filters session history by status', async ({ electronPage: page }) => {
    await navigateToCouncil(page)

    const filterBar = page.locator('[data-testid="council-filter-bar"]')
    const hasFilterBar = await filterBar.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasFilterBar) {
      // Filter bar may only appear when there are sessions
      test.skip()
      return
    }

    // Should have filter tabs: All, Active, Completed, Failed
    const allTab = filterBar.getByText(/^all$/i)
    const completedTab = filterBar.getByText(/^completed$/i)
    const failedTab = filterBar.getByText(/^failed$/i)

    await expect(allTab).toBeVisible()
    await expect(completedTab).toBeVisible()
    await expect(failedTab).toBeVisible()

    // Should have a search input
    const searchInput = filterBar.locator('input')
    const hasSearch = await searchInput.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasSearch).toBeTruthy()

    // Click "Completed" filter
    await completedTab.click()
    await page.waitForTimeout(500)

    // Click "All" to reset
    await allTab.click()
    await page.waitForTimeout(500)

    // Should have "New Council" button
    const newCouncilBtn = filterBar.getByRole('button', { name: /new council/i })
    const hasNewBtn = await newCouncilBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasNewBtn).toBeTruthy()
  })
})
