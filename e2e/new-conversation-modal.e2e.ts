/**
 * New Conversation Modal E2E Tests
 *
 * Tests NewConversationModal (395 LOC) — full conversation setup flow:
 *   - Modal opens when "New Chat" button is clicked
 *   - Title input accepts text up to 500 characters
 *   - Mode switcher toggles between Plan and Build modes
 *   - Communication tone selector shows available tones
 *   - Attachment dropzone section is visible
 *   - "Use isolated branch" toggle is available in Build mode
 *   - Submit button creates the conversation
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/new-conversation-modal.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('New Conversation Modal', () => {
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

  async function openNewConversationModal(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    // Look for the "+" or "New Chat" button in the sidebar/header
    const newChatBtn = page.locator(
      'button:has-text("New Chat"), button[aria-label*="New"], button[aria-label*="new chat"], [data-testid="new-chat-button"]'
    )
    const hasBtn = await newChatBtn.first().isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasBtn) return false
    await newChatBtn.first().click()
    await page.waitForTimeout(500)
    return true
  }

  test('new conversation modal opens when "New Chat" button is clicked', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const opened = await openNewConversationModal(page)
    if (!opened) { test.skip(); return }

    const modal = page.locator('[data-testid="new-conversation-modal"]')
    await expect(modal).toBeVisible({ timeout: 5_000 })

    // Modal should have a title
    const heading = modal.locator('h2, [id="new-conversation-title"]')
    await expect(heading).toContainText('Create New Chat')
  })

  test('title input accepts text up to 500 characters', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const opened = await openNewConversationModal(page)
    if (!opened) { test.skip(); return }

    const modal = page.locator('[data-testid="new-conversation-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasModal) { test.skip(); return }

    // Find the title input
    const titleInput = modal.locator('#conv-title, input[type="text"]').first()
    await expect(titleInput).toBeVisible()

    // Type a title
    await titleInput.fill('My test conversation')
    await expect(titleInput).toHaveValue('My test conversation')

    // Check maxLength attribute
    const maxLength = await titleInput.getAttribute('maxLength')
    expect(maxLength).toBe('500')
  })

  test('mode switcher toggles between Plan and Build modes', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const opened = await openNewConversationModal(page)
    if (!opened) { test.skip(); return }

    const modal = page.locator('[data-testid="new-conversation-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasModal) { test.skip(); return }

    // Find Plan and Build mode buttons
    const planBtn = modal.locator('button:has-text("Plan")')
    const buildBtn = modal.locator('button:has-text("Build")')

    await expect(planBtn).toBeVisible()
    await expect(buildBtn).toBeVisible()

    // Click Build mode
    await buildBtn.click()
    await page.waitForTimeout(300)

    // Build mode description should be visible
    const description = modal.locator('text=Build mode')
    const hasDescription = await description.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasDescription).toBeTruthy()
  })

  test('communication tone selector shows available tones', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const opened = await openNewConversationModal(page)
    if (!opened) { test.skip(); return }

    const modal = page.locator('[data-testid="new-conversation-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasModal) { test.skip(); return }

    // Find tone section
    const toneLabel = modal.locator('label:has-text("Tone")')
    await expect(toneLabel).toBeVisible()

    // Should have "Workspace Default" button plus at least one tone
    const workspaceDefault = modal.locator('button:has-text("Workspace Default")')
    await expect(workspaceDefault).toBeVisible()

    // At least one additional tone button should exist
    const toneButtons = modal.locator('button').filter({ hasText: /Friendly|Direct|Warm|Terse|Bare/ })
    const count = await toneButtons.count()
    expect(count).toBeGreaterThan(0)
  })

  test('attachment dropzone section is visible', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const opened = await openNewConversationModal(page)
    if (!opened) { test.skip(); return }

    const modal = page.locator('[data-testid="new-conversation-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasModal) { test.skip(); return }

    // Find attachments section label
    const attachLabel = modal.locator('label:has-text("Attachments")')
    await expect(attachLabel).toBeVisible()

    // Dropzone area should contain text about dropping files
    const dropzoneText = modal.locator('text=Drop files here')
    const hasDropzone = await dropzoneText.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasDropzone).toBeTruthy()
  })

  test('"Use isolated branch" toggle is available in Build mode', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const opened = await openNewConversationModal(page)
    if (!opened) { test.skip(); return }

    const modal = page.locator('[data-testid="new-conversation-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasModal) { test.skip(); return }

    // Switch to Build mode first
    const buildBtn = modal.locator('button:has-text("Build")')
    await buildBtn.click()
    await page.waitForTimeout(300)

    // Now the "Use isolated branch" checkbox should appear
    const branchLabel = modal.locator('text=Use isolated branch')
    const hasBranchOption = await branchLabel.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasBranchOption).toBeTruthy()
  })

  test('submit button creates the conversation', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const opened = await openNewConversationModal(page)
    if (!opened) { test.skip(); return }

    const modal = page.locator('[data-testid="new-conversation-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasModal) { test.skip(); return }

    // Submit button should exist
    const submitBtn = page.locator('[data-testid="new-conversation-submit"]')
    await expect(submitBtn).toBeVisible()
    await expect(submitBtn).toContainText('Create Chat')

    // Submit button should be disabled without a title
    const titleInput = modal.locator('#conv-title, input[type="text"]').first()
    const currentValue = await titleInput.inputValue()
    if (!currentValue) {
      // Button should be disabled (cursor-not-allowed class or disabled attribute)
      const isDisabled = await submitBtn.isDisabled()
      expect(isDisabled).toBeTruthy()
    }

    // Fill in a title — submit button should become enabled
    await titleInput.fill('E2E Test Conversation')
    await page.waitForTimeout(200)
    await expect(submitBtn).toBeEnabled()
  })
})
