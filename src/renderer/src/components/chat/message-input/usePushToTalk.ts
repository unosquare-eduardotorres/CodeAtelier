import { useEffect, type RefObject } from 'react'

/**
 * Push-to-talk keyboard shortcut: hold V key (when textarea not focused) to record.
 * Release to stop recording and insert transcribed text.
 */
export function usePushToTalk(opts: {
  voiceEnabled: boolean
  isVoiceSupported: boolean
  isListening: boolean
  startListening: () => void
  stopListening: () => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
}): void {
  const {
    voiceEnabled,
    isVoiceSupported,
    isListening,
    startListening,
    stopListening,
    textareaRef
  } = opts

  useEffect(() => {
    if (!voiceEnabled || !isVoiceSupported) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (
        e.code === 'KeyV' &&
        !e.repeat &&
        document.activeElement !== textareaRef.current &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        startListening()
      }
    }

    const handleKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'KeyV' && isListening) {
        e.preventDefault()
        stopListening()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return (): void => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [voiceEnabled, isVoiceSupported, isListening, startListening, stopListening, textareaRef])
}
