/**
 * AuditStreamView — chat-like scrollable container for audit execution.
 *
 * Reuses the chat MessageBubble (via an auditor identity override) to render
 * finalized analysis segments, matching the natural chat rendering. While a
 * track is still streaming, an AuditThinkingIndicator (dots + live tools) is
 * shown so content reveals on finalize instead of stuttering token-by-token.
 * Read-only — no input box, audits are fully automated.
 */

import { useMemo, useRef } from 'react'
import type { AuditTrackId } from '../../../../shared/types'
import { useAuditStore } from '@renderer/store'
import { MessageBubble } from '@renderer/components/chat'
import type { MessageIdentity } from '@renderer/components/chat'
import { auditSegmentToMessage } from '@renderer/utils/auditMessageAdapter'
import AuditThinkingIndicator from './AuditThinkingIndicator'
import AuditResultBubble from './AuditResultBubble'
import ScrollToBottomButton from '@renderer/components/chat/ScrollToBottomButton'
import { useStreamScroll } from '@renderer/components/streaming'

interface AuditStreamViewProps {
  trackId: AuditTrackId
  trackName: string
  isStreaming: boolean
}

export default function AuditStreamView({
  trackId,
  trackName,
  isStreaming
}: AuditStreamViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { perTrackStreaming, currentRun } = useAuditStore()
  const trackData = perTrackStreaming[trackId]
  const trackResult = currentRun?.results.find((r) => r.trackId === trackId)
  const isCompleted = trackResult?.status === 'completed'

  const segments = trackData?.segments ?? []
  const currentContent = trackData?.currentContent ?? ''
  const currentToolActivities = trackData?.currentToolActivities ?? []
  const hasAnyContent = segments.length > 0 || currentContent || currentToolActivities.length > 0

  // Auditor identity override — reuses MessageBubble's chat rendering pipeline.
  const auditIdentity = useMemo<MessageIdentity>(
    () => ({
      displayName: `${trackName} Auditor`,
      subtitle: null,
      avatarKey: 'atelier-auditor',
      accentColor: 'var(--color-primary, #6366F1)'
    }),
    [trackName]
  )

  // Sticky-bottom auto-scroll: pauses when user scrolls up.
  const { isPinned, scrollToBottom } = useStreamScroll(scrollRef, [
    currentContent,
    currentToolActivities.length,
    segments.length
  ])

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden">
      <div ref={scrollRef} className="overflow-y-auto h-full p-6 space-y-4">
        {hasAnyContent ? (
          <>
            {/* Finalized segments — rendered as clean chat bubbles (reveal-on-finalize) */}
            {segments.map((seg, i) => (
              <MessageBubble
                key={`seg-${i}`}
                message={auditSegmentToMessage(seg.content, seg.toolActivities, i)}
                toolActivities={seg.toolActivities}
                identityOverride={auditIdentity}
                viewerContext="other"
              />
            ))}

            {/* In-progress analysis — pulsing status text + live tools instead of a stuttering bubble */}
            {isStreaming && (
              <AuditThinkingIndicator
                trackName={trackName}
                toolActivities={currentToolActivities}
              />
            )}

            {isCompleted && trackResult && (
              <AuditResultBubble
                score={trackResult.score ?? 0}
                summary={trackResult.summary ?? ''}
                trackName={trackName}
                findingsCount={trackResult.findings.length}
              />
            )}
          </>
        ) : isStreaming ? (
          <AuditThinkingIndicator trackName={trackName} toolActivities={[]} />
        ) : (
          <span className="text-text-muted text-sm italic">Waiting to start…</span>
        )}
      </div>
      <ScrollToBottomButton visible={!isPinned} onClick={scrollToBottom} />
    </div>
  )
}
