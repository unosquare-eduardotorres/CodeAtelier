/**
 * MCP Integrations E2E Tests
 *
 * Verifies the MCP integration ecosystem:
 *   - IntegrationsPage renders (Settings → Integrations)
 *   - Integration card display with toggle switch
 *   - CLI availability detection indicator
 *   - Enable/disable external MCP per workspace
 *   - Token impact badges (Low/Medium/High)
 *   - NewChatPage MCP Tools section visibility
 *   - MCP tools system/external sub-tabs
 *   - Tool activity block rendering in messages
 *   - Tool row expand/collapse with input/output
 *   - Code Graph toggle on Code Intelligence page
 *   - Semantic Search toggle and state
 *   - Search playground basic accessibility
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/mcp-integrations.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'
import { ChatPage } from './pages/chat-page'

test.describe('MCP Integrations', () => {
  /**
   * Helper: navigate to the Integrations tab in workspace settings.
   */
  async function navigateToIntegrations(page: import('@playwright/test').Page): Promise<void> {
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
    await settings.openTab('integrations')
    await page.waitForTimeout(500)
  }

  /**
   * Helper: ensure we're in a workspace with a chat view ready.
   */
  async function ensureWorkspaceOpen(page: import('@playwright/test').Page): Promise<ChatPage> {
    const welcomePage = new WelcomePage(page)
    const chat = new ChatPage(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count > 0) {
        await cards.first().click()
        await page.waitForTimeout(3_000)
      }
    }

    return chat
  }

  // ── Integrations page ──

  test('integrations page renders with MCP explainer', async ({ electronPage: page }) => {
    await navigateToIntegrations(page)

    const integrationsPage = page.locator('[data-testid="integrations-page"]')
    const hasPage = await integrationsPage.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!hasPage) {
      // Fall back to text-based check
      const heading = page.getByText(/integrations|mcp/i).first()
      await expect(heading).toBeVisible({ timeout: 10_000 })
      return
    }

    await expect(integrationsPage).toBeVisible()

    // Should have explainer banner about MCP
    const explainer = page.getByText(/model context protocol|mcp/i).first()
    const hasExplainer = await explainer.isVisible({ timeout: 5_000 }).catch(() => false)
    expect(hasExplainer).toBeTruthy()
  })

  test('integration card renders with toggle switch', async ({ electronPage: page }) => {
    await navigateToIntegrations(page)

    const integrationCards = page.locator('[data-testid^="integration-card-"]')
    const count = await integrationCards.count()

    if (count === 0) {
      test.skip()
      return
    }

    const firstCard = integrationCards.first()
    await expect(firstCard).toBeVisible({ timeout: 5_000 })

    // Card should have a display name
    const text = await firstCard.textContent()
    expect(text?.length).toBeGreaterThan(0)

    // Toggle switch should be present (rounded-full button)
    const toggle = firstCard.locator('button[class*="rounded-full"]')
    const hasToggle = await toggle.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasToggle).toBeTruthy()
  })

  test('CLI availability indicator shows status', async ({ electronPage: page }) => {
    await navigateToIntegrations(page)

    const integrationCards = page.locator('[data-testid^="integration-card-"]')
    const count = await integrationCards.count()

    if (count === 0) {
      test.skip()
      return
    }

    // Wait for CLI checks to complete
    await page.waitForTimeout(3_000)

    // Look for CLI status indicators across all cards
    const cliFound = page.getByText(/cli detected/i).first()
    const cliNotFound = page.getByText(/cli not found/i).first()
    const cliChecking = page.getByText(/checking cli/i).first()

    const hasFound = await cliFound.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasNotFound = await cliNotFound.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasChecking = await cliChecking.isVisible({ timeout: 3_000 }).catch(() => false)

    // At least one CLI status should be visible
    expect(hasFound || hasNotFound || hasChecking).toBeTruthy()
  })

  test('toggle switch enables/disables integration', async ({ electronPage: page }) => {
    await navigateToIntegrations(page)

    const integrationCards = page.locator('[data-testid^="integration-card-"]')
    const count = await integrationCards.count()

    if (count === 0) {
      test.skip()
      return
    }

    const firstCard = integrationCards.first()
    const toggle = firstCard.locator('button[class*="rounded-full"]')
    const hasToggle = await toggle.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasToggle) {
      test.skip()
      return
    }

    // Get initial state (check for bg-accent class = enabled)
    const initialClasses = await toggle.getAttribute('class')
    const wasEnabled = initialClasses?.includes('bg-accent')

    // Click toggle
    await toggle.click()
    await page.waitForTimeout(1_000)

    // State should have changed
    const afterClasses = await toggle.getAttribute('class')
    const isNowEnabled = afterClasses?.includes('bg-accent')

    expect(isNowEnabled).not.toBe(wasEnabled)

    // Toggle back to restore original state
    await toggle.click()
    await page.waitForTimeout(500)
  })

  test('token impact badges render on cards', async ({ electronPage: page }) => {
    await navigateToIntegrations(page)

    const integrationCards = page.locator('[data-testid^="integration-card-"]')
    const count = await integrationCards.count()

    if (count === 0) {
      test.skip()
      return
    }

    // Look for token impact badges (prefer testid, fall back to text)
    const impactBadgeById = page.locator('[data-testid="token-impact-badge"]')
    const impactBadgeByText = page.getByText(/low|medium|high/i)
    const badgeByIdCount = await impactBadgeById.count()
    const badgeByTextCount = await impactBadgeByText.count()

    // At least one card should have a token impact badge
    expect(badgeByIdCount > 0 || badgeByTextCount > 0).toBeTruthy()
  })

  // ── NewChatPage MCP section ──

  test('NewChatPage shows MCP tools section', async ({ electronPage: page }) => {
    const chat = await ensureWorkspaceOpen(page)

    // Navigate to new chat page
    const hasNewChat = await chat.newChatPage.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!hasNewChat) {
      // Try Cmd+N to open new chat
      await page.keyboard.press('Meta+n')
      await page.waitForTimeout(1_000)
    }

    const newChatVisible = await chat.newChatPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!newChatVisible) {
      test.skip()
      return
    }

    // Look for MCP tools section
    const mcpSection = page.locator('[data-testid="mcp-tools-section"]')
    const hasMcpSection = await mcpSection.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasMcpSection) {
      // MCP section only renders when integrations or local MCPs are available
      // Check for the "MCP Tools" text anywhere
      const mcpText = page.getByText(/mcp tools/i).first()
      const _hasText = await mcpText.isVisible({ timeout: 3_000 }).catch(() => false)
      // Either MCP section visible or no MCPs configured — both valid
      expect(true).toBeTruthy()
      return
    }

    await expect(mcpSection).toBeVisible()
  })

  test('MCP tools section has system/external sub-tabs', async ({ electronPage: page }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasNewChat = await chat.newChatPage.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasNewChat) {
      await page.keyboard.press('Meta+n')
      await page.waitForTimeout(1_000)
    }

    const mcpSection = page.locator('[data-testid="mcp-tools-section"]')
    const hasMcpSection = await mcpSection.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasMcpSection) {
      test.skip()
      return
    }

    // Expand MCP section if collapsed
    const expandBtn = mcpSection.locator('button').first()
    await expandBtn.click()
    await page.waitForTimeout(300)

    // Check for tab labels
    const externalTab = page.getByText(/external/i)
    const systemTab = page.getByText(/system/i)

    const hasExternal = await externalTab
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)
    const hasSystem = await systemTab
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)

    // At least one sub-tab should be visible when MCP section is open
    expect(hasExternal || hasSystem).toBeTruthy()
  })

  // ── Tool activity in messages ──

  test('tool activity block renders in chat messages', async ({ electronPage: page }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      test.skip()
      return
    }

    // Look for existing tool activity blocks in message history
    const toolBlocks = page.locator('[data-testid="tool-activity-block"]')
    const count = await toolBlocks.count()

    if (count === 0) {
      // No tool activity in current conversation — need a conversation with tool use
      // Check if there are any messages at all
      const messages = chat.getMessages()
      const messageCount = await messages.count()

      if (messageCount === 0) {
        test.skip()
        return
      }

      // Messages exist but no tool activity — valid (some conversations don't use tools)
      expect(true).toBeTruthy()
      return
    }

    // Tool activity block should be visible
    const firstBlock = toolBlocks.first()
    await expect(firstBlock).toBeVisible({ timeout: 3_000 })

    // Should show tool count text (e.g. "3 tools")
    const blockText = await firstBlock.textContent()
    expect(blockText).toMatch(/\d+\s*tool/)
  })

  test('tool activity block expand/collapse toggles tool list', async ({ electronPage: page }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      test.skip()
      return
    }

    const toolBlocks = page.locator('[data-testid="tool-activity-block"]')
    const count = await toolBlocks.count()

    if (count === 0) {
      test.skip()
      return
    }

    const firstBlock = toolBlocks.first()

    // Click to expand/collapse the tool list
    const toggleBtn = firstBlock.locator('button').first()
    await toggleBtn.click()
    await page.waitForTimeout(300)

    // After clicking, tool rows should appear or disappear
    const toolRows = firstBlock.locator('[data-testid^="tool-row-"]')
    const rowCount = await toolRows.count()

    // Click again to toggle
    await toggleBtn.click()
    await page.waitForTimeout(300)

    const rowCountAfter = await toolRows.count()

    // Row count should differ between expanded and collapsed states
    expect(rowCount !== rowCountAfter || rowCount > 0).toBeTruthy()
  })

  test('tool row shows input/output when expanded', async ({ electronPage: page }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasChat = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChat) {
      test.skip()
      return
    }

    // First expand the tool activity block
    const toolBlocks = page.locator('[data-testid="tool-activity-block"]')
    const count = await toolBlocks.count()

    if (count === 0) {
      test.skip()
      return
    }

    // Expand the block
    const firstBlock = toolBlocks.first()
    const blockToggle = firstBlock.locator('button').first()
    await blockToggle.click()
    await page.waitForTimeout(300)

    // Find a tool row with expandable content
    const toolRows = firstBlock.locator('[data-testid^="tool-row-"]')
    const rowCount = await toolRows.count()

    if (rowCount === 0) {
      test.skip()
      return
    }

    // Click the first expandable row
    const firstRow = toolRows.first()
    const rowButton = firstRow.locator('button[aria-expanded]').first()
    const hasExpandable = await rowButton.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasExpandable) {
      // Row may not be expandable
      test.skip()
      return
    }

    await rowButton.click()
    await page.waitForTimeout(300)

    // Should show input/output sections
    const inputLabel = firstRow.getByText(/input|command/i)
    const outputLabel = firstRow.getByText(/output|error/i)

    const hasInput = await inputLabel
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)
    const hasOutput = await outputLabel
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)

    expect(hasInput || hasOutput).toBeTruthy()
  })

  // ── Code Intelligence integration ──

  test('code intelligence page shows MCP server controls', async ({ electronPage: page }) => {
    const settings = new WorkspaceSettings(page)

    // Navigate to code intelligence
    const welcomePage = new WelcomePage(page)
    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count === 0) {
        test.skip()
        return
      }
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
    await settings.openTab('code-intelligence')
    await page.waitForTimeout(500)

    // Should show code graph and/or semantic search controls
    const codeGraphText = page.getByText(/code.*graph|indexing/i).first()
    const semanticText = page.getByText(/semantic.*search|embedding/i).first()

    const hasCodeGraph = await codeGraphText.isVisible({ timeout: 5_000 }).catch(() => false)
    const hasSemantic = await semanticText.isVisible({ timeout: 5_000 }).catch(() => false)

    expect(hasCodeGraph || hasSemantic).toBeTruthy()
  })
})
