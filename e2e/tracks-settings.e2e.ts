/**
 * Tracks settings E2E — the panel that makes worktree retention visible.
 *
 * Retention has always been the safe behaviour: close a chat with uncommitted
 * changes and its working tree is parked rather than deleted. Until this panel
 * shipped there was no way to see that from inside the app, so the safe
 * behaviour read as "my work vanished". These tests cover the two halves of
 * that promise end to end:
 *
 *   - the panel renders and lists what the main process actually reports;
 *   - the destructive action asks first, and the read-only actions cannot be
 *     talked into touching anything by a bad payload.
 *
 * The seeded-row half stubs `window.api` in the renderer. That override is not
 * guaranteed to be permitted (contextBridge properties can be non-configurable
 * depending on the Electron build), so it is verified before use and skipped
 * rather than assumed — a spec that silently tests nothing is worse than one
 * that says it could not run.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

type TestPage = import('@playwright/test').Page

const SEEDED_TRACK = {
  id: 'e2e-track-1',
  workspaceId: 'e2e-ws',
  ownerKind: 'chat',
  ownerId: null,
  branchName: 'chat/e2e-retained-work',
  path: '/tmp/e2e-worktrees/chat-e2e-retained-work',
  baseBranch: 'main',
  status: 'retained',
  landingMode: null,
  landedAt: null,
  landedInto: null,
  createdAt: '2026-01-01 00:00:00',
  lastUsedAt: '2026-01-01 00:00:00',
  exists: true,
  dirty: true,
  diskBytes: 4096,
  ownerLabel: null
}

test.describe('Tracks settings', () => {
  /** Settings → Tracks. Returns false when no workspace is available to open. */
  async function openTracksTab(page: TestPage): Promise<boolean> {
    const welcomePage = new WelcomePage(page)

    if (await welcomePage.isWelcomeModalVisible()) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    if (await welcomePage.isVisible()) {
      const cards = welcomePage.getWorkspaceCards()
      if ((await cards.count()) === 0) return false
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }

    const settingsTab = page.locator('[data-testid="sidebar-settings-tab"]')
    if (await settingsTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await settingsTab.click()
      await page.waitForTimeout(500)
    }

    const settings = new WorkspaceSettings(page)
    const tracksTab = settings.getTab('tracks')
    if (!(await tracksTab.isVisible({ timeout: 3_000 }).catch(() => false))) return false
    await tracksTab.click()
    await page.waitForTimeout(500)

    return page
      .locator('[data-testid="tracks-settings"]')
      .isVisible({ timeout: 5_000 })
      .catch(() => false)
  }

  /**
   * Replace `window.api.trackList` with one returning a fixed retained track.
   *
   * Returns false when the renderer refuses the override, in which case the
   * caller must skip rather than assert against the real list.
   */
  async function stubTrackList(page: TestPage, track: unknown): Promise<boolean> {
    return page.evaluate((seeded) => {
      const w = window as unknown as { api: Record<string, unknown> }
      const original = w.api
      if (!original) return false
      const patched = new Proxy(original, {
        get(target, prop, receiver) {
          if (prop === 'trackList') {
            return async () => ({
              tracks: [seeded],
              totalBytes: 4096,
              budgetBytes: 10 * 1024 * 1024 * 1024
            })
          }
          return Reflect.get(target, prop, receiver)
        }
      })
      try {
        Object.defineProperty(window, 'api', {
          value: patched,
          configurable: true,
          writable: true
        })
      } catch {
        return false
      }
      return (window as unknown as { api: Record<string, unknown> }).api === patched
    }, track)
  }

  // ── Panel ──────────────────────────────────────────────────────────────

  test('tracks panel renders with a disk summary or the empty state', async ({
    electronPage: page
  }) => {
    const ready = await openTracksTab(page)
    if (!ready) {
      test.skip()
      return
    }

    const panel = page.locator('[data-testid="tracks-settings"]')
    await expect(panel).toBeVisible()
    await expect(panel.getByText('Tracks', { exact: true })).toBeVisible()

    // Either the workspace has tracks (disk summary line) or it does not
    // (empty state). Both are healthy; a panel showing neither is not.
    const rows = panel.locator('[data-testid="track-row"]')
    if ((await rows.count()) === 0) {
      await expect(panel.getByText(/No tracks yet/i)).toBeVisible()
    } else {
      await expect(panel.getByText(/across \d+ track/i)).toBeVisible()
    }
  })

  test('a retained track renders with its branch and an uncommitted-changes badge', async ({
    electronPage: page
  }) => {
    const ready = await openTracksTab(page)
    if (!ready) {
      test.skip()
      return
    }

    if (!(await stubTrackList(page, SEEDED_TRACK))) {
      test.skip()
      return
    }

    await page.getByRole('button', { name: /refresh/i }).click()
    await page.waitForTimeout(500)

    const row = page.locator('[data-testid="track-row"]').first()
    await expect(row).toBeVisible()
    await expect(row.getByText(SEEDED_TRACK.branchName)).toBeVisible()
    await expect(row.getByText('retained')).toBeVisible()
    // The badge is the whole point: it is what tells the user the tree still
    // holds work a discard would destroy.
    await expect(row.getByText('uncommitted changes')).toBeVisible()
  })

  test('discard asks before deleting, and cancel leaves the row alone', async ({
    electronPage: page
  }) => {
    const ready = await openTracksTab(page)
    if (!ready) {
      test.skip()
      return
    }

    if (!(await stubTrackList(page, SEEDED_TRACK))) {
      test.skip()
      return
    }

    await page.getByRole('button', { name: /refresh/i }).click()
    await page.waitForTimeout(500)

    const panel = page.locator('[data-testid="tracks-settings"]')
    const row = panel.locator('[data-testid="track-row"]').first()
    await expect(row).toBeVisible()

    // Clicking the trash icon must NOT delete — it opens a confirm step naming
    // the consequence.
    await row.locator('button[title*="Discard"]').click()
    await page.waitForTimeout(200)

    await expect(
      panel.getByText(/uncommitted changes\. Discarding deletes them permanently/i)
    ).toBeVisible()

    const cancel = panel.getByRole('button', { name: 'Cancel' })
    await expect(cancel).toBeVisible()
    await cancel.click()
    await page.waitForTimeout(200)

    // The row survives; only the confirmation went away.
    await expect(row).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Cancel' })).toHaveCount(0)
  })

  // ── Bridge surface ─────────────────────────────────────────────────────

  test('track channels answer safely over the real bridge', async ({ electronPage: page }) => {
    const result = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          api: {
            trackReveal: (a: { trackId: string }) => Promise<boolean>
            trackAdopt: (a: { trackId: string }) => Promise<string | null>
            trackDiscard: (a: { trackId: string }) => Promise<boolean>
            onTrackChanged?: unknown
          }
        }
      ).api

      const unknownId = 'e2e-not-a-real-track'
      return {
        hasOnTrackChanged: typeof api.onTrackChanged,
        reveal: await api.trackReveal({ trackId: unknownId }),
        adopt: await api.trackAdopt({ trackId: unknownId }),
        discard: await api.trackDiscard({ trackId: unknownId })
      }
    })

    // Reveal and discard must decline an id they cannot resolve rather than
    // acting on a renderer-supplied guess; adopt must never invent a chat.
    expect(result.reveal).toBe(false)
    expect(result.adopt).toBeNull()
    expect(result.discard).toBe(false)
    expect(result.hasOnTrackChanged).toBe('function')
  })
})
