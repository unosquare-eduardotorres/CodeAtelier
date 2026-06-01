/**
 * GrillThinkingIndicator — thinking dots + tool activity display for grill
 * evaluation streaming. Matches the regular chat thinking indicator pattern
 * from MessageListFooter but with grill-specific identity.
 */

import { Avatar } from '@renderer/components/common'
import ToolActivityBlock from '../chat/ToolActivityBlock'
import type { ToolActivity } from '../../../../shared/types'

interface GrillThinkingIndicatorProps {
  toolActivities: ToolActivity[]
}

export default function GrillThinkingIndicator({
  toolActivities
}: GrillThinkingIndicatorProps): React.JSX.Element {
  return (
    <div className="flex gap-3 flex-row">
      <div className="flex-shrink-0 mt-0.5">
        <Avatar avatarKey="grillme" size="xl" />
      </div>
      <div className="flex flex-col max-w-[92%] items-start">
        <div className="flex flex-col mb-1 px-1 items-start">
          <span className="text-sm font-semibold text-text-primary leading-tight">
            Grill Analyst
          </span>
        </div>
        <div className="flex flex-col gap-2 px-5 py-4 rounded-xl bg-surface-overlay border border-border-subtle shadow-sm">
          <div className="flex items-center gap-1.5 py-0.5 px-1">
            <span className="typing-dot" style={{ animationDelay: '0ms' }} />
            <span className="typing-dot" style={{ animationDelay: '150ms' }} />
            <span className="typing-dot" style={{ animationDelay: '300ms' }} />
          </div>
          <p className="text-sm text-text-muted italic">Analyzing your requirement…</p>
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
