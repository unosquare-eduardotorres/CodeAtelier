import { useEffect } from 'react'

/** True when the event came from somewhere the user is typing. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true
  )
}

/**
 * Keyboard navigation for the ticket list.
 *
 * `/` focuses the filter, `j`/`k` move, `space` ticks the row, `Enter` opens it.
 *
 * Every binding is suppressed while the focus is in a text field — otherwise
 * typing `just the login bug` into the JQL box would move the cursor, tick a
 * row and open a detail pane. Modifier chords are left alone so the app's own
 * shortcuts keep working.
 */
export function useJiraKeyboard({
  enabled,
  filterInputRef,
  cursorKey,
  onMove,
  onToggle,
  onOpen
}: {
  enabled: boolean
  filterInputRef: React.RefObject<HTMLInputElement | null>
  cursorKey: string | null
  onMove: (delta: number) => void
  onToggle: (key: string) => void
  onOpen: (key: string) => void
}): void {
  useEffect(() => {
    if (!enabled) return

    const handler = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isEditableTarget(event.target)) return

      switch (event.key) {
        case '/':
          event.preventDefault()
          filterInputRef.current?.focus()
          return
        case 'j':
        case 'ArrowDown':
          event.preventDefault()
          onMove(1)
          return
        case 'k':
        case 'ArrowUp':
          event.preventDefault()
          onMove(-1)
          return
        case ' ':
          if (cursorKey === null) return
          event.preventDefault()
          onToggle(cursorKey)
          return
        case 'Enter':
          if (cursorKey === null) return
          event.preventDefault()
          onOpen(cursorKey)
          return
        default:
      }
    }

    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [enabled, filterInputRef, cursorKey, onMove, onToggle, onOpen])
}
