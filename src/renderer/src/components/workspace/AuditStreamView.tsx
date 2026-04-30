/**
 * AuditStreamView — chat-like scrollable container for audit execution.
 *
 * Renders a single AuditMessageBubble per track with auto-scrolling.
 * Read-only — no input box, audits are fully automated.
 */

import { useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import type { AuditTrackId } from '../../../../shared/types'
import { useAuditStore } from '@renderer/store'
import AuditMessageBubble from './AuditMessageBubble'

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
  const { perTrackStreaming } = useAuditStore()
  const trackData = perTrackStreaming[trackId]

  // Auto-scroll on new content
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [trackData?.content, trackData?.toolActivities.length])

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-4">
      {trackData?.content || (trackData?.toolActivities.length ?? 0) > 0 ? (
        <AuditMessageBubble
          content={trackData.content}
          toolActivities={trackData.toolActivities}
          trackName={trackName}
          isStreaming={isStreaming}
        />
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
