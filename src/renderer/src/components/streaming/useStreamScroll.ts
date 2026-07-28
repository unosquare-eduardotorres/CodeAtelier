import { useCallback, useEffect, useRef, useState } from 'react'

/** Distance from bottom (px) to consider "pinned" to live scroll */
const SCROLL_PIN_THRESHOLD = 60

/**
 * Lightweight sticky-bottom scroll hook for streaming containers.
 * Unlike useAutoScroll (which requires a virtualizer), this works with
 * any plain scrollable div — used by StreamingTranscript, GoalPhaseStream,
 * AuditStreamView, and BlueprintPhaseStream.
 *
 * Pattern: auto-scroll only when user is pinned to the bottom.
 * When user scrolls up → isPinned = false → auto-scroll pauses.
 * ScrollToBottomButton re-pins on click.
 */
export function useStreamScroll(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  deps: ReadonlyArray<unknown>
): {
  isPinned: boolean
  scrollToBottom: () => void
} {
  const [isPinned, setIsPinned] = useState(true)
  const isUserScrolling = useRef(false)
  const isProgrammaticScroll = useRef(false)

  // Track scroll position to determine if user is at bottom
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    let scrollTimeout: ReturnType<typeof setTimeout>

    const handleScroll = (): void => {
      // Skip pin-state updates during programmatic smooth-scroll
      // to prevent the button from flashing back mid-animation.
      if (isProgrammaticScroll.current) return

      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      const nearBottom = distanceFromBottom < SCROLL_PIN_THRESHOLD
      setIsPinned(nearBottom)

      isUserScrolling.current = true
      clearTimeout(scrollTimeout)
      scrollTimeout = setTimeout(() => {
        isUserScrolling.current = false
      }, 150)
    }

    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', handleScroll)
      clearTimeout(scrollTimeout)
    }
  }, [scrollRef])

  // Auto-scroll only when pinned and not mid-user-scroll
  useEffect(() => {
    if (isPinned && scrollRef.current && !isUserScrolling.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are caller-provided content signals
  }, deps)

  // Explicit scroll-to-bottom with smooth animation + re-pin
  const scrollToBottom = useCallback(() => {
    if (!scrollRef.current) return
    isProgrammaticScroll.current = true
    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth'
    })
    setIsPinned(true)
    // Release after smooth-scroll completes (~400ms is generous for all platforms)
    setTimeout(() => {
      isProgrammaticScroll.current = false
    }, 400)
  }, [scrollRef])

  return { isPinned, scrollToBottom }
}
