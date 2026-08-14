/**
 * StagedHandoffBanner — says out loud that the composer is pre-filled.
 *
 * A handoff lands the user in a brand-new conversation with a long message
 * already in the box and no reply. Without a marker that reads as "waiting for
 * you", the honest reading of that screen is "it broke" — so the one thing this
 * has to do is name the source and point at Send.
 *
 * Clears itself once the draft is gone (sent or emptied), so it cannot linger
 * over a conversation that has already started.
 */

import type { JSX } from 'react'
import { Sparkles, X } from 'lucide-react'
import { useChatStore, useChatActions } from '@renderer/store'

export function StagedHandoffBanner({
  conversationId
}: {
  conversationId: string
}): JSX.Element | null {
  const staged = useChatStore((s) => s.stagedHandoff)
  const hasDraft = useChatStore((s) => (s.draftTexts[conversationId] ?? '').length > 0)
  const { setStagedHandoff } = useChatActions()

  if (!staged || staged.conversationId !== conversationId || !hasDraft) return null

  return (
    <div className="flex items-start gap-2 mx-6 mb-2 px-3 py-2 rounded-lg border border-accent/25 bg-accent/10">
      <Sparkles size={13} className="mt-0.5 flex-shrink-0 text-accent" />
      <p className="flex-1 text-[11px] text-text-secondary">
        <span className="font-medium text-text-primary">
          Handed over from “{staged.sourceLabel}”.
        </span>{' '}
        The message below is ready — review it and press Send to start. Nothing has run yet.
      </p>
      <button
        type="button"
        onClick={() => setStagedHandoff(null)}
        aria-label="Dismiss handoff notice"
        className="flex-shrink-0 text-text-muted hover:text-text-primary transition-colors"
      >
        <X size={12} />
      </button>
    </div>
  )
}

export default StagedHandoffBanner
