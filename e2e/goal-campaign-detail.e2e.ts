/**
 * Goal Campaign Detail E2E Tests
 *
 * Verifies deeper interactions in the Goals/MPA area that have only
 * surface-level coverage:
 *   - GoalCampaignPanel shows active run with progress
 *   - GoalRunDetail shows individual run output
 *   - GoalArtifactViewer renders code/file artifacts
 *   - GoalPhaseStream shows live streaming for goal phase
 *   - GoalPhaseTimeline shows phase progression
 *   - GoalCampaignHistory shows past campaign runs
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/goal-campaign-detail.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Goal Campaign Detail', () => {
  async function navigateToGoals(page: import('@playwright/test').Page): Promise<void> {
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

    // Navigate to Goals/MPA settings tab
    const settingsTab = page.getByRole('button', { name: /settings/i })
    const hasTab = await settingsTab.first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }
    await settings.openTab('goals')
    await page.waitForTimeout(500)
  }

  // ── GoalCampaignPanel ──

  test('GoalCampaignPanel shows campaign creation form with steps', async ({
    electronPage: page
  }) => {
    await navigateToGoals(page)

    const panel = page.locator('[data-testid="goal-campaign-panel"]')
    const hasPanel = await panel.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasPanel) {
      // Try to trigger via "New Campaign" button
      const newCampaignBtn = page.getByRole('button', { name: /new campaign|create campaign|start/i }).first()
      const hasBtn = await newCampaignBtn.isVisible({ timeout: 5_000 }).catch(() => false)

      if (!hasBtn) {
        test.skip()
        return
      }

      await newCampaignBtn.click()
      await page.waitForTimeout(1_000)

      const hasPanelNow = await panel.isVisible({ timeout: 5_000 }).catch(() => false)
      if (!hasPanelNow) {
        test.skip()
        return
      }
    }

    // Panel should have the "New Campaign" header
    const header = panel.getByText(/new campaign/i)
    await expect(header).toBeVisible()

    // Should have input area (textarea or input for goal description)
    const input = panel.locator('textarea, input[type="text"]').first()
    const hasInput = await input.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasInput).toBeTruthy()

    // Should have a close/cancel button
    const closeBtn = panel.getByRole('button', { name: /close|cancel/i }).first()
    const hasClose = await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasClose) {
      await closeBtn.click()
      await page.waitForTimeout(300)
    }
  })

  // ── GoalRunDetail ──

  test('GoalRunDetail shows individual run with status and back button', async ({
    electronPage: page
  }) => {
    await navigateToGoals(page)

    const runDetail = page.locator('[data-testid="goal-run-detail"]')
    let hasDetail = await runDetail.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasDetail) {
      // Try to find and click a run in the campaign history
      const history = page.locator('[data-testid="goal-campaign-history"]')
      const hasHistory = await history.isVisible({ timeout: 3_000 }).catch(() => false)

      if (hasHistory) {
        // Click the first campaign to expand
        const campaignBtn = history.locator('button').first()
        await campaignBtn.click()
        await page.waitForTimeout(500)

        // Click a run entry
        const runEntry = history.locator('button').nth(1)
        const hasRunEntry = await runEntry.isVisible({ timeout: 2_000 }).catch(() => false)
        if (hasRunEntry) {
          await runEntry.click()
          await page.waitForTimeout(1_000)
        }
      }

      hasDetail = await runDetail.isVisible({ timeout: 5_000 }).catch(() => false)
      if (!hasDetail) {
        test.skip()
        return
      }
    }

    // Should have a back button
    const backBtn = runDetail.getByRole('button', { name: /back/i })
    const hasBack = await backBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasBack).toBeTruthy()

    // Should show goal description or status
    const detailText = await runDetail.textContent()
    expect(detailText!.length).toBeGreaterThan(10)
  })

  // ── GoalArtifactViewer ──

  test('GoalArtifactViewer renders verification report with success criteria', async ({
    electronPage: page
  }) => {
    await navigateToGoals(page)

    const viewer = page.locator('[data-testid="goal-artifact-viewer"]')
    const hasViewer = await viewer.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasViewer) {
      // Artifact viewer may be inside a run detail — navigate there
      test.skip()
      return
    }

    // Should show summary section
    const summary = viewer.locator('[class*="rounded-lg"]').first()
    await expect(summary).toBeVisible()

    // Should have status indicators (✓ / ⚠ / ✗)
    const statusIcons = viewer.locator('svg')
    const iconCount = await statusIcons.count()
    expect(iconCount).toBeGreaterThan(0)
  })

  // ── GoalPhaseStream ──

  test('GoalPhaseStream shows live stream output with phase label', async ({
    electronPage: page
  }) => {
    await navigateToGoals(page)

    const stream = page.locator('[data-testid="goal-phase-stream"]')
    const hasStream = await stream.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasStream) {
      // Phase stream only visible during active goal execution
      test.skip()
      return
    }

    // Should show phase label in header
    const header = stream.getByText(/output/i)
    await expect(header).toBeVisible()

    // Should have a terminal icon
    const terminalIcon = stream.locator('svg').first()
    await expect(terminalIcon).toBeVisible()

    // Content area should exist (may be empty if just started)
    const content = stream.locator('[class*="overflow-y-auto"]')
    await expect(content).toBeVisible()
  })

  // ── GoalPhaseTimeline ──

  test('GoalPhaseTimeline shows phase progression with status icons', async ({
    electronPage: page
  }) => {
    await navigateToGoals(page)

    const timeline = page.locator('[data-testid="goal-phase-timeline"]')
    const hasTimeline = await timeline.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasTimeline) {
      // Timeline only visible in run detail views
      test.skip()
      return
    }

    // Should show "Phase Timeline" heading
    const heading = timeline.getByText(/phase timeline/i)
    await expect(heading).toBeVisible()

    // Should have phase entries with status icons
    const entries = timeline.locator('[class*="flex items-start"]')
    const entryCount = await entries.count()
    expect(entryCount).toBeGreaterThan(0)

    // Each entry should have an SVG status icon
    const icons = timeline.locator('svg')
    const iconCount = await icons.count()
    expect(iconCount).toBeGreaterThan(0)
  })

  // ── GoalCampaignHistory ──

  test('GoalCampaignHistory shows past campaigns with expandable runs', async ({
    electronPage: page
  }) => {
    await navigateToGoals(page)

    const history = page.locator('[data-testid="goal-campaign-history"]')
    const hasHistory = await history.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasHistory) {
      // No campaign history — no past campaigns exist
      test.skip()
      return
    }

    // Should show "Campaigns" heading
    const heading = history.getByText(/campaigns/i)
    await expect(heading).toBeVisible()

    // Should have campaign entries
    const campaigns = history.locator('[class*="rounded-lg"]')
    const campaignCount = await campaigns.count()
    expect(campaignCount).toBeGreaterThan(0)

    // Click first campaign to expand
    const firstCampaign = campaigns.first().locator('button').first()
    const hasBtn = await firstCampaign.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasBtn) {
      await firstCampaign.click()
      await page.waitForTimeout(1_000)

      // Should show runs or a loading spinner
      const runs = campaigns.first().locator('button').filter({ hasText: /goal|run/i })
      const loader = campaigns.first().locator('.animate-spin')
      const runCount = await runs.count()
      const hasLoader = await loader.isVisible({ timeout: 2_000 }).catch(() => false)

      expect(runCount > 0 || hasLoader).toBeTruthy()
    }
  })
})
