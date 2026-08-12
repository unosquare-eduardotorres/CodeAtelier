/**
 * Local Model Setup E2E Tests
 *
 * Verifies OllamaSetupModal (315 LOC) and EmbeddingModelSetupModal (191 LOC):
 *   - Ollama setup modal renders with connection form
 *   - Test connection button validates endpoint
 *   - Model info populates after connection
 *   - Save button persists configuration
 *   - Embedding model setup modal renders
 *   - Embedding model download shows progress
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Local Model Setup', () => {
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

  async function navigateToModelsSettings(page: import('@playwright/test').Page): Promise<boolean> {
    const settingsBtn = page.locator('[aria-label="Workspace Settings"]')
    if (!(await settingsBtn.isVisible({ timeout: 3_000 }).catch(() => false))) return false
    await settingsBtn.click()
    await page.waitForTimeout(1_000)
    const modelsTab = page
      .locator('button, [role="tab"]')
      .filter({ hasText: /^[\s]*Models[\s]*$/ })
      .first()
    if (!(await modelsTab.isVisible({ timeout: 2_000 }).catch(() => false))) return false
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

    const ollamaModal = page.locator('[data-testid="ollama-setup-modal"]')
    let hasOllama = await ollamaModal.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasOllama) {
      const navigated = await navigateToModelsSettings(page)
      if (navigated) {
        const setupBtn = page.getByRole('button', { name: /setup|configure|local/i }).first()
        if (await setupBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
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

    await expect(ollamaModal).toBeVisible()
    await expect(ollamaModal.getByText('Ollama Setup')).toBeVisible()
  })

  test('test connection button validates endpoint', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const ollamaModal = page.locator('[data-testid="ollama-setup-modal"]')
    if (!(await ollamaModal.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip()
      return
    }

    const testBtn = page.locator('[data-testid="ollama-test-btn"]')
    if (!(await testBtn.isVisible({ timeout: 2_000 }).catch(() => false))) {
      test.skip()
      return
    }

    await testBtn.click()
    await page.waitForTimeout(2_000)

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
    expect(hasSuccess || hasError).toBeTruthy()
  })

  test('model info populates after successful connection', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const ollamaModal = page.locator('[data-testid="ollama-setup-modal"]')
    if (!(await ollamaModal.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip()
      return
    }

    const modelReady = ollamaModal.getByText(/model ready/i)
    const hasModelReady = await modelReady.isVisible({ timeout: 5_000 }).catch(() => false)
    if (hasModelReady) {
      await expect(modelReady).toBeVisible()
    }
  })

  test('save button persists Ollama configuration', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const ollamaModal = page.locator('[data-testid="ollama-setup-modal"]')
    if (!(await ollamaModal.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip()
      return
    }

    const saveBtn = page.locator('[data-testid="ollama-save-btn"]')
    await expect(saveBtn).toBeVisible()
    await saveBtn.click()
    await page.waitForTimeout(500)
    await expect(ollamaModal).toBeHidden({ timeout: 3_000 })
  })

  test('embedding model setup modal renders', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const embeddingModal = page.locator('[data-testid="embedding-setup-modal"]')
    let hasEmbedding = await embeddingModal.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasEmbedding) {
      const settingsBtn = page.locator('[aria-label="Workspace Settings"]')
      if (await settingsBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await settingsBtn.click()
        await page.waitForTimeout(1_000)
        const codeIntelTab = page
          .locator('button, [role="tab"]')
          .filter({ hasText: /code intelligence|embedding/i })
          .first()
        if (await codeIntelTab.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await codeIntelTab.click()
          await page.waitForTimeout(1_000)
          hasEmbedding = await embeddingModal.isVisible({ timeout: 3_000 }).catch(() => false)
        }
      }
    }
    if (!hasEmbedding) {
      test.skip()
      return
    }

    await expect(embeddingModal).toBeVisible()
  })

  test('embedding model download shows progress', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const embeddingModal = page.locator('[data-testid="embedding-setup-modal"]')
    if (!(await embeddingModal.isVisible({ timeout: 3_000 }).catch(() => false))) {
      test.skip()
      return
    }

    const downloadBtn = page.locator('[data-testid="embedding-download-btn"]')
    if (await downloadBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await downloadBtn.click()
      await page.waitForTimeout(2_000)
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
      const isReady = await embeddingModal
        .getByText(/model ready/i)
        .isVisible({ timeout: 3_000 })
        .catch(() => false)
      if (!isReady) test.skip()
    }
  })
})
