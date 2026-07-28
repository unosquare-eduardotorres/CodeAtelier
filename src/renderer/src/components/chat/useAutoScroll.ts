import { useCallback, useEffect, useRef, useState } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'

/**
 * Manages scroll tracking, auto-scroll on new messages,
 * and a "scroll to bottom" action for the MessageList virtualizer.
 */
export function useAutoScroll(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  contentRef: React.RefObject<HTMLDivElement | null>,
  activeConversationId: string | null,
  messagesLength: number,
  streamingContent: string,
  streamingToolsLength: number,
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  isEmpty: boolean
): {
  isAtBottom: boolean
  scrollToBottom: () => void
} {
  const shouldAutoScroll = useRef(true)
  const isUserScrolling = useRef(false)
  const lastScrollTop = useRef(0)
  const programmaticUntil = useRef(0)
  const [isAtBottom, setIsAtBottom] = useState(true)

  // Force scroll to bottom when switching conversations
  useEffect(() => {
    if (!activeConversationId) return
    shouldAutoScroll.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional state reset on conversation switch
    setIsAtBottom(true)

    // Use virtualizer.scrollToIndex() first — this is measurement-aware and
    // correctly handles items with estimated-but-not-yet-measured heights.
    // Direct scrollTop assignment races with virtualizer measurement and can
    // show only the bottom portion of the last message.
    if (messagesLength > 0) {
      virtualizer.scrollToIndex(messagesLength - 1, { align: 'end' })
    }

    // Safety net: after virtualizer and DOM settle, ensure we're at true bottom
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          programmaticUntil.current = performance.now() + 100
          lastScrollTop.current = scrollRef.current.scrollHeight
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
      })
    })
  }, [activeConversationId, messagesLength, virtualizer])

  // Content height changes (row measurement, images) fire NO scroll events.
  // Re-pin to bottom while auto-scroll is engaged; otherwise keep isAtBottom
  // honest so the scroll-to-bottom button appears.
  useEffect(() => {
    const content = contentRef.current
    const container = scrollRef.current
    if (!content || !container) return
    const ro = new ResizeObserver(() => {
      const el = scrollRef.current
      if (!el) return
      if (shouldAutoScroll.current) {
        programmaticUntil.current = performance.now() + 100
        el.scrollTop = el.scrollHeight
        lastScrollTop.current = el.scrollTop
      } else {
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150
        setIsAtBottom(nearBottom)
      }
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [activeConversationId, isEmpty])

  // Handle scroll events to determine if user is at bottom
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    let scrollTimeout: ReturnType<typeof setTimeout>

    const handleScroll = (): void => {
      const { scrollTop, scrollHeight, clientHeight } = container
      // Use 150px threshold (larger than virtualizer's estimateSize) to avoid jitter
      const nearBottom = scrollHeight - scrollTop - clientHeight < 150
      const scrolledDown = scrollTop >= lastScrollTop.current
      lastScrollTop.current = scrollTop

      // Only re-enable auto-scroll when user scrolls DOWN to the bottom.
      // Virtualizer re-measurements can shift scroll position toward the bottom —
      // don't let those programmatic adjustments re-engage auto-scroll.
      if (nearBottom && scrolledDown) {
        shouldAutoScroll.current = true
      } else if (!nearBottom) {
        shouldAutoScroll.current = false
      }
      // When nearBottom but scrolledUp (virtualizer adjustment), keep current state.

      setIsAtBottom(nearBottom)

      // Don't let our own programmatic scrolls trip the isUserScrolling debounce,
      // which would block the streaming auto-scroll effect.
      if (performance.now() >= programmaticUntil.current) {
        isUserScrolling.current = true
        clearTimeout(scrollTimeout)
        scrollTimeout = setTimeout(() => {
          isUserScrolling.current = false
        }, 250) // Longer debounce to let virtualizer settle
      }
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', handleScroll)
      clearTimeout(scrollTimeout)
    }
  }, [isEmpty])

  // Auto-scroll to bottom when new messages arrive or streaming content updates
  useEffect(() => {
    if (shouldAutoScroll.current && scrollRef.current && !isUserScrolling.current) {
      programmaticUntil.current = performance.now() + 100
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
    programmaticUntil.current = performance.now() + 100
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
