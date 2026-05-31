/**
 * swap-to-specialist.action.ts — Extracted from submitQuestionAnswers in chat.store.ts.
 *
 * Contains the full swap-to-specialist flow: IPC call → message reload →
 * specialist identity resolution → greeting → auto-continue with original
 * message replay. Previously an 84-line branch buried inside the
 * question-answer handler.
 */

import { rendererLog } from '@renderer/utils/logger'
import { useWorkspaceStore } from './workspace.store'
import { useProjectSpecialistStore } from './project-specialist.store'
import type { Message } from '../../../shared/types'

/** Minimal interface for the chat state slice this action needs */
interface SwapActionState {
  activeConversation: { id: string } | null
  messages: Message[]
  appendLocalMessage: (content: string, opts?: { role?: Message['role']; agentId?: string }) => void
  switchPersona: (personaSpecialistId: string) => Promise<void>
  sendMessage: (text: string, attachments?: string[]) => Promise<void>
}

type GetState = () => SwapActionState
type SetState = (
  partial: Partial<SwapActionState> | ((state: SwapActionState) => Partial<SwapActionState>)
) => void

/**
 * Execute the swap-to-specialist flow after the user accepts the proposal.
 *
 * Steps:
 *  1. Show immediate "swapping" feedback
 *  2. IPC call to backend swapToSpecialist
 *  3. Reload messages for clean state
 *  4. Resolve specialist identity from ProjectSpecialistStore
 *  5. Switch persona and show greeting
 *  6. Auto-continue: re-send the user's original message to the specialist
 */
export function executeSwapToSpecialist(get: GetState, set: SetState): void {
  const workspaceId = useWorkspaceStore.getState().activeWorkspace?.id
  if (!workspaceId) {
    rendererLog.warn('swap-to-specialist: no active workspace — skipping IPC call')
    return
  }

  // Show immediate feedback
  get().appendLocalMessage('🔄 *Swapping to Project Specialist…*')

  window.api
    .swapToSpecialist({ workspaceId })
    .then(async () => {
      // Reload messages to get clean state after swap
      const { activeConversation } = get()
      if (activeConversation) {
        const messages = await window.api.getMessages({
          conversationId: activeConversation.id
        })
        set({ messages })
      }

      // Resolve the Project Specialist to get its identity
      await useProjectSpecialistStore.getState().loadForWorkspace(workspaceId)
      const specialist = useProjectSpecialistStore.getState().byWorkspace[workspaceId]

      if (specialist) {
        // Switch the persona selector to the specialist
        await get().switchPersona(specialist.id)

        // Greeting from the specialist (with specialist avatar/identity)
        get().appendLocalMessage(
          `👋 **${specialist.displayName}** is now active and ready. I'm your dedicated specialist for this workspace — send a message and let's get to work!`,
          { role: 'specialist', agentId: specialist.agentId }
        )
      } else {
        get().appendLocalMessage(
          '✅ *Specialist is now active. Send a message to start working with your Project Specialist.*'
        )
      }

      // ── Auto-continue: re-send the user's original message ──
      // The swap was triggered by a user request that DaVinci deferred
      // to the specialist. Re-sending ensures the specialist picks up
      // immediately instead of sitting idle waiting for new input.
      const { messages: currentMessages } = get()
      const lastUserMessage = [...currentMessages].reverse().find((m) => m.role === 'user')
      if (lastUserMessage?.contentMd?.trim()) {
        // Parse attachments from the original message (if any)
        let attachments: string[] | undefined
        try {
          const parsed = JSON.parse(lastUserMessage.attachmentsJson || '[]') as string[]
          if (parsed.length > 0) attachments = parsed
        } catch {
          /* no attachments */
        }

        // Brief delay to let the greeting render and scroll settle
        await new Promise((resolve) => setTimeout(resolve, 300))
        await get().sendMessage(lastUserMessage.contentMd, attachments)
      }
    })
    .catch((err) => {
      rendererLog.error('swapToSpecialist failed:', err)
      get().appendLocalMessage(
        '❌ *Failed to swap to specialist. Please try again from workspace settings.*'
      )
    })
}
