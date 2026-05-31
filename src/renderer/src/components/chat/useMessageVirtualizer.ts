import { useCallback, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useChatBubbleSize } from '@renderer/store'

/**
 * Sets up the message list virtualizer and re-measures
 * when bubble size preference changes.
 */
export function useMessageVirtualizer(
  messagesLength: number,
  scrollRef: React.RefObject<HTMLDivElement | null>
): {
  virtualizer: ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>
  measureElement: (el: HTMLElement | null) => void
} {
  const virtualizer = useVirtualizer({
    count: messagesLength,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 150,
    overscan: 5
  })

  // Re-measure all virtual items when bubble size preference changes
  const bubbleSize = useChatBubbleSize()
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      virtualizer.measure()
    })
    return () => cancelAnimationFrame(raf)
  }, [bubbleSize, virtualizer])

  // Measure callback for virtualizer — wrapped in useCallback for stable reference
  const measureElement = useCallback(
    (el: HTMLElement | null) => {
      if (el) {
        virtualizer.measureElement(el)
      }
    },
    [virtualizer]
  )

  return { virtualizer, measureElement }
}
