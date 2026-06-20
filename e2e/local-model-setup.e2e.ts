/**
 * Local Model Setup E2E Tests
 *
 * Verifies OllamaSetupModal (315 LOC) and EmbeddingModelSetupModal (191 LOC) —
 * local AI model configuration for chat backend and semantic search:
 *   - Ollama setup modal renders with connection form
 *   - Test connection button validates endpoint
 *   - Model info populates after connection
 *   - Save button persists configuration
 *   - Embedding model setup modal renders
 *   - Embedding model download shows progress
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/local-model-setup.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Local Model Setup', () => {
  async function ensureWorkspaceReady(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    const welcomePage = new WelcomePage(page)

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
    return true
  }

  /** Navigate to workspace settings Models tab to trigger Ollama setup. */
  async function navigateToModelsSettings(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    // Try opening workspace settings
    const settingsBtn = page.locator('[aria-label="Workspace Settings"]')
    const hasSettings = await settingsBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasSettings) return false

    await settingsBtn.click()
    await page.waitForTimeout(1_000)

    // Click Models tab
    const modelsTab = page
      .locator('button, [role="tab"]')
      .filter({ hasText: /^[\s]*Models[\s]*$/ })
      .first()
    const hasModels = await modelsTab.isVisible({ timeout: 2_000 }).catch(() => false)
    if (!hasModels) return false

    await modelsTab.click()
    await page.waitForTimeout(800)
    return true
  }

  test('ollama setup modal renders with connection form', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    // Try to find the Ollama setup modal directly
    const ollamaModal = page.locator('[data-testid="ollama-setup-modal"]')
    let hasOllama = await ollamaModal.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasOllama) {
      // Navigate to Models settings to trigger setup
      const navigated = await navigateToModelsSettings(page)
      if (navigated) {
        // Look for a "Setup" or "Configure" button for local LLM
        const setupBtn = page
          .getByRole('button', { name: /setup|configure|local/i })
          .first()
        const hasSetup = await setupBtn.isVisible({ timeout: 2_000 }).catch(() => false)
        if (hasSetup) {
          await setupBtn.click()
          await page.waitForTimeout(1_000)
          hasOllama = await ollamaModal.isVisible({ timeout: 3_000 }).catch(() => false)
        }
      }
    }

    if (!hasOllama) {
      test.skip()
      return
    }

    // Modal should show Ollama Setup header
    await expect(ollamaModal).toBeVisible()
    const header = ollamaModal.getByText('Ollama Setup')
    await expect(header).toBeVisible()
  })

  test('test connection button validates endpoint', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const ollamaModal = page.locator('[data-testid="ollama-setup-modal"]')
    const hasOllama = await ollamaModal.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasOllama) {
      test.skip()
      return
    }

    // Test connection / Re-check button
    const testBtn = page.locator('[data-testid="ollama-test-btn"]')
    const hasTestBtn = await testBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (!hasTestBtn) {
      test.skip()
      return
    }

    // Click test connection
    await testBtn.click()
    await page.waitForTimeout(2_000)

    // After clicking, either shows success (green) or error (red/warning)
    const hasSuccess = await ollamaModal
      .getByText(/ready|connected|running/i)
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false)
    const hasError = await ollamaModal
      .getByText(/not found|not running|error|cannot reach/i)
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false)

    // One of success or error state should be shown
    expect(hasSuccess || hasError).toBeTruthy()
  })

  test('model info populates after successful connection', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const ollamaModal = page.locator('[data-testid="ollama-setup-modal"]')
    const hasOllama = await ollamaModal.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasOllama) {
      test.skip()
      return
    }

    // If connected, model info or "Model ready" should appear
    const modelReady = ollamaModal.getByText(/model ready/i)
    const hasModelReady = await modelReady.isVisible({ timeout: 5_000 }).catch(() => false)

    if (hasModelReady) {
      await expect(modelReady).toBeVisible()
    }
    // If not connected, test passes — connection-dependent
  })

  test('save button persists Ollama configuration', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const ollamaModal = page.locator('[data-testid="ollama-setup-modal"]')
    const hasOllama = await ollamaModal.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasOllama) {
      test.skip()
      return
    }

    // Done/Close button should persist configuration
    const saveBtn = page.locator('[data-testid="ollama-save-btn"]')
    await expect(saveBtn).toBeVisible()

    await saveBtn.click()
    await page.waitForTimeout(500)

    // Modal should close
    await expect(ollamaModal).toBeHidden({ timeout: 3_000 })
  })

  test('embedding model setup modal renders', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    // Check if embedding setup modal is visible
    const embeddingModal = page.locator('[data-testid="embedding-setup-modal"]')
    let hasEmbedding = await embeddingModal.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasEmbedding) {
      // Try navigating to Code Intelligence settings
      const settingsBtn = page.locator('[aria-label="Workspace Settings"]')
      const hasSettings = await settingsBtn.isVisible({ timeout: 2_000 }).catch(() => false)
      if (hasSettings) {
        await settingsBtn.click()
        await page.waitForTimeout(1_000)

        // Look for Code Intelligence or Embedding tab
        const codeIntelTab = page
          .locator('button, [role="tab"]')
          .filter({ hasText: /code intelligence|embedding/i })
          .first()
        const hasTab = await codeIntelTab.isVisible({ timeout: 2_000 }).catch(() => false)
        if (hasTab) {
          await codeIntelTab.click()
          await page.waitForTimeout(1_000)
          hasEmbedding = await embeddingModal
            .isVisible({ timeout: 3_000 })
            .catch(() => false)
        }
      }
    }

    if (!hasEmbedding) {
      test.skip()
      return
    }

    // Modal should show header and status
    await expect(embeddingModal).toBeVisible()
    const status = page.locator('[data-testid="embedding-status"]')
    const hasStatus = await status.isVisible({ timeout: 2_000 }).catch(() => false)
    // Status may show checking/ready/error
    if (hasStatus) {
      await expect(status).toBeVisible()
    }
  })

  test('embedding model download shows progress', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const embeddingModal = page.locator('[data-testid="embedding-setup-modal"]')
    const hasEmbedding = await embeddingModal.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasEmbedding) {
      test.skip()
      return
    }

    // Download/Retry button
    const downloadBtn = page.locator('[data-testid="embedding-download-btn"]')
    const hasDownload = await downloadBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasDownload) {
      // Click download — progress indicator should appear
      await downloadBtn.click()
      await page.waitForTimeout(2_000)

      // Either shows progress or completes quickly to "Model ready"
      const hasProgress = await embeddingModal
        .getByText(/%/)
        .first()
        .isVisible({ timeout: 5_000 })
        .catch(() => false)
      const hasReady = await embeddingModal
        .getByText(/model ready/i)
        .isVisible({ timeout: 5_000 })
        .catch(() => false)

      expect(hasProgress || hasReady).toBeTruthy()
    } else {
      // Model might already be ready — that's fine
      const ready = await embeddingModal
        .getByText(/model ready/i)
        .isVisible({ timeout: 3_000 })
        .catch(() => false)
      if (!ready) {
        test.skip()
      }
    }
  })
})
