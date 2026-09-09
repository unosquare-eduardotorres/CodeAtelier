/**
 * useFocusTrap — keyboard containment for modal dialogs (WCAG 2.4.3).
 *
 * While active, Tab/Shift+Tab cycle within the container, focus is moved into
 * the dialog on mount and restored to the previously focused element on
 * unmount. Escape handling is left to the caller (many dialogs already own
 * it) — this hook only owns focus, not dismissal.
 */

import { useEffect, useRef } from 'react'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  options: { initialFocusRef?: React.RefObject<HTMLElement | null> } = {}
): React.RefObject<T | null> {
  const containerRef = useRef<T>(null)

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    const previouslyFocused = document.activeElement as HTMLElement | null

    // Move focus into the dialog — explicit target first, else first focusable,
    // else the container itself (it must be tabbable to receive focus).
    const focusInitial = (): void => {
      const target = options.initialFocusRef?.current
      if (target && document.contains(target)) {
        target.focus()
        return
      }
      const first = container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      if (first) first.focus()
      else {
        container.tabIndex = -1
        container.focus()
      }
    }
    focusInitial()

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((el) => el.offsetParent !== null || el === document.activeElement)
      if (focusables.length === 0) return

      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const current = document.activeElement

      if (e.shiftKey) {
        if (current === first || !container.contains(current)) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (current === last || !container.contains(current)) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    // Focusin catches focus that escaped via clicks/programmatic focus.
    const handleFocusIn = (e: FocusEvent): void => {
      if (!container.contains(e.target as Node)) focusInitial()
    }

    document.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('focusin', handleFocusIn, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('focusin', handleFocusIn, true)
      previouslyFocused?.focus()
    }
    // initialFocusRef is a ref — stable identity, read at activation time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  return containerRef
}
