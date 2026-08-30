/**
 * StreamingTranscript — the single scrollable transcript primitive shared by
 * every streaming surface (Grill, Greenfield Grill, Council; Chat can adopt it).
 *
 * It renders, top-to-bottom:
 *   1. an optional `header` slot (e.g. the grill requirement card)
 *   2. message history via a pluggable `renderMessage`
 *   3. the LIVE streaming region — finalized segments as individual bubbles,
 *      then the live tail (currentContent), each optionally transformed (e.g. to
 *      strip grill-evaluation JSON), shown with `identity`
 *   4. the shared <ThinkingIndicator> while `isStreaming`
 *   5. an optional `footer` slot (e.g. interactive question cards)
 *
 * Auto-scroll is built in — the viewport pins to the bottom as content streams.
 * Identity / persona is fully prop-driven so each surface keeps its own look while
 * sharing one renderer and one streaming cadence.
 */

import { useMemo, useRef } from 'react'
import { MessageBubble } from '@renderer/components/chat'
import type { MessageIdentity } from '@renderer/components/chat'
import ScrollToBottomButton from '@renderer/components/chat/ScrollToBottomButton'
import ThinkingIndicator from './ThinkingIndicator'
import { useStreamScroll } from './useStreamScroll'
import type { StreamSegment } from '@renderer/utils/stream-segment-accumulator'
import type { Message, ToolActivity } from '../../../../shared/types'

interface StreamingTranscriptProps<T> {
  /** Committed message history. */
  messages: T[]
  /** Renders one history message. Must return a keyed node. */
  renderMessage: (message: T, index: number) => React.ReactNode

  /** Live streaming slice (from a streaming store). */
  segments: StreamSegment[]
  currentContent: string
  currentToolActivities: ToolActivity[]
  isStreaming: boolean

  /** Persona for the live bubble + thinking indicator. */
  identity: MessageIdentity
  /** Italic status line in the thinking indicator. */
  thinkingLabel?: string
  /** Render the hook-execution indicator (chat only). */
  showHookIndicator?: boolean
  /** Optional transform applied to the merged live content (e.g. strip JSON). */
  transformContent?: (raw: string) => string

  /**
   * When true, suppress the live **tail** bubble — only show ThinkingIndicator
   * (with in-flight tools) while streaming. Finalized segments ALWAYS render;
   * callers that want to suppress everything pass `segments={[]}`. Complete
   * bubbles appear via committed messages instead. Used by Blueprint for
   * chat-parity progressive rendering.
   */
  suppressLiveBubble?: boolean

  /** Optional slot rendered above the history (pinned context). */
  header?: React.ReactNode
  /** Optional slot rendered below the live region (e.g. question cards). */
  footer?: React.ReactNode

  /** Scroll container classes (defaults to a roomy chat layout). */
  className?: string
  /**
   * Inner content-width wrapper classes. Defaults to full width — the
   * transcript fills whatever the layout gives it, and readable measure is
   * enforced per-bubble (see BUBBLE_SIZE_CLASSES.proseMax) rather than by
   * narrowing the whole column, which also narrowed tool output.
   */
  innerClassName?: string
  /** Extra deps that should also trigger an auto-scroll (e.g. phase). */
  scrollDeps?: ReadonlyArray<unknown>
}

const LIVE_TAIL_MESSAGE_ID = 'streaming-live-tail'

/**
 * A2 FIX: adapted Message per finalized segment, cached by the segment object.
 * Segments are immutable once finalized, so the cache keeps `message` props
 * referentially stable → React.memo on MessageBubble hits → committed segments
 * are never re-parsed while the tail streams.
 *
 * F1 FIX: the cached contentMd is the TRANSFORMED content (same transform the
 * merged bubble used to apply), so grill-eval JSON / blueprint tagged blocks are
 * stripped from committed segment bubbles too. Safe to bake into the cache
 * because segments are immutable and never shared across surfaces (each store
 * owns its own segment objects).
 */
const segmentMessageCache = new WeakMap<StreamSegment, Message>()

function segmentToMessage(
  segment: StreamSegment,
  index: number,
  transformContent?: (raw: string) => string
): Message {
  let message = segmentMessageCache.get(segment)
  if (!message) {
    message = {
      id: `streaming-segment-${index}`,
      conversationId: 'streaming',
      role: 'specialist',
      contentMd: transformContent ? transformContent(segment.content) : segment.content,
      attachmentsJson: '[]',
      createdAt: new Date(segment.timestamp).toISOString(),
      toolActivities: segment.toolActivities
    }
    segmentMessageCache.set(segment, message)
  }
  return message
}

export default function StreamingTranscript<T>({
  messages,
  renderMessage,
  segments,
  currentContent,
  currentToolActivities,
  isStreaming,
  identity,
  thinkingLabel,
  showHookIndicator = false,
  transformContent,
  suppressLiveBubble = false,
  header,
  footer,
  className = 'overflow-y-auto px-6 py-6',
  innerClassName = 'w-full space-y-4',
  scrollDeps = []
}: StreamingTranscriptProps<T>): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  // A2 FIX: finalized segments render as individual memoized bubbles (stable
  // string props → memo hits); only the live tail (currentContent) is re-parsed
  // per flush. Previously ALL segments + tail were merged into one ever-growing
  // bubble, making per-flush parse cost O(total accumulated) — the renderer
  // CPU saturation during long blueprint phases.
  const tailContent = useMemo(
    () => (transformContent ? transformContent(currentContent) : currentContent),
    [currentContent, transformContent]
  )

  const tailToolActivities = currentToolActivities

  // Synthetic message backing the live tail bubble — identity is supplied via override.
  const tailMessage = useMemo<Message>(
    () => ({
      id: LIVE_TAIL_MESSAGE_ID,
      conversationId: 'streaming',
      role: 'specialist',
      contentMd: tailContent,
      attachmentsJson: '[]',
      createdAt: new Date().toISOString()
    }),
    [tailContent]
  )

  // Stable signal for caller-supplied scroll deps (avoids a spread in the array).
  const scrollSignal = useMemo(() => JSON.stringify(scrollDeps), [scrollDeps])

  // Sticky-bottom auto-scroll: pauses when the user scrolls up,
  // resumes when they scroll back to the bottom or click the button.
  const { isPinned, scrollToBottom } = useStreamScroll(scrollRef, [
    tailContent,
    segments.length,
    tailToolActivities.length,
    messages.length,
    isStreaming,
    scrollSignal
  ])

  // F2 FIX: only the live TAIL gates the tail bubble. Segments always render as
  // their own bubbles above; when only segments exist (empty tail) the correct
  // state is the ThinkingIndicator (in-flight tools), not an empty bubble.
  const hasTailContent = tailContent.trim().length > 0

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden">
      <div ref={scrollRef} data-testid="streaming-transcript" className={className + ' h-full'}>
        <div className={innerClassName}>
          {header}

          {messages.map((message, index) => renderMessage(message, index))}

          {isStreaming && (
            <>
              {/* A2 FIX: finalized segments render as individual memoized bubbles.
               * Each gets a stable `message` prop (WeakMap-cached) so committed
               * content is parsed once, not on every tail flush. */}
              {segments.map((segment, index) => (
                <MessageBubble
                  key={`live-seg-${index}`}
                  message={segmentToMessage(segment, index, transformContent)}
                  identityOverride={identity}
                  toolActivities={segment.toolActivities}
                />
              ))}
              {hasTailContent && !suppressLiveBubble ? (
                /* Live tail: only currentContent re-parses per flush (bounded by
                 * the accumulator's segment size cap). Tools render INSIDE the
                 * bubble via BubbleFooterActions; the footer shows a pulsing
                 * "writing…" indicator via isStreaming. */
                <MessageBubble
                  message={tailMessage}
                  identityOverride={identity}
                  isStreaming
                  toolActivities={tailToolActivities}
                />
              ) : (
                /* No live tail content yet (or suppressLiveBubble): full ThinkingIndicator with avatar + label + tools */
                <ThinkingIndicator
                  identity={{
                    name: identity.displayName,
                    avatarKey: identity.avatarKey,
                    accentColor: identity.accentColor
                  }}
                  toolActivities={tailToolActivities}
                  label={thinkingLabel}
                  showHookIndicator={showHookIndicator}
                />
              )}
            </>
          )}

          {footer}
        </div>
      </div>
      <ScrollToBottomButton visible={!isPinned} onClick={scrollToBottom} />
    </div>
  )
}
