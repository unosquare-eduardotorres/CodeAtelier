/**
 * BlueprintHandoffCard — "pass this blueprint over to a chat".
 *
 * A finished blueprint owns a branch and a working tree full of its output. The
 * next step is almost always one of a few things — look it over, get it running,
 * ship it — and each wants a different first instruction and a different chat
 * mode, so the user picks rather than the code guessing.
 *
 * Two facts drive everything below, and both are resolved up front rather than
 * discovered on failure:
 *
 *  - After the first handoff the branch belongs to *that* chat, not the
 *    blueprint. A second handoff must therefore offer a choice — take it back,
 *    or work in the checkout without it — instead of silently doing one.
 *  - The composed message is staged in the composer, never sent. Two of the four
 *    intents commit and push code.
 */

import { useState, useEffect, useCallback, type JSX } from 'react'
import { MessageSquarePlus, Loader2, AlertTriangle, GitBranch, ArrowRight } from 'lucide-react'
import { BLUEPRINT_HANDOFF_INTENTS } from '../../../../../../shared/blueprint-handoff'
import type {
  BlueprintHandoffIntent,
  BlueprintBranchMode,
  BlueprintHandoffOptions
} from '../../../../../../shared/blueprint-handoff'
import { useChatStore } from '@renderer/store/chat.store'
import { rendererLog } from '@renderer/utils/logger'

interface BlueprintHandoffCardProps {
  blueprintId: string
  blueprintTitle: string
  workspaceId: string | null
  onNavigateToChat?: () => void
}

/** Strip Electron's `Error invoking remote method 'x':` prefix off IPC rejections. */
function readableError(err: unknown): string {
  const message = (err as Error)?.message ?? 'Handoff failed'
  return message.replace(/^Error invoking remote method '[^']*': ?/, '')
}

export function BlueprintHandoffCard({
  blueprintId,
  blueprintTitle,
  workspaceId,
  onNavigateToChat
}: BlueprintHandoffCardProps): JSX.Element | null {
  const [options, setOptions] = useState<BlueprintHandoffOptions | null>(null)
  const [branchMode, setBranchMode] = useState<BlueprintBranchMode>('take')
  const [pending, setPending] = useState<BlueprintHandoffIntent | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    window.api
      .blueprintHandoffOptions({ workspaceId, blueprintId })
      .then((result) => {
        if (cancelled) return
        setOptions(result)
        // A busy holder cannot be taken from, so do not pre-arm a choice that is
        // guaranteed to fail.
        if (result.busyReason) setBranchMode('none')
      })
      .catch((err) => {
        if (cancelled) return
        rendererLog.error('[blueprint-handoff] could not read branch options:', err)
        setError(readableError(err))
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, blueprintId])

  const openConversation = useCallback(
    async (conversationId: string): Promise<void> => {
      if (!workspaceId) return
      await useChatStore.getState().loadConversations(workspaceId)
      const store = useChatStore.getState()
      if (!store.conversations.some((c) => c.id === conversationId)) {
        // selectConversation returns silently for an id it does not know, which
        // would navigate the user to whatever chat happened to be open and read
        // as "the handoff went somewhere else".
        throw new Error(
          'The conversation was created but has not appeared in the sidebar yet — reload the window to open it.'
        )
      }
      await store.selectConversation(conversationId)
      onNavigateToChat?.()
    },
    [workspaceId, onNavigateToChat]
  )

  const handoff = useCallback(
    async (intent: BlueprintHandoffIntent): Promise<void> => {
      if (!workspaceId) return
      setPending(intent)
      setError(null)
      try {
        const result = await window.api.blueprintHandoffToChat({
          workspaceId,
          blueprintId,
          intent,
          branchMode
        })
        // Stage before selecting: useDraftText reads the store when the active
        // conversation changes, so a draft written afterwards is not picked up.
        useChatStore.getState().setDraftText(result.conversationId, result.stagedMessage)
        useChatStore.getState().setStagedHandoff({
          conversationId: result.conversationId,
          sourceLabel: blueprintTitle
        })
        await openConversation(result.conversationId)
      } catch (err) {
        setError(readableError(err))
        rendererLog.error('[blueprint-handoff] failed:', err)
      } finally {
        setPending(null)
      }
    },
    [workspaceId, blueprintId, blueprintTitle, branchMode, openConversation]
  )

  const openHolder = useCallback(
    async (conversationId: string): Promise<void> => {
      setError(null)
      try {
        await openConversation(conversationId)
      } catch (err) {
        setError(readableError(err))
      }
    },
    [openConversation]
  )

  if (!workspaceId) return null

  const holder = options?.holder ?? null
  const heldByChat = holder?.kind === 'chat'
  const busy = options?.busyReason ?? null

  return (
    <div className="bg-surface-raised rounded-xl border border-border-subtle p-4 space-y-3">
      <div className="flex items-center gap-2">
        <MessageSquarePlus size={14} className="text-accent" />
        <span className="text-xs font-semibold text-text-primary">Continue in Chat</span>
      </div>
      <p className="text-[11px] text-text-muted">
        Hands this blueprint&apos;s branch, working tree and context to a new conversation. The
        first message is staged for you to review — nothing is sent automatically.
      </p>

      {/* ── Branch state ── */}
      {options?.branchName && (
        <div className="flex items-center gap-1.5 text-[11px] text-text-secondary">
          <GitBranch size={11} className="text-text-muted flex-shrink-0" />
          <code className="font-mono text-[10px] text-text-secondary">{options.branchName}</code>
          {holder && <span className="text-text-muted">· held by {holder.label}</span>}
        </div>
      )}

      {/* ── Someone else holds the branch: offer both routes ── */}
      {heldByChat && holder && (
        <div className="rounded-lg border border-info/20 bg-info-muted/40 p-3 space-y-2">
          <p className="text-[11px] text-info">
            This blueprint&apos;s branch now belongs to a chat. Choose what the new conversation
            should do:
          </p>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="branch-mode"
              className="mt-0.5"
              checked={branchMode === 'take'}
              disabled={Boolean(busy) || pending !== null}
              onChange={() => setBranchMode('take')}
            />
            <span className="text-[11px] text-text-secondary">
              <span className="font-medium text-text-primary">Take the branch</span> — the new chat
              inherits the working tree; {holder.label} loses it.
              {busy && <span className="text-warning"> Not possible right now: {busy}.</span>}
            </span>
          </label>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="branch-mode"
              className="mt-0.5"
              checked={branchMode === 'none'}
              disabled={pending !== null}
              onChange={() => setBranchMode('none')}
            />
            <span className="text-[11px] text-text-secondary">
              <span className="font-medium text-text-primary">Leave it</span> — the new chat works
              in the workspace checkout and reads the branch with git.
            </span>
          </label>

          {holder.conversationId && (
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void openHolder(holder.conversationId as string)}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium text-accent hover:text-accent/80 transition-colors disabled:opacity-50"
            >
              <ArrowRight size={11} />
              Or just open {holder.label}
            </button>
          )}
        </div>
      )}

      {/* ── Resuming this blueprint later will not find a branch it gave away ── */}
      {options?.branchName && !holder && (
        <p className="text-[10px] text-text-muted">
          Handing the branch over means resuming this blueprint later runs in the workspace
          checkout, not on its own working tree.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        {BLUEPRINT_HANDOFF_INTENTS.map((spec) => (
          <button
            key={spec.id}
            type="button"
            disabled={pending !== null}
            onClick={() => void handoff(spec.id)}
            className="flex flex-col items-start gap-0.5 px-3 py-2 rounded-lg border border-border-subtle text-left transition-colors hover:bg-surface-overlay/50 hover:border-accent/40 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-primary/50 outline-none"
          >
            <span className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
              {pending === spec.id && <Loader2 size={11} className="animate-spin" />}
              {spec.label}
            </span>
            <span className="text-[10px] text-text-muted">{spec.description}</span>
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-danger/20 bg-danger-muted text-danger">
          <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
          <span className="text-[11px]">{error}</span>
        </div>
      )}
    </div>
  )
}
