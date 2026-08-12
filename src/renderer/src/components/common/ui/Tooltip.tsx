import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface TooltipProps {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom'
  className?: string
}

/**
 * Portal-rendered tooltip with an arrow and viewport clamping.
 *
 * Absolutely-positioned in-flow tooltips were overlapping the controls next
 * to them and getting clipped by ancestor overflow; portalling fixes both.
 */
export default function Tooltip({
  content,
  children,
  side = 'top',
  className = ''
}: TooltipProps): React.JSX.Element {
  const [rect, setRect] = useState<DOMRect | null>(null)
  const wrapRef = useRef<HTMLSpanElement | null>(null)

  const show = useCallback((): void => {
    const el = wrapRef.current
    if (el) setRect(el.getBoundingClientRect())
  }, [])

  // The panel is portalled to <body>, so it does not move with an ancestor
  // scroll container. Without this, wheel-scrolling while a tooltip is open
  // leaves it stranded over unrelated content — which is easy to hit in the
  // virtualized memories list, where the trigger row can also be recycled.
  const open = rect !== null
  useEffect(() => {
    if (!open) return
    const reposition = (): void => {
      const el = wrapRef.current
      if (el) setRect(el.getBoundingClientRect())
      else setRect(null)
    }
    // Capture phase so ancestor scroll containers are observed too.
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  const top = rect ? (side === 'top' ? rect.top - 8 : rect.bottom + 8) : 0
  const left = rect ? rect.left + rect.width / 2 : 0

  return (
    <>
      <span
        ref={wrapRef}
        className="inline-flex"
        onMouseEnter={show}
        onMouseLeave={() => setRect(null)}
        onFocus={show}
        onBlur={() => setRect(null)}
      >
        {children}
      </span>
      {rect &&
        createPortal(
          <div
            role="tooltip"
            style={{
              top,
              left,
              transform: `translate(-50%, ${side === 'top' ? '-100%' : '0'})`,
              maxWidth: 'min(20rem, calc(100vw - 1rem))'
            }}
            className={`fixed z-[70] px-2.5 py-1.5 rounded-md border border-border-default bg-surface-float shadow-lg text-xs text-text-secondary pointer-events-none ${className}`}
          >
            {content}
          </div>,
          document.body
        )}
    </>
  )
}
