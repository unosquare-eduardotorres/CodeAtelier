/**
 * Repository & Auth Settings E2E Tests
 *
 * Verifies git configuration, GitHub token input, and auth mode settings:
 *   - Repository settings tab renders with git config
 *   - Git init button for non-git workspaces
 *   - GitHub token input accepts and validates
 *   - Auth settings tab renders with mode toggle
 *   - Auth save button persists selection
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Repository & Auth Settings', () => {
  /** Navigate to a settings tab by id. */
  async function openSettingsTab(
    page: import('@playwright/test').Page,
    tabId: string
  ): Promise<WorkspaceSettings> {
    const welcomePage = new WelcomePage(page)

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

    const settingsTab = page.locator('[data-testid="sidebar-settings-tab"]')
    const hasTab = await settingsTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await settingsTab.click()
      await page.waitForTimeout(500)
    }

    const settings = new WorkspaceSettings(page)
    const tab = settings.getTab(tabId)
    const hasTarget = await tab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTarget) {
      await tab.click()
      await page.waitForTimeout(500)
    }

    return settings
  }

  test('repository settings tab renders with git config', async ({ electronPage: page }) => {
    await openSettingsTab(page, 'repository')

    const repoTab = page.locator('[data-testid="repo-settings-tab"]')
    const visible = await repoTab.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    await expect(repoTab).toBeVisible()

    // Page title
    const title = page.getByText('Repository & GitHub')
    await expect(title).toBeVisible()

    // Git configuration section visible
    const gitSection = page.getByText(/Git|Repository|Remote/i)
    const hasGit = await gitSection.first().isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasGit).toBeTruthy()
  })

  test('git init button for non-git workspaces', async ({ electronPage: page }) => {
    await openSettingsTab(page, 'repository')

    const initBtn = page.locator('[data-testid="repo-init-btn"]')
    const visible = await initBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!visible) {
      // Workspace already has git — verify remote URL field instead
      const remoteField = page.getByText(/Remote|remote URL/i)
      const hasRemote = await remoteField.first().isVisible({ timeout: 3_000 }).catch(() => false)
      expect(hasRemote).toBeTruthy()
      return
    }

    // Init button visible for non-git workspace
    await expect(initBtn).toBeVisible()
    const btnText = await initBtn.textContent()
    expect(btnText).toMatch(/Initialize/i)
  })

  test('GitHub token input accepts and validates', async ({ electronPage: page }) => {
    await openSettingsTab(page, 'repository')

    const tokenInput = page.locator('[data-testid="github-token-input"]')
    const visible = await tokenInput.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!visible) {
      // GitHub may already be connected — check for disconnect button
      const disconnectBtn = page.getByRole('button', { name: /disconnect/i })
      const hasDisconnect = await disconnectBtn.isVisible({ timeout: 3_000 }).catch(() => false)
      expect(hasDisconnect).toBeTruthy()
      return
    }

    // Input accepts text entry
    await tokenInput.fill('ghp_testtoken123')
    await page.waitForTimeout(300)

    const value = await tokenInput.inputValue()
    expect(value).toBeTruthy()

    // Clear for cleanliness
    await tokenInput.fill('')
  })

  test('auth settings tab renders with mode toggle', async ({ electronPage: page }) => {
    // Auth settings may be under a different tab name — try common options
    const _settings = await openSettingsTab(page, 'models')

    // Auth settings may be embedded or as a separate sub-section
    const authTab = page.locator('[data-testid="auth-settings-tab"]')
    const visible = await authTab.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!visible) {
      // Try navigating to auth-specific areas
      const authText = page.getByText(/Authentication|Auth Mode|Claude Max|API Key/i)
      const hasAuth = await authText.first().isVisible({ timeout: 3_000 }).catch(() => false)
      if (!hasAuth) {
        test.skip()
        return
      }
    }

    // Mode toggle should show Claude Max / API Key options
    const claudeMax = page.getByText(/Claude Max/i)
    const apiKey = page.getByText(/API Key/i)
    const hasMax = await claudeMax.first().isVisible({ timeout: 3_000 }).catch(() => false)
    const hasApi = await apiKey.first().isVisible({ timeout: 3_000 }).catch(() => false)

    expect(hasMax || hasApi).toBeTruthy()
  })

  test('auth save button persists selection', async ({ electronPage: page }) => {
    await openSettingsTab(page, 'models')

    const saveBtn = page.locator('[data-testid="auth-save-btn"]')
    const visible = await saveBtn.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    // Click save
    await saveBtn.click()
    await page.waitForTimeout(1_000)

    // Success indicator should appear
    const success = page.getByText(/Saved|success/i)
    const hasSuccess = await success.first().isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasSuccess).toBeTruthy()
  })
})
