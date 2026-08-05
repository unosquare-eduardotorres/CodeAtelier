/**
 * Chat force-release E2E — verifies the wedge escape hatch is wired end to end.
 *
 * A conversation is "busy" per three pieces of main-process state (streaming
 * lock, conversation state machine, lifecycle registry). When that state
 * outlived its stream the chat rejected every send with "a message is already
 * being processed" and Stop was a no-op, so the only cure was restarting the
 * app. `chat:forceRelease` is the escape hatch, and `stopGeneration` escalates
 * to it when main still reports the conversation busy after a stop.
 *
 * Wedging a real conversation from the renderer isn't possible without a test
 * backdoor, so the unit suite owns the release semantics
 * (stream-wedge-recovery.test.ts). What this spec protects is the wiring —
 * channel registered in main, exposed through preload, argument validation,
 * and a safe no-op shape on a conversation that isn't wedged. A missing
 * preload binding or unregistered channel is invisible to unit tests and
 * would silently remove the only recovery path users have.
 */
import { test, expect } from './helpers/electron-fixture'

test.describe('Chat force-release (wedge escape hatch)', () => {
  test('forceReleaseConversation is exposed on the preload API', async ({
    electronPage: page
  }) => {
    const kind = await page.evaluate(
      () => typeof (window as unknown as { api?: Record<string, unknown> }).api?.forceReleaseConversation
    )
    expect(kind).toBe('function')
  })

  test('returns released=false for a conversation that is not busy', async ({
    electronPage: page
  }) => {
    // An unknown id is by definition not busy — main must answer rather than
    // throw, and must not report a release that did not happen.
    const result = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          api: { forceReleaseConversation: (id: string) => Promise<{ released: boolean }> }
        }
      ).api
      try {
        return { ok: true, value: await api.forceReleaseConversation('e2e-not-a-real-conversation') }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    })

    expect(result.ok, `IPC threw: ${'error' in result ? result.error : ''}`).toBe(true)
    expect(result.value).toEqual({ released: false })
  })

  test('rejects a malformed conversationId instead of silently succeeding', async ({
    electronPage: page
  }) => {
    // The handler runs requireString — a bad payload must fail loudly, not
    // release some arbitrary conversation.
    const result = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          api: { forceReleaseConversation: (id: unknown) => Promise<{ released: boolean }> }
        }
      ).api
      try {
        return { threw: false, value: await api.forceReleaseConversation(undefined) }
      } catch {
        return { threw: true }
      }
    })

    expect(result.threw).toBe(true)
  })
})
