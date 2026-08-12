/**
 * BACKGROUND-CHAT: a chat streaming in workspace A must keep streaming after
 * the user switches to workspace B — the same way a running blueprint does.
 *
 * This walks the whole reported sequence over the pure rules that useAppIpcListeners
 * and chat.store's resetForWorkspaceSwitch delegate to:
 *   chunk to A (A on screen) → workspace switch → chunk to A still buffers →
 *   completion attributed to A's workspace, not the one now on screen.
 *
 * Run: tsx src/renderer/src/hooks/__tests__/background-stream-routing.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'
import { isActiveConversationEvent, resolveCompletionWorkspace } from '../stream-routing'
import {
  partitionStreamsForWorkspaceSwitch,
  emptyStreamState,
  type PerConversationStreamState
} from '../../store/chat-action-utils'

const WS_A = { id: 'ws-a', repoPath: '/repo/a' }
const WS_B = { id: 'ws-b', repoPath: '/repo/b' }
const ALL_WORKSPACES = [WS_A, WS_B]

describe('isActiveConversationEvent', () => {
  test('an event for the conversation on screen is active', () => {
    assert.equal(isActiveConversationEvent('conv-a', 'conv-a'), true)
  })

  test('an event for another conversation is not active', () => {
    assert.equal(isActiveConversationEvent('conv-a', 'conv-b'), false)
  })

  test('with no conversation on screen nothing is active', () => {
    // Post-switch (and post-deletion) the active conversation is null — events
    // must fall to the background path instead of leaking into the empty view.
    assert.equal(isActiveConversationEvent('conv-a', null), false)
    assert.equal(isActiveConversationEvent('conv-a', undefined), false)
  })
})

describe('resolveCompletionWorkspace', () => {
  test('prefers the workspace the backend stamped on the completion', () => {
    const workspace = resolveCompletionWorkspace('ws-a', false, {
      all: ALL_WORKSPACES,
      active: WS_B
    })
    assert.equal(workspace?.id, 'ws-a', 'must not be attributed to the workspace now on screen')
  })

  test('falls back to the active workspace only for the active conversation', () => {
    assert.equal(
      resolveCompletionWorkspace(undefined, true, { all: ALL_WORKSPACES, active: WS_B })?.id,
      'ws-b'
    )
    assert.equal(
      resolveCompletionWorkspace(undefined, false, { all: ALL_WORKSPACES, active: WS_B }),
      undefined,
      'an unstamped background completion must resolve to nothing, not to a guess'
    )
  })

  test('an unknown stamped workspace resolves to nothing', () => {
    assert.equal(
      resolveCompletionWorkspace('ws-gone', false, { all: ALL_WORKSPACES, active: WS_B }),
      undefined
    )
  })
})

describe('stream survives a workspace switch (full sequence)', () => {
  test('chunk → switch → chunk still buffers → completion attributed to workspace A', () => {
    // 1. conv-a is streaming and on screen in workspace A.
    let activeConversationId: string | null = 'conv-a'
    let streams = new Map<string, PerConversationStreamState>([
      ['conv-a', { ...emptyStreamState(), isStreaming: true, activeRequestId: 'req-a' }],
      ['conv-done', { ...emptyStreamState(), streamingContent: 'finished earlier' }]
    ])

    assert.equal(isActiveConversationEvent('conv-a', activeConversationId), true)
    streams.set('conv-a', {
      ...streams.get('conv-a')!,
      streamingContent: 'before the switch'
    })

    // 2. The user switches to workspace B: the live buffer is kept, the finished
    //    one is dropped, and no conversation is on screen any more.
    const { kept, dropped } = partitionStreamsForWorkspaceSwitch(streams)
    streams = kept
    activeConversationId = null
    assert.deepEqual(dropped, ['conv-done'])
    assert.equal(streams.get('conv-a')?.streamingContent, 'before the switch')

    // 3. Chunks keep arriving for conv-a — they route to conv-a's buffer as a
    //    background event, they are NOT dropped and NOT shown in the new view.
    assert.equal(isActiveConversationEvent('conv-a', activeConversationId), false)
    streams.set('conv-a', {
      ...streams.get('conv-a')!,
      streamingContent: streams.get('conv-a')!.streamingContent + ' and after it'
    })
    assert.equal(streams.get('conv-a')?.streamingContent, 'before the switch and after it')
    assert.equal(streams.get('conv-a')?.isStreaming, true)

    // 4. The stream completes while workspace B is on screen. Workspace-scoped
    //    follow-up work must be attributed to A, the workspace that owns it.
    const workspace = resolveCompletionWorkspace('ws-a', false, {
      all: ALL_WORKSPACES,
      active: WS_B
    })
    assert.equal(workspace?.id, 'ws-a')
    assert.equal(workspace?.repoPath, '/repo/a')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
