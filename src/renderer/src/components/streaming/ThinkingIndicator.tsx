/**
 * ThinkingIndicator — shared "agent is working" bubble used by every streaming
 * surface (Chat, Grill, Greenfield Grill, Council).
 *
 * Renders: avatar + name, a pulsing status label, an
 * optional ToolActivityBlock, and an optional hook-execution indicator.
 *
 * Identity (name / avatar / accent) is fully prop-driven so each surface can
 * present its own persona while sharing one implementation. Replaces the
 * bespoke GrillThinkingIndicator and the inline indicator in MessageListFooter.
 */

import { Avatar } from '@renderer/components/common'
import { useChatAvatarSize } from '@renderer/hooks/useChatAvatarSize'
import ToolActivityBlock from '@renderer/components/chat/ToolActivityBlock'
import HookActivityIndicator from '@renderer/components/chat/HookActivityIndicator'
import type { ToolActivity } from '../../../../shared/types'

export interface ThinkingIndicatorIdentity {
  name: string
  avatarKey: string
  accentColor?: string
}

interface ThinkingIndicatorProps {
  identity: ThinkingIndicatorIdentity
  toolActivities: ToolActivity[]
  /** Pulsing italic status label (e.g. "Building…", "Let me take a look…"). */
  label?: string
  /** Render the hook-execution indicator (chat only). */
  showHookIndicator?: boolean
}

export default function ThinkingIndicator({
  identity,
  toolActivities,
  label = 'Let me take a look…',
  showHookIndicator = false
}: ThinkingIndicatorProps): React.JSX.Element {
  const avatarSize = useChatAvatarSize()
  return (
    <div className="flex gap-3 flex-row">
      <div className="flex-shrink-0 mt-0.5">
        <Avatar
          avatarKey={identity.avatarKey}
          size={avatarSize}
          accentColor={identity.accentColor}
        />
      </div>
      <div className="flex flex-col max-w-[92%] items-start">
        <div className="flex flex-col mb-1 px-1 items-start">
          <span className="text-sm font-semibold text-text-primary leading-tight">
            {identity.name}
          </span>
        </div>
        <div className="flex flex-col gap-2 px-5 py-4 rounded-xl bg-surface-overlay border border-border-subtle shadow-sm">
          <p className="text-sm text-text-muted italic animate-thinking-pulse">{label}</p>
          {toolActivities.length > 0 && (
            <div className="mt-2">
              <ToolActivityBlock activities={toolActivities} defaultExpanded />
            </div>
          )}
          {showHookIndicator && <HookActivityIndicator />}
        </div>
      </div>
    </div>
  )
}
