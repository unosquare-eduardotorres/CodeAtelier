/**
 * DesignStreamView — chat-like scrollable container for a design command's run.
 *
 * Mirrors AuditStreamView and reuses the same rendering pipeline (MessageBubble
 * + the audit segment adapter + the thinking indicator); only the store differs.
 */

import { useMemo, useRef } from 'react'
import { useDesignStore } from '@renderer/store'
import { MessageBubble } from '@renderer/components/chat'
import type { MessageIdentity } from '@renderer/components/chat'
import { auditSegmentToMessage } from '@renderer/utils/auditMessageAdapter'
import ScrollToBottomButton from '@renderer/components/chat/ScrollToBottomButton'
import { useStreamScroll } from '@renderer/components/streaming'
import AuditThinkingIndicator from '../AuditThinkingIndicator'
import type { AuditTrackId } from '../../../../../shared/types'

interface DesignStreamViewProps {
  trackId: AuditTrackId
  commandName: string
  isStreaming: boolean
}

export default function DesignStreamView({
  trackId,
  commandName,
  isStreaming
}: DesignStreamViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const perTrackStreaming = useDesignStore((s) => s.perTrackStreaming)
  const trackData = perTrackStreaming[trackId]

  const segments = trackData?.segments ?? []
  const currentToolActivities = trackData?.currentToolActivities ?? []
  const currentContent = trackData?.currentContent ?? ''
  const hasAnyContent = segments.length > 0 || currentContent || currentToolActivities.length > 0

  const identity = useMemo<MessageIdentity>(
    () => ({
      displayName: `${commandName} Pass`,
      subtitle: null,
      avatarKey: 'atelier-auditor',
      accentColor: 'var(--color-primary, #6366F1)'
    }),
    [commandName]
  )

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
            {segments.map((seg, i) => (
              <MessageBubble
                key={`design-seg-${seg.seq}`}
                message={auditSegmentToMessage(seg.content, seg.toolActivities, i)}
                toolActivities={seg.toolActivities}
                identityOverride={identity}
                viewerContext="other"
              />
            ))}
            {isStreaming && (
              <AuditThinkingIndicator
                trackName={commandName}
                toolActivities={currentToolActivities}
              />
            )}
          </>
        ) : isStreaming ? (
          <AuditThinkingIndicator trackName={commandName} toolActivities={[]} />
        ) : (
          <span className="text-text-muted text-sm italic">Waiting to start…</span>
        )}
      </div>
      <ScrollToBottomButton visible={!isPinned} onClick={scrollToBottom} />
    </div>
  )
}
