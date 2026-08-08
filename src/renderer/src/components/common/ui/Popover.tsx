import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface PopoverProps {
  /** Anchor element — receives the click handler and aria wiring. */
  trigger: (props: {
    ref: React.Ref<HTMLButtonElement>
    onClick: () => void
    'aria-expanded': boolean
    'aria-haspopup': 'dialog'
  }) => ReactNode
  children: ReactNode
  /** Horizontal edge the panel aligns to. */
  align?: 'start' | 'end'
  className?: string
  onOpenChange?: (open: boolean) => void
}

/**
 * Portal-rendered popover with outside-click / Escape dismissal and
 * viewport-aware placement. Used for filter menus and the explainer so they
 * do not have to occupy a permanent row in the layout.
 */
export default function Popover({
  trigger,
  children,
  align = 'start',
  className = '',
  onOpenChange
}: PopoverProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const setOpenState = useCallback(
    (next: boolean): void => {
      setOpen(next)
      onOpenChange?.(next)
    },
    [onOpenChange]
  )

  // Positioning writes straight to the node — measuring into state would
  // re-render the panel every time it opens or the window moves.
  const position = useCallback((): void => {
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!anchor || !panel) return
    const rect = anchor.getBoundingClientRect()
    const { offsetWidth: width, offsetHeight: height } = panel
    const left =
      align === 'end'
        ? Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
        : Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    // Flip above the anchor when there is not enough room below.
    const below = rect.bottom + 6
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below
    panel.style.top = `${top}px`
    panel.style.left = `${left}px`
    panel.style.visibility = 'visible'
  }, [align])

  useLayoutEffect(() => {
    if (open) position()
  }, [open, position])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      setOpenState(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpenState(false)
        anchorRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', position)
    // Capture phase so the panel follows an ancestor scroll container too.
    window.addEventListener('scroll', position, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open, position, setOpenState])

  return (
    <>
      {trigger({
        ref: anchorRef,
        onClick: () => setOpenState(!open),
        'aria-expanded': open,
        'aria-haspopup': 'dialog'
      })}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            style={{ top: 0, left: 0, visibility: 'hidden' }}
            className={`fixed z-[60] rounded-md border border-border-default bg-surface-float shadow-lg ${className}`}
          >
            {children}
          </div>,
          document.body
        )}
    </>
  )
}
