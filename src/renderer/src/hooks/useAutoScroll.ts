import { useEffect, useRef } from 'react'

export function useAutoScroll(deps: unknown[]): React.RefObject<HTMLDivElement | null> {
  const containerRef = useRef<HTMLDivElement>(null)
  const shouldAutoScroll = useRef(true)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleScroll = (): void => {
      const { scrollTop, scrollHeight, clientHeight } = container
      // Auto-scroll if within 100px of bottom
      shouldAutoScroll.current = scrollHeight - scrollTop - clientHeight < 100
    }

    container.addEventListener('scroll', handleScroll)
    return () => container.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (container && shouldAutoScroll.current) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'smooth'
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return containerRef
}
