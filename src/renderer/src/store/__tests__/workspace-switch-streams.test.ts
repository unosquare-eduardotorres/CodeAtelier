/**
 * partitionStreamsForWorkspaceSwitch — the BACKGROUND-CHAT-01 half of
 * chat.store's resetForWorkspaceSwitch.
 *
 * A chat streaming in workspace A must survive a switch to workspace B (the
 * backend keeps sending its chunks, exactly like a running blueprint), so the
 * switch may only drop the buffers of conversations that already finished.
 *
 * Run: tsx src/renderer/src/store/__tests__/workspace-switch-streams.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'
import {
  partitionStreamsForWorkspaceSwitch,
  emptyStreamState,
  type PerConversationStreamState
} from '../chat-action-utils'

function streamingState(content: string): PerConversationStreamState {
  return { ...emptyStreamState(), streamingContent: content, isStreaming: true }
}

describe('partitionStreamsForWorkspaceSwitch', () => {
  test('keeps a still-streaming conversation with its buffered content', () => {
    const streams = new Map<string, PerConversationStreamState>([
      ['conv-live', streamingState('half a sentence')]
    ])

    const { kept, dropped } = partitionStreamsForWorkspaceSwitch(streams)

    assert.equal(dropped.length, 0, 'a live stream must not be dropped')
    assert.equal(kept.get('conv-live')?.streamingContent, 'half a sentence')
  })

  test('drops a finished conversation so its accumulator can be released', () => {
    const streams = new Map<string, PerConversationStreamState>([
      ['conv-done', { ...emptyStreamState(), streamingContent: 'old text' }]
    ])

    const { kept, dropped } = partitionStreamsForWorkspaceSwitch(streams)

    assert.deepEqual(dropped, ['conv-done'])
    assert.equal(kept.size, 0)
  })

  test('splits a mixed map', () => {
    const streams = new Map<string, PerConversationStreamState>([
      ['conv-a', streamingState('a')],
      ['conv-b', emptyStreamState()],
      ['conv-c', streamingState('c')]
    ])

    const { kept, dropped } = partitionStreamsForWorkspaceSwitch(streams)

    assert.deepEqual([...kept.keys()], ['conv-a', 'conv-c'])
    assert.deepEqual(dropped, ['conv-b'])
  })

  test('does not mutate the caller’s map', () => {
    const streams = new Map<string, PerConversationStreamState>([
      ['conv-a', streamingState('a')],
      ['conv-b', emptyStreamState()]
    ])

    const { kept } = partitionStreamsForWorkspaceSwitch(streams)
    kept.delete('conv-a')

    assert.equal(streams.size, 2, 'the source map is untouched')
  })

  test('an empty map yields nothing to keep or drop', () => {
    const { kept, dropped } = partitionStreamsForWorkspaceSwitch(new Map())

    assert.equal(kept.size, 0)
    assert.equal(dropped.length, 0)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
