/**
 * AuditThinkingIndicator — thinking dots + tool activity display for audit
 * streaming. Matches the regular chat / grill thinking-indicator pattern but
 * with the auditor identity. Shown while a track is actively streaming so the
 * in-progress analysis reveals on finalize instead of stuttering token-by-token.
 */

import { Avatar } from '@renderer/components/common'
import { useChatAvatarSize } from '@renderer/hooks/useChatAvatarSize'
import ToolActivityBlock from '../chat/ToolActivityBlock'
import type { ToolActivity } from '../../../../shared/types'

interface AuditThinkingIndicatorProps {
  trackName: string
  toolActivities: ToolActivity[]
}

export default function AuditThinkingIndicator({
  trackName,
  toolActivities
}: AuditThinkingIndicatorProps): React.JSX.Element {
  const avatarSize = useChatAvatarSize()
  return (
    <div className="flex gap-3 flex-row">
      <div className="flex-shrink-0 mt-0.5">
        <Avatar avatarKey="atelier-auditor" size={avatarSize} />
      </div>
      <div className="flex flex-col max-w-[92%] items-start">
        <div className="flex flex-col mb-1 px-1 items-start">
          <span className="text-sm font-semibold text-text-primary leading-tight">
            {trackName} Auditor
          </span>
        </div>
        <div className="flex flex-col gap-2 px-5 py-4 rounded-xl bg-surface-overlay border border-border-subtle shadow-sm">
          <div className="flex items-center gap-1.5 py-0.5 px-1">
            <span className="typing-dot" style={{ animationDelay: '0ms' }} />
            <span className="typing-dot" style={{ animationDelay: '150ms' }} />
            <span className="typing-dot" style={{ animationDelay: '300ms' }} />
          </div>
          <p className="text-sm text-text-muted italic">Inspecting your codebase…</p>
          {toolActivities.length > 0 && (
            <div className="mt-2">
              <ToolActivityBlock activities={toolActivities} defaultExpanded />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
