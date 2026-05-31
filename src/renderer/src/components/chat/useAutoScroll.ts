import { useCallback, useEffect, useRef, useState } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'

/**
 * Manages scroll tracking, auto-scroll on new messages,
 * and a "scroll to bottom" action for the MessageList virtualizer.
 */
export function useAutoScroll(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  activeConversationId: string | null,
  messagesLength: number,
  streamingContent: string,
  streamingToolsLength: number,
  virtualizer: Virtualizer<HTMLDivElement, Element>
): {
  isAtBottom: boolean
  scrollToBottom: () => void
} {
  const shouldAutoScroll = useRef(true)
  const isUserScrolling = useRef(false)
  const [isAtBottom, setIsAtBottom] = useState(true)

  // Force scroll to bottom when switching conversations
  useEffect(() => {
    if (!activeConversationId) return
    shouldAutoScroll.current = true
    setIsAtBottom(true)
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    })
  }, [activeConversationId])

  // Handle scroll events to determine if user is at bottom
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    let scrollTimeout: ReturnType<typeof setTimeout>

    const handleScroll = (): void => {
      const { scrollTop, scrollHeight, clientHeight } = container
      // Use 150px threshold (larger than virtualizer's estimateSize) to avoid jitter
      const nearBottom = scrollHeight - scrollTop - clientHeight < 150
      shouldAutoScroll.current = nearBottom
      setIsAtBottom(nearBottom)

      isUserScrolling.current = true
      clearTimeout(scrollTimeout)
      scrollTimeout = setTimeout(() => {
        isUserScrolling.current = false
      }, 250) // Longer debounce to let virtualizer settle
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', handleScroll)
      clearTimeout(scrollTimeout)
    }
  }, [])

  // Auto-scroll to bottom when new messages arrive or streaming content updates
  useEffect(() => {
    if (shouldAutoScroll.current && scrollRef.current && !isUserScrolling.current) {
      requestAnimationFrame(() => {
        if (shouldAutoScroll.current && scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
      })
    }
  }, [messagesLength, streamingContent, streamingToolsLength])

  // Scroll-to-bottom handler for the floating button
  const scrollToBottom = useCallback(() => {
    if (!scrollRef.current) return

    // Step 1: Tell the virtualizer to scroll to the last message.
    if (messagesLength > 0) {
      virtualizer.scrollToIndex(messagesLength - 1, { align: 'end' })
    }

    // Step 2: After virtualizer updates, scroll to true bottom
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
      shouldAutoScroll.current = true
      setIsAtBottom(true)
    })
  }, [messagesLength, virtualizer])

  return { isAtBottom, scrollToBottom }
}
