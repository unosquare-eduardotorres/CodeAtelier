/**
 * StreamingTranscript — the single scrollable transcript primitive shared by
 * every streaming surface (Grill, Greenfield Grill, Council; Chat can adopt it).
 *
 * It renders, top-to-bottom:
 *   1. an optional `header` slot (e.g. the grill requirement card)
 *   2. message history via a pluggable `renderMessage`
 *   3. the LIVE streaming bubble — segments + currentContent merged (and optionally
 *      transformed, e.g. to strip grill-evaluation JSON), shown with `identity`
 *   4. the shared <ThinkingIndicator> while `isStreaming`
 *   5. an optional `footer` slot (e.g. interactive question cards)
 *
 * Auto-scroll is built in — the viewport pins to the bottom as content streams.
 * Identity / persona is fully prop-driven so each surface keeps its own look while
 * sharing one renderer and one streaming cadence.
 */

import { useEffect, useMemo, useRef } from 'react'
import { MessageBubble } from '@renderer/components/chat'
import type { MessageIdentity } from '@renderer/components/chat'
import ThinkingIndicator from './ThinkingIndicator'
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

  /** Optional slot rendered above the history (pinned context). */
  header?: React.ReactNode
  /** Optional slot rendered below the live region (e.g. question cards). */
  footer?: React.ReactNode

  /** Scroll container classes (defaults to a roomy chat layout). */
  className?: string
  /** Inner content-width wrapper classes. */
  innerClassName?: string
  /** Extra deps that should also trigger an auto-scroll (e.g. phase). */
  scrollDeps?: ReadonlyArray<unknown>
}

const LIVE_MESSAGE_ID = 'streaming-live'

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
  header,
  footer,
  className = 'flex-1 overflow-y-auto px-6 py-6',
  innerClassName = 'max-w-3xl mx-auto space-y-4',
  scrollDeps = []
}: StreamingTranscriptProps<T>): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Merge segments + current content into the live narration (then transform).
  const liveContent = useMemo(() => {
    const merged = segments.map((s) => s.content).join('') + currentContent
    return transformContent ? transformContent(merged) : merged
  }, [segments, currentContent, transformContent])

  const liveToolActivities = useMemo(
    () => [...segments.flatMap((s) => s.toolActivities), ...currentToolActivities],
    [segments, currentToolActivities]
  )

  // Synthetic message backing the live bubble — identity is supplied via override.
  const liveMessage = useMemo<Message>(
    () => ({
      id: LIVE_MESSAGE_ID,
      conversationId: 'streaming',
      role: 'da-vinci',
      contentMd: liveContent,
      attachmentsJson: '[]',
      createdAt: new Date().toISOString()
    }),
    [liveContent]
  )

  // Stable signal for caller-supplied scroll deps (avoids a spread in the array).
  const scrollSignal = useMemo(() => JSON.stringify(scrollDeps), [scrollDeps])

  // Built-in auto-scroll: pin to bottom as content streams in.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [
    liveContent,
    segments.length,
    liveToolActivities.length,
    messages.length,
    isStreaming,
    scrollSignal
  ])

  const hasLiveContent = liveContent.trim().length > 0

  return (
    <div ref={scrollRef} className={className}>
      <div className={innerClassName}>
        {header}

        {messages.map((message, index) => renderMessage(message, index))}

        {isStreaming && (
          <>
            {hasLiveContent && <MessageBubble message={liveMessage} identityOverride={identity} />}
            <ThinkingIndicator
              identity={{
                name: identity.displayName,
                avatarKey: identity.avatarKey,
                accentColor: identity.accentColor
              }}
              toolActivities={liveToolActivities}
              label={thinkingLabel}
              showHookIndicator={showHookIndicator}
            />
          </>
        )}

        {footer}
      </div>
    </div>
  )
}
