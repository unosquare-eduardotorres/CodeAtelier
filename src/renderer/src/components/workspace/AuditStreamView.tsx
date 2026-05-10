/**
 * AuditStreamView — chat-like scrollable container for audit execution.
 *
 * Renders one AuditMessageBubble per finalized segment plus one for the
 * current (streaming) segment, with auto-scrolling.
 * Read-only — no input box, audits are fully automated.
 */

import { useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import type { AuditTrackId } from '../../../../shared/types'
import { useAuditStore } from '@renderer/store'
import AuditMessageBubble from './AuditMessageBubble'
import AuditResultBubble from './AuditResultBubble'

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
  const hasCurrentSegment = currentContent || currentToolActivities.length > 0
  const hasAnyContent = segments.length > 0 || hasCurrentSegment

  // Auto-scroll on new content
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [currentContent, currentToolActivities.length, segments.length])

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-4">
      {hasAnyContent ? (
        <>
          {/* Finalized segments */}
          {segments.map((seg, i) => (
            <AuditMessageBubble
              key={`seg-${i}`}
              content={seg.content}
              toolActivities={seg.toolActivities}
              trackName={trackName}
              isStreaming={false}
              timestamp={seg.timestamp}
            />
          ))}

          {/* Current streaming segment */}
          {hasCurrentSegment && (
            <AuditMessageBubble
              content={currentContent}
              toolActivities={currentToolActivities}
              trackName={trackName}
              isStreaming={isStreaming}
              timestamp={Date.now()}
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
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <Loader2 size={14} className="animate-spin" />
          Starting audit…
        </div>
      ) : (
        <span className="text-text-muted text-sm italic">Waiting to start…</span>
      )}
    </div>
  )
}
