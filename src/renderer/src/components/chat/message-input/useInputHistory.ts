/**
 * useInputHistory — Terminal-style ArrowUp/Down message history navigation.
 *
 * Cycles through previously sent user messages in the current conversation.
 * Preserves the current unsent draft so ArrowDown restores it.
 *
 * Design notes:
 * - Uses refs (not state) for index/draft to avoid re-renders.
 * - Reads messages imperatively via getState() to avoid subscribing to
 *   the messages array (which updates on every streaming chunk).
 * - ArrowUp only activates when the cursor is on the first line.
 * - ArrowDown only activates when the cursor is on the last line.
 * - Modifier keys (Shift/Ctrl/Meta/Alt) are never intercepted.
 */

import { useRef, useEffect, useCallback } from 'react'
import { useChatStore } from '@renderer/store'

interface UseInputHistoryParams {
  text: string
  setText: React.Dispatch<React.SetStateAction<string>>
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  conversationId: string | undefined
}

interface UseInputHistoryResult {
  /** Call from onKeyDown — returns true if the key was consumed */
  handleHistoryKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
  /** Call from onChange to exit history mode when user types */
  resetHistory: () => void
}

export function useInputHistory({
  text,
  setText,
  textareaRef,
  conversationId
}: UseInputHistoryParams): UseInputHistoryResult {
  // -1 = not browsing (showing draft), 0 = last user msg, 1 = second-to-last, etc.
  const historyIndexRef = useRef(-1)
  const savedDraftRef = useRef('')

  // Reset on conversation switch
  useEffect(() => {
    historyIndexRef.current = -1
    savedDraftRef.current = ''
  }, [conversationId])

  const resetHistory = useCallback((): void => {
    historyIndexRef.current = -1
    savedDraftRef.current = ''
  }, [])

  const handleHistoryKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      // Don't intercept modified keys (selection, OS shortcuts)
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false

      if (e.key === 'ArrowUp') {
        const textarea = textareaRef.current
        if (!textarea) return false

        // Only activate when cursor is on the first line (no \n before cursor)
        // OR already in history browsing mode
        if (historyIndexRef.current < 0) {
          const textBeforeCursor = textarea.value.substring(0, textarea.selectionStart)
          if (textBeforeCursor.includes('\n')) return false
        }

        // Read user messages imperatively (no reactive subscription — avoids
        // re-renders on every streaming chunk)
        const userMessages = useChatStore
          .getState()
          .messages.filter((m) => m.role === 'user' && !m.hidden && m.contentMd.trim())

        if (userMessages.length === 0) return false

        // Already at the oldest message — consume key but don't change text
        if (historyIndexRef.current >= userMessages.length - 1) {
          e.preventDefault()
          return true
        }

        // Entering history mode: save current text as draft
        if (historyIndexRef.current < 0) {
          savedDraftRef.current = text
        }

        historyIndexRef.current++
        e.preventDefault()

        // userMessages is chronological — index from the end for reverse order
        const targetIndex = userMessages.length - 1 - historyIndexRef.current
        setText(userMessages[targetIndex].contentMd)

        // Place cursor at end of restored text
        requestAnimationFrame(() => {
          const el = textareaRef.current
          if (el) el.setSelectionRange(el.value.length, el.value.length)
        })

        return true
      }

      if (e.key === 'ArrowDown') {
        // Only handle when already in history mode
        if (historyIndexRef.current < 0) return false

        const textarea = textareaRef.current
        if (!textarea) return false

        // Only activate when cursor is on the last line (no \n after cursor)
        const textAfterCursor = textarea.value.substring(textarea.selectionStart)
        if (textAfterCursor.includes('\n')) return false

        historyIndexRef.current--
        e.preventDefault()

        if (historyIndexRef.current < 0) {
          // Back to saved draft
          setText(savedDraftRef.current)
        } else {
          const userMessages = useChatStore
            .getState()
            .messages.filter((m) => m.role === 'user' && !m.hidden && m.contentMd.trim())
          const targetIndex = userMessages.length - 1 - historyIndexRef.current
          setText(userMessages[targetIndex].contentMd)
        }

        // Place cursor at end
        requestAnimationFrame(() => {
          const el = textareaRef.current
          if (el) el.setSelectionRange(el.value.length, el.value.length)
        })

        return true
      }

      return false
    },
    [text, setText, textareaRef]
  )

  return { handleHistoryKey, resetHistory }
}
