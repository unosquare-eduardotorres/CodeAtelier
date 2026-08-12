import { useEffect } from 'react'

interface KeyboardOptions {
  count: number
  cursor: number
  setCursor: (next: number) => void
  onKeepNew: () => void
  onKeepOld: () => void
  onDismiss: () => void
  onToggleSelect: () => void
  onToggleExpand: () => void
  enabled: boolean
}

/**
 * j/k to move, a/s to resolve, d to dismiss, x to select, Enter to expand.
 *
 * The review tab is a triage queue; without keyboard shortcuts every decision
 * costs a mouse trip to one of three buttons.
 */
export function useReviewKeyboard({
  count,
  cursor,
  setCursor,
  onKeepNew,
  onKeepOld,
  onDismiss,
  onToggleSelect,
  onToggleExpand,
  enabled
}: KeyboardOptions): void {
  useEffect(() => {
    if (!enabled || count === 0) return

    const handler = (e: KeyboardEvent): void => {
      // Never steal keys from a field the user is typing into.
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          target.getAttribute('role') === 'dialog')
      ) {
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault()
          setCursor(Math.min(cursor + 1, count - 1))
          break
        case 'k':
        case 'ArrowUp':
          e.preventDefault()
          setCursor(Math.max(cursor - 1, 0))
          break
        case 'a':
          e.preventDefault()
          onKeepNew()
          break
        case 's':
          e.preventDefault()
          onKeepOld()
          break
        case 'd':
          e.preventDefault()
          onDismiss()
          break
        case 'x':
          e.preventDefault()
          onToggleSelect()
          break
        case 'Enter':
          e.preventDefault()
          onToggleExpand()
          break
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [
    enabled,
    count,
    cursor,
    setCursor,
    onKeepNew,
    onKeepOld,
    onDismiss,
    onToggleSelect,
    onToggleExpand
  ])
}
