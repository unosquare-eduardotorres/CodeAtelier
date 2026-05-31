/**
 * useDraftText — Debounced draft text persistence with conversation-switch restore.
 *
 * Extracted from MessageInput to isolate the text ↔ store sync logic (~30 LOC).
 *
 * - Syncs local `text` state to the chat store's `draftTexts` map (debounced 300ms)
 * - Restores draft text from store when the active conversation changes
 */

import { useState, useEffect } from 'react'
import { useChatStore, useChatActions } from '@renderer/store'

interface UseDraftTextResult {
  text: string
  setText: React.Dispatch<React.SetStateAction<string>>
}

export function useDraftText(currentConversationId: string): UseDraftTextResult {
  const draftText = useChatStore((s) => s.draftTexts[currentConversationId] ?? '')
  const { setDraftText } = useChatActions()
  const [text, setText] = useState(draftText)

  // Sync local text → draft store (debounced 300ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      if (currentConversationId) setDraftText(currentConversationId, text)
    }, 300)
    return () => clearTimeout(timer)
  }, [text, currentConversationId, setDraftText])

  // Restore draft when conversation changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional state reset on conversation switch
    setText(useChatStore.getState().draftTexts[currentConversationId] ?? '')
  }, [currentConversationId])

  return { text, setText }
}
