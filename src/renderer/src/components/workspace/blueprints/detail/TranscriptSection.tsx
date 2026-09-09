/**
 * TranscriptSection — read-only hydrated chat history for a blueprint run.
 * Extracted from BlueprintDetailView so the view file stays a layout.
 */

import { useState, type JSX } from 'react'
import { MessageSquareText, ChevronDown } from 'lucide-react'
import { useBlueprintStore, type BlueprintChatMessage } from '@renderer/store/blueprint.store'
import { useChatAvatarSize } from '@renderer/hooks/useChatAvatarSize'
import { renderBlueprintMessage } from '../BlueprintChatView'

export function TranscriptSection({ blueprintId }: { blueprintId: string }): JSX.Element | null {
  const chatMessages = useBlueprintStore((s) => s.chatMessages)
  const currentBpId = useBlueprintStore((s) => s.currentBlueprint?.id)
  const avatarSize = useChatAvatarSize()
  const [expanded, setExpanded] = useState(false)

  // Only render if we have hydrated messages for THIS blueprint
  const messages = currentBpId === blueprintId ? chatMessages : []
  if (messages.length === 0) return null

  return (
    <div className="bg-surface-raised rounded-xl border border-border-subtle overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-surface-overlay/30 transition-colors"
      >
        <MessageSquareText size={14} className="text-accent" />
        <span className="text-xs font-semibold text-text-primary flex-1 text-left">Transcript</span>
        <span className="text-[10px] text-text-muted">{messages.length} messages</span>
        <ChevronDown
          size={12}
          className={`text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>
      {expanded && (
        <div className="border-t border-border/30 px-4 py-4 space-y-4 max-h-[600px] overflow-y-auto">
          {messages.map((msg: BlueprintChatMessage, i: number) =>
            // 'blueprint' ctx: tool rows open against this blueprint's execution
            // track in the drawer mounted at the bottom of this view.
            renderBlueprintMessage(msg, i, avatarSize, 'blueprint', blueprintId)
          )}
        </div>
      )}
    </div>
  )
}
