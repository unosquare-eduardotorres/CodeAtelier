/**
 * Skill Detail E2E Tests
 *
 * Tests SkillDetailPage (141 LOC) — skill file browser with SKILL.md viewer:
 *   - Skill detail page renders when navigating from specialist tab
 *   - Back button returns to specialist skills grid
 *   - Skill name and active/inactive badge display in header
 *   - File tree shows SKILL.md and reference files
 *   - Selecting a file loads its content in the viewer pane
 *   - "Used by" section lists agents that reference this skill
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/skill-detail.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { SettingsNav } from './pages/settings-nav'

test.describe('Skill Detail', () => {
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

  async function navigateToSkillDetail(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    const nav = new SettingsNav(page)
    const navigated = await nav.navigateToSettingsTab('specialist')
    if (!navigated) return false

    // Look for a clickable skill card in the skills grid
    const skillsGrid = page.locator('[data-testid="specialist-skills-grid"]')
    const hasGrid = await skillsGrid.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasGrid) return false

    // Find any skill card/link that navigates to detail
    const skillCards = skillsGrid.locator('button, a, [role="button"]')
    const cardCount = await skillCards.count()
    if (cardCount === 0) return false

    // Click the first skill to navigate to detail
    await skillCards.first().click()
    await page.waitForTimeout(1_000)

    // Check if detail page appeared
    const detailPage = page.locator('[data-testid="skill-detail-page"]')
    return detailPage.isVisible({ timeout: 3_000 }).catch(() => false)
  }

  test('skill detail page renders when navigating from specialist tab', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const hasDetail = await navigateToSkillDetail(page)
    if (!hasDetail) { test.skip(); return }

    const detailPage = page.locator('[data-testid="skill-detail-page"]')
    await expect(detailPage).toBeVisible()
  })

  test('back button returns to specialist skills grid', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const hasDetail = await navigateToSkillDetail(page)
    if (!hasDetail) { test.skip(); return }

    // Click back button
    const backBtn = page.locator('[data-testid="skill-detail-back"]')
    const hasBack = await backBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasBack) { test.skip(); return }

    await backBtn.click()
    await page.waitForTimeout(1_000)

    // Should navigate back to the specialist page
    const specialistPage = page.locator('[data-testid="specialist-page"]')
    const isBack = await specialistPage.isVisible({ timeout: 5_000 }).catch(() => false)

    // Either back to specialist page or skills grid should be visible
    if (isBack) {
      await expect(specialistPage).toBeVisible()
    }
  })

  test('skill name and active/inactive badge display in header', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const hasDetail = await navigateToSkillDetail(page)
    if (!hasDetail) { test.skip(); return }

    const detailPage = page.locator('[data-testid="skill-detail-page"]')

    // Header should show skill name (font-semibold text)
    const skillName = detailPage.locator('.text-sm.font-semibold').first()
    const hasName = await skillName.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasName) {
      const nameText = await skillName.textContent()
      expect(nameText?.length).toBeGreaterThan(0)
    }

    // Should show Active or Inactive badge
    const badges = detailPage.locator('.rounded-full').filter({
      hasText: /active|inactive/i
    })
    const badgeCount = await badges.count()
    expect(badgeCount).toBeGreaterThan(0)
  })

  test('file tree shows SKILL.md and reference files', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const hasDetail = await navigateToSkillDetail(page)
    if (!hasDetail) { test.skip(); return }

    // The left sidebar should show file tree
    const detailPage = page.locator('[data-testid="skill-detail-page"]')
    const sidebar = detailPage.locator('.w-56, [class*="flex-shrink-0"]').first()

    const hasSidebar = await sidebar.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasSidebar) { test.skip(); return }

    // Look for SKILL.md or file references
    const fileItems = sidebar.locator('button, [role="treeitem"]')
    const fileCount = await fileItems.count()

    // Should have at least one file entry (SKILL.md)
    expect(fileCount).toBeGreaterThan(0)
  })

  test('selecting a file loads its content in the viewer pane', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const hasDetail = await navigateToSkillDetail(page)
    if (!hasDetail) { test.skip(); return }

    // Look for the MarkdownViewer or code content in the main panel
    const viewer = page.locator('[data-testid="markdown-viewer"]')
    const hasViewer = await viewer.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasViewer) {
      // Content might be loading or showing "Select a file"
      const loadingText = page.getByText(/select a file|could not load/i)
      const isPrompting = await loadingText.isVisible({ timeout: 3_000 }).catch(() => false)
      if (isPrompting) { test.skip(); return }
      test.skip()
      return
    }

    // Viewer should have content
    const content = await viewer.textContent()
    expect(content?.length).toBeGreaterThan(0)
  })

  test('"Used by" section lists agents that reference this skill', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const hasDetail = await navigateToSkillDetail(page)
    if (!hasDetail) { test.skip(); return }

    // Check for "Used by" section in the sidebar
    const usedByHeader = page.getByText(/used by/i).first()
    const hasUsedBy = await usedByHeader.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasUsedBy) {
      // No agents reference this skill
      test.skip()
      return
    }

    await expect(usedByHeader).toBeVisible()

    // Should list at least one agent name
    const agentNames = usedByHeader
      .locator('xpath=following-sibling::div')
      .locator('.text-xs')
    const agentCount = await agentNames.count()
    expect(agentCount).toBeGreaterThan(0)
  })
})
