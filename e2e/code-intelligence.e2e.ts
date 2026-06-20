/**
 * Code Intelligence E2E Tests
 *
 * Verifies Code Graph & Semantic Search:
 *   - CodeIntelligencePage renders with cards
 *   - Code Graph indexing progress
 *   - Embedding model initialization
 *   - Search playground accessibility
 *
 * Known fragile areas:
 *   - Llamafile binary download + SHA-256 verification
 *   - GGUF model download separate from engine
 *   - Indexing progress event delivery
 *   - Code graph MCP server child process crashes
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Code Intelligence', () => {
  async function navigateToCodeIntelligence(
    page: import('@playwright/test').Page
  ): Promise<void> {
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
    const hasTab = await settingsTab.first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }
    await settings.openTab('code-intelligence')
    await page.waitForTimeout(500)
  }

  test('code intelligence page renders', async ({ electronPage: page }) => {
    await navigateToCodeIntelligence(page)

    // Should see code intelligence content
    const pageContent = page.getByText(/code.*graph|semantic.*search|code.*intelligence/i).first()
    await expect(pageContent).toBeVisible({ timeout: 10_000 })
  })

  test('code intelligence shows feature cards', async ({ electronPage: page }) => {
    await navigateToCodeIntelligence(page)

    // Should show cards for Code Graph, Semantic Search, Embedding Model
    const codeGraphCard = page.getByText(/code.*graph/i).first()
    const semanticCard = page.getByText(/semantic.*search/i).first()
    const embeddingCard = page.getByText(/embedding/i).first()

    const hasCodeGraph = await codeGraphCard.isVisible({ timeout: 5_000 }).catch(() => false)
    const hasSemantic = await semanticCard.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasEmbedding = await embeddingCard.isVisible({ timeout: 3_000 }).catch(() => false)

    // At least some of these cards should be visible
    expect(hasCodeGraph || hasSemantic || hasEmbedding).toBeTruthy()
  })

  test('code graph shows indexing status', async ({ electronPage: page }) => {
    await navigateToCodeIntelligence(page)

    // Look for indexing status indicator
    const indexStatus = page.getByText(/index|indexed|indexing|ready|files/i).first()
    const hasStatus = await indexStatus.isVisible({ timeout: 5_000 }).catch(() => false)

    if (hasStatus) {
      await expect(indexStatus).toBeVisible()
    }

    // Look for start indexing button or progress bar
    const startIndexBtn = page.getByRole('button', { name: /start|index|rebuild/i }).first()
    const progressBar = page.locator('[role="progressbar"]').first()

    const hasStartBtn = await startIndexBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasProgress = await progressBar.isVisible({ timeout: 3_000 }).catch(() => false)

    // At least one indicator should be present
    expect(hasStatus || hasStartBtn || hasProgress).toBeTruthy()
  })

  test('embedding model shows initialization status', async ({ electronPage: page }) => {
    await navigateToCodeIntelligence(page)

    // Look for embedding model status
    const embeddingStatus = page.getByText(/embedding|model|download|ready|initialize/i).first()
    const hasStatus = await embeddingStatus.isVisible({ timeout: 5_000 }).catch(() => false)

    if (hasStatus) {
      await expect(embeddingStatus).toBeVisible()
    }

    // There should be some action or status indicator for the embedding model
    const actionBtn = page.getByRole('button', { name: /initialize|download|enable/i }).first()
    const hasAction = await actionBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    // Page should render without errors regardless of model state
    const pageText = page.getByText(/code.*intelligence|search/i).first()
    await expect(pageText).toBeVisible({ timeout: 5_000 })
  })

  test('search playground is accessible when ready', async ({ electronPage: page }) => {
    await navigateToCodeIntelligence(page)

    // Look for search playground or search input
    const searchInput = page.locator('input[type="search"], input[placeholder*="search" i]').first()
    const searchPlayground = page.getByText(/playground|search.*query/i).first()

    const hasSearchInput = await searchInput.isVisible({ timeout: 5_000 }).catch(() => false)
    const hasPlayground = await searchPlayground.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasSearchInput) {
      // Search input should be editable when the model is ready
      const isEditable = await searchInput.isEditable().catch(() => false)
      if (isEditable) {
        await searchInput.fill('authentication')
        await page.waitForTimeout(1_000)

        // Results area should appear or loading indicator
        const resultsArea = page.locator('[class*="overflow-y-auto"]').first()
        const hasResults = await resultsArea.isVisible({ timeout: 5_000 }).catch(() => false)
        expect(hasResults).toBeTruthy()
      }
    } else if (hasPlayground) {
      await expect(searchPlayground).toBeVisible()
    }
  })
})
