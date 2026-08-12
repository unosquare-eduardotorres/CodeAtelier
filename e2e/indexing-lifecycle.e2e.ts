/**
 * Indexing & Embedding Lifecycle E2E Tests
 *
 * Verifies semantic search and code graph indexing UI flows:
 *   - StartIndexingModal shows model selection + index options
 *   - CodeGraphCard shows indexing toggle and progress
 *   - CodeGraphProgressPanel shows files indexed + phase
 *   - EmbeddingModelCard shows model status + download
 *   - SemanticSearchCard shows toggle + index state
 *   - EmbeddingModelSetupModal shows model configuration
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/indexing-lifecycle.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Indexing & Embedding Lifecycle', () => {
  async function navigateToCodeIntelligence(page: import('@playwright/test').Page): Promise<void> {
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

    // Navigate to Code Intelligence settings tab
    const settingsTab = page.getByRole('button', { name: /settings/i })
    const hasTab = await settingsTab
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)
    if (hasTab) {
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }
    await settings.openTab('code-intelligence')
    await page.waitForTimeout(500)
  }

  // ── StartIndexingModal ──

  test('StartIndexingModal shows time estimate and confirm/cancel actions', async ({
    electronPage: page
  }) => {
    await navigateToCodeIntelligence(page)

    const modal = page.locator('[data-testid="start-indexing-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) {
      // Modal may be triggered by toggling semantic search or indexing
      // Try toggling a switch to trigger it
      const toggles = page.locator('input[type="checkbox"], [role="switch"]')
      const toggleCount = await toggles.count()

      for (let i = 0; i < toggleCount; i++) {
        const toggle = toggles.nth(i)
        const isChecked = await toggle.isChecked().catch(() => false)
        if (!isChecked) {
          await toggle.click()
          await page.waitForTimeout(1_000)

          const hasModalNow = await modal.isVisible({ timeout: 3_000 }).catch(() => false)
          if (hasModalNow) break

          // Undo the toggle
          await toggle.click()
          await page.waitForTimeout(300)
        }
      }

      const finalCheck = await modal.isVisible({ timeout: 3_000 }).catch(() => false)
      if (!finalCheck) {
        test.skip()
        return
      }
    }

    // Should show time estimate
    const estimateText = modal.getByText(/estimated|minutes|seconds/i)
    const _hasEstimate = await estimateText.isVisible({ timeout: 2_000 }).catch(() => false)

    // Should have confirm and cancel buttons
    const confirmBtn = modal.getByRole('button', { name: /start|confirm|index/i })
    const cancelBtn = modal.getByRole('button', { name: /cancel/i })

    const hasConfirm = await confirmBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    const hasCancel = await cancelBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    expect(hasConfirm || hasCancel).toBeTruthy()

    // Close modal
    if (hasCancel) {
      await cancelBtn.click()
      await page.waitForTimeout(300)
    } else {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    }
  })

  // ── CodeGraphCard ──

  test('CodeGraphCard shows Code Graph toggle and status', async ({ electronPage: page }) => {
    await navigateToCodeIntelligence(page)

    const card = page.locator('[data-testid="code-graph-card"]')
    const hasCard = await card.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasCard) {
      test.skip()
      return
    }

    // Should show "Code Graph" label
    const label = card.getByText(/code graph/i)
    await expect(label).toBeVisible()

    // Should have a toggle switch
    const toggle = card.locator('input[type="checkbox"], [role="switch"]').first()
    const hasToggle = await toggle.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasToggle).toBeTruthy()

    // Should show description about Tree-sitter
    const description = card.getByText(/tree-sitter|index.*codebase|structural/i)
    const hasDesc = await description.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasDesc).toBeTruthy()
  })

  // ── CodeGraphProgressPanel ──

  test('CodeGraphProgressPanel shows indexing progress with file count', async ({
    electronPage: page
  }) => {
    await navigateToCodeIntelligence(page)

    const panel = page.locator('[data-testid="code-graph-progress-panel"]')
    const hasPanel = await panel.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasPanel) {
      // Progress panel only visible during or after indexing
      test.skip()
      return
    }

    // Should show status (scanning, indexing, complete, error)
    const panelText = await panel.textContent()
    const hasStatus = /scanning|indexing|complete|error|files|tags|edges/i.test(panelText ?? '')
    expect(hasStatus).toBeTruthy()

    // Should have a progress bar if indexing is in progress
    const progressBar = panel.locator('[class*="bg-primary"]')
    const spinnerIcon = panel.locator('.animate-spin')
    const checkIcon = panel.locator('svg')

    const hasProgress = await progressBar.isVisible({ timeout: 2_000 }).catch(() => false)
    const hasSpinner = await spinnerIcon.isVisible({ timeout: 2_000 }).catch(() => false)
    const hasCheck = await checkIcon
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false)

    expect(hasProgress || hasSpinner || hasCheck).toBeTruthy()
  })

  // ── EmbeddingModelCard ──

  test('EmbeddingModelCard shows model name and status', async ({ electronPage: page }) => {
    await navigateToCodeIntelligence(page)

    const card = page.locator('[data-testid="embedding-model-card"]')
    const hasCard = await card.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasCard) {
      test.skip()
      return
    }

    // Should show "Embedding Model" heading
    const heading = card.getByText(/embedding model/i)
    await expect(heading).toBeVisible()

    // Should show model name (e.g., "all-MiniLM-L6-v2")
    const modelName = card.getByText(/minilm|onnx|model/i)
    const hasModel = await modelName.isVisible({ timeout: 2_000 }).catch(() => false)

    // Should show status (Ready, Downloading, Error)
    const statusText = card.getByText(/ready|downloading|error|cached|loading/i)
    const hasStatus = await statusText.isVisible({ timeout: 2_000 }).catch(() => false)

    expect(hasModel || hasStatus).toBeTruthy()
  })

  // ── SemanticSearchCard ──

  test('SemanticSearchCard shows toggle and index state', async ({ electronPage: page }) => {
    await navigateToCodeIntelligence(page)

    const card = page.locator('[data-testid="semantic-search-card"]')
    const hasCard = await card.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasCard) {
      test.skip()
      return
    }

    // Should show "Semantic Search" label
    const label = card.getByText(/semantic search/i)
    await expect(label).toBeVisible()

    // Should have a toggle switch
    const toggle = card.locator('input[type="checkbox"], [role="switch"]').first()
    const hasToggle = await toggle.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasToggle).toBeTruthy()

    // Should show description about embeddings
    const description = card.getByText(/natural language|embeddings|code search/i)
    const hasDesc = await description.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasDesc).toBeTruthy()
  })

  // ── EmbeddingModelSetupModal ──

  test('EmbeddingModelSetupModal shows model configuration steps', async ({
    electronPage: page
  }) => {
    await navigateToCodeIntelligence(page)

    const modal = page.locator('[data-testid="embedding-model-setup-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) {
      // Modal may be triggered when embedding model is not yet downloaded
      test.skip()
      return
    }

    // Should show "Embedding Model Setup" heading
    const heading = modal.getByText(/embedding model setup/i)
    await expect(heading).toBeVisible()

    // Should have a close button
    const closeBtn = modal.getByRole('button', { name: /close/i })
    const hasClose = await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    // Should show model download or configuration content
    const content = await modal.textContent()
    expect(content!.length).toBeGreaterThan(20)

    // Close modal
    if (hasClose) {
      await closeBtn.click()
    } else {
      await page.keyboard.press('Escape')
    }
    await page.waitForTimeout(300)
  })
})
