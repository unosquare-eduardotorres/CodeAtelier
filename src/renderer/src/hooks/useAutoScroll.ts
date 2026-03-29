import { useEffect, useRef } from 'react'

export function useAutoScroll(deps: unknown[]): React.RefObject<HTMLDivElement | null> {
  const containerRef = useRef<HTMLDivElement>(null)
  const shouldAutoScroll = useRef(true)
  const isUserScrolling = useRef(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let scrollTimeout: ReturnType<typeof setTimeout>

    const handleScroll = (): void => {
      const { scrollTop, scrollHeight, clientHeight } = container
      // Auto-scroll if within 100px of bottom
      shouldAutoScroll.current = scrollHeight - scrollTop - clientHeight < 100

      // Mark user as actively scrolling, debounce the reset
      isUserScrolling.current = true
      clearTimeout(scrollTimeout)
      scrollTimeout = setTimeout(() => {
        isUserScrolling.current = false
      }, 150)
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', handleScroll)
      clearTimeout(scrollTimeout)
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (container && shouldAutoScroll.current) {
      // Use instant scroll to avoid RAF loop fighting user input
      container.scrollTop = container.scrollHeight
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return containerRef
}
