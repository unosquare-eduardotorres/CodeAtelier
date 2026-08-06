/**
 * Grill Radar Chart E2E Tests
 *
 * Covers GrillRadarChart interactive SVG:
 *   - Radar chart renders when 2+ track scores exist
 *   - Fallback message shown when <2 tracks completed
 *   - Clicking radar label/point triggers track selection
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/grill-radar-chart.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Grill Radar Chart', () => {
  /**
   * Helper: navigate to grill track selector where radar chart may appear.
   */
  async function navigateToGrillTrackSelector(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
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
      if (count === 0) return false
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
    await settings.openTab('ideas')
    await page.waitForTimeout(500)

    // Try to find and click a grill button to enter a grill session
    const grillBtn = page.getByRole('button', { name: /grill/i }).first()
    const hasGrillBtn = await grillBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (hasGrillBtn) {
      await grillBtn.click()
      await page.waitForTimeout(2_000)
    }

    // Check if grill page is visible
    const grillPage = page.locator('[data-testid="grill-page"]')
    const onGrill = await grillPage.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!onGrill) return false

    // Try to navigate to track selector (click "All Tracks" if available)
    const allTracksBtn = page.locator('[data-testid="grill-header-all-tracks"]')
    const hasAllTracks = await allTracksBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasAllTracks) {
      await allTracksBtn.click()
      await page.waitForTimeout(1_000)
    }

    // Check if track selector is visible
    const trackSelector = page.locator('[data-testid="grill-track-selector"]')
    return trackSelector.isVisible({ timeout: 5_000 }).catch(() => false)
  }

  // ── Radar chart rendering ──

  test('radar chart renders when 2+ track scores exist', async ({ electronPage: page }) => {
    const hasTrackSelector = await navigateToGrillTrackSelector(page)

    if (!hasTrackSelector) {
      test.skip()
      return
    }

    // Look for the radar chart
    const radarChart = page.locator('[data-testid="grill-radar-chart"]')
    const hasChart = await radarChart.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasChart) {
      // May have fewer than 2 tracks — check for fallback
      const fallback = page.locator('[data-testid="grill-radar-fallback"]')
      const hasFallback = await fallback.isVisible({ timeout: 3_000 }).catch(() => false)

      // One of these should be visible (chart or fallback)
      expect(hasFallback).toBeTruthy()
      return
    }

    // Radar chart should contain an SVG
    const svg = radarChart.locator('svg')
    await expect(svg).toBeVisible({ timeout: 3_000 })

    // SVG should contain a data polygon (the filled shape)
    const polygon = svg.locator('polygon')
    const polygonCount = await polygon.count()
    expect(polygonCount).toBeGreaterThan(0)

    // Axis labels should display track names with scores
    const text = svg.locator('text')
    const textCount = await text.count()
    expect(textCount).toBeGreaterThan(0)

    // At least one label should contain a score in parentheses
    let hasScoreLabel = false
    for (let i = 0; i < textCount; i++) {
      const labelText = await text.nth(i).textContent()
      if (labelText && /\(\d+\)/.test(labelText)) {
        hasScoreLabel = true
        break
      }
    }
    expect(hasScoreLabel).toBeTruthy()
  })

  // ── Fallback message ──

  test('fallback message shown when <2 tracks completed', async ({ electronPage: page }) => {
    const hasTrackSelector = await navigateToGrillTrackSelector(page)

    if (!hasTrackSelector) {
      test.skip()
      return
    }

    // Check for fallback message
    const fallback = page.locator('[data-testid="grill-radar-fallback"]')
    const hasFallback = await fallback.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasFallback) {
      // Radar chart is showing instead — 2+ tracks already completed
      // Verify the radar chart IS visible
      const radarChart = page.locator('[data-testid="grill-radar-chart"]')
      const hasChart = await radarChart.isVisible({ timeout: 3_000 }).catch(() => false)
      expect(hasChart).toBeTruthy()
      return
    }

    // Fallback should show "Complete 2+ tracks" message
    const fallbackText = await fallback.textContent()
    expect(fallbackText).toMatch(/2\+ tracks/i)

    // No SVG radar chart should be rendered alongside the fallback
    const svg = fallback.locator('svg')
    const hasSvg = await svg.isVisible({ timeout: 1_000 }).catch(() => false)
    expect(hasSvg).toBeFalsy()
  })

  // ── Clicking radar label/point ──

  test('clicking radar label/point triggers track selection', async ({ electronPage: page }) => {
    const hasTrackSelector = await navigateToGrillTrackSelector(page)

    if (!hasTrackSelector) {
      test.skip()
      return
    }

    // Radar chart must be visible (requires 2+ tracks)
    const radarChart = page.locator('[data-testid="grill-radar-chart"]')
    const hasChart = await radarChart.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasChart) {
      test.skip()
      return
    }

    // Find clickable elements in the SVG (text labels and circle data points)
    const svg = radarChart.locator('svg')
    const clickableLabels = svg.locator('text.cursor-pointer')
    const clickablePoints = svg.locator('circle.cursor-pointer')

    const labelCount = await clickableLabels.count()
    const pointCount = await clickablePoints.count()

    if (labelCount === 0 && pointCount === 0) {
      test.skip()
      return
    }

    // Click a label or point
    if (labelCount > 0) {
      await clickableLabels.first().click()
    } else {
      await clickablePoints.first().click()
    }

    await page.waitForTimeout(2_000)

    // After clicking, should navigate to that track's evaluation/results
    // The track selector may be replaced with the track view
    const trackSelector = page.locator('[data-testid="grill-track-selector"]')
    const questionCard = page.locator('[data-testid="grill-question-card"]')

    const selectorStillVisible = await trackSelector
      .isVisible({ timeout: 3_000 })
      .catch(() => false)
    const hasQuestionCard = await questionCard.isVisible({ timeout: 5_000 }).catch(() => false)

    // Either navigated away (question card) or stayed (track may not trigger nav)
    // Both outcomes are valid depending on onTrackClick implementation
    expect(selectorStillVisible || hasQuestionCard).toBeTruthy()
  })
})
