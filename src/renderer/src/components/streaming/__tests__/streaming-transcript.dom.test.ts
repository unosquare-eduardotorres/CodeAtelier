/**
 * StreamingTranscript — component-level coverage (jsdom harness).
 *
 * Covers the audit's component claims that pure-logic tests cannot:
 *  (a) finalized segments render as separate memoized bubbles
 *  (b) transformContent applies to BOTH the tail and committed segments
 *      (F10 end-to-end at the component level)
 *  (c) suppressLiveBubble hides the tail but not segments
 *  (d) N2: no key collisions after clearCommittedSegments — segment bubbles
 *      keep their identity across the committed boundary
 *
 * MessageBubble / ThinkingIndicator subtrees are stubbed (their real barrels
 * pull Vite-only import.meta.env graphs — see component-harness.ts); the
 * component under test runs its real logic.
 *
 * Run: tsx src/renderer/src/components/streaming/__tests__/streaming-transcript.dom.test.tsx
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../../main/services/__tests__/test-harness'
import { render, byTestId, restoreResolver, stubModule, teardownGlobals } from './component-harness'

const React = require('react') as typeof import('react')

// ── Stubs (see header) ──────────────────────────────────────────────────────

const BubbleStub = ({ message }: { message: any }): any =>
  React.createElement(
    'div',
    { 'data-testid': 'bubble', 'data-msg-id': message.id },
    message.contentMd
  )
stubModule('@renderer/components/chat', {
  MessageBubble: BubbleStub,
  ScrollToBottomButton: () => null
})
stubModule('@renderer/components/chat/ScrollToBottomButton', {
  default: () => null
})
stubModule('@renderer/components/chat/ToolActivityBlock', {
  default: ({ toolActivity }: { toolActivity: any }) =>
    React.createElement('div', { 'data-testid': 'tool' }, toolActivity?.toolName ?? '')
})
stubModule('@renderer/components/chat/HookActivityIndicator', {
  default: () => null
})
stubModule('@renderer/components/common', {
  Avatar: () => React.createElement('div', { 'data-testid': 'avatar' })
})
stubModule('@renderer/hooks/useChatAvatarSize', {
  useChatAvatarSize: () => 'md'
})

const { default: StreamingTranscript } = require('../StreamingTranscript')

// ── Fixtures ────────────────────────────────────────────────────────────────

const IDENTITY = { displayName: 'Test', avatarKey: 'default', accentColor: '#fff' } as any

function makeSegment(seq: number, content: string): any {
  return { seq, content, toolActivities: [], timestamp: 1_000 + seq }
}

/** Strip anything inside [[...]] markers — stands in for stripBlueprintBlocks. */
const stripTags = (raw: string): string => raw.replace(/\[\[[^\]]*\]\]/g, '')

function renderTranscript(props: Record<string, unknown>): {
  unmount: () => void
  rerender: (node: React.ReactNode) => void
} {
  return render(
    React.createElement(StreamingTranscript, {
      messages: [],
      renderMessage: () => null,
      segments: [],
      currentContent: '',
      currentToolActivities: [],
      isStreaming: true,
      identity: IDENTITY,
      ...props
    })
  )
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('StreamingTranscript — segments render as bubbles (A2, component)', () => {
  test('(a) finalized segments render as separate bubbles', () => {
    const h = renderTranscript({
      segments: [makeSegment(1, 'first segment'), makeSegment(2, 'second segment')],
      currentContent: 'live tail'
    })
    const bubbles = byTestId('bubble')
    assert.equal(bubbles.length, 3, 'two segment bubbles + one tail bubble')
    assert.equal(bubbles[0].textContent, 'first segment')
    assert.equal(bubbles[1].textContent, 'second segment')
    assert.equal(bubbles[2].textContent, 'live tail')
    h.unmount()
  })

  test('(b) transformContent applies to both tail and committed segments (F10)', () => {
    const h = renderTranscript({
      segments: [makeSegment(1, 'before [[secret-block]] after')],
      currentContent: 'tail [[other-block]] end',
      transformContent: stripTags
    })
    const bubbles = byTestId('bubble')
    assert.equal(bubbles.length, 2)
    assert.equal(bubbles[0].textContent, 'before  after', 'segment content transformed')
    assert.equal(bubbles[1].textContent, 'tail  end', 'tail content transformed')
    h.unmount()
  })

  test('(c) suppressLiveBubble hides the tail but not segments', () => {
    const visible = renderTranscript({
      segments: [makeSegment(1, 'segment body')],
      currentContent: 'tail body'
    })
    assert.equal(byTestId('bubble').length, 2, 'baseline: segment + tail')
    visible.unmount()

    const suppressed = renderTranscript({
      segments: [makeSegment(1, 'segment body')],
      currentContent: 'tail body',
      suppressLiveBubble: true
    })
    const bubbles = byTestId('bubble')
    assert.equal(bubbles.length, 1, 'only the segment bubble remains')
    assert.equal(bubbles[0].textContent, 'segment body')
    suppressed.unmount()
  })

  test('(d) N2 — segment bubbles keep identity across clearCommittedSegments', () => {
    // Wave 1: two live segments (seq 1, 2).
    const h = renderTranscript({
      segments: [makeSegment(1, 'seg one'), makeSegment(2, 'seg two')],
      currentContent: ''
    })
    let ids = byTestId('bubble').map((b) => b.getAttribute('data-msg-id'))
    assert.deepEqual(ids, ['streaming-segment-1', 'streaming-segment-2'])

    // The consumer commits those segments (clearCommittedSegments) and new
    // segments arrive — indices restart at 0, seqs do not.
    h.rerender(
      React.createElement(StreamingTranscript, {
        messages: [],
        renderMessage: () => null,
        segments: [makeSegment(3, 'seg three')],
        currentContent: '',
        currentToolActivities: [],
        isStreaming: true,
        identity: IDENTITY
      })
    )
    ids = byTestId('bubble').map((b) => b.getAttribute('data-msg-id'))
    assert.deepEqual(
      ids,
      ['streaming-segment-3'],
      'post-boundary segment must not reuse a committed id'
    )
    h.unmount()
  })

  test('empty tail renders no bubble — ThinkingIndicator state instead (F2)', () => {
    const h = renderTranscript({
      segments: [makeSegment(1, 'only a segment')],
      currentContent: ''
    })
    const bubbles = byTestId('bubble')
    assert.equal(bubbles.length, 1, 'segment only — no empty tail bubble')
    h.unmount()
  })
})

restoreResolver()
teardownGlobals()
// Only exit when run standalone — in the shared runner the harness's own
// summaryAsync() owns the totals (an unconditional call would exit mid-suite
// and silently truncate every later file).
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
