import { useState, useRef, useCallback, useEffect } from 'react'

// Web Speech API types — not all TS lib configs include these
interface SpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultList
}

interface SpeechRecognitionResultList {
  readonly length: number
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean
  readonly length: number
  [index: number]: SpeechRecognitionAlternative
}

interface SpeechRecognitionAlternative {
  readonly transcript: string
  readonly confidence: number
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string
  readonly message: string
}

interface UseVoiceInputOptions {
  /** Called with each finalized transcript segment */
  onTranscript: (text: string) => void
  /** Called with interim (in-progress) transcript for live preview */
  onInterimTranscript?: (text: string) => void
  /** BCP-47 language code (default: 'en-US') */
  language?: string
}

interface UseVoiceInputReturn {
  /** Whether actively recording */
  isListening: boolean
  /** Whether the browser supports Web Speech API */
  isSupported: boolean
  /** Last error message, if any */
  error: string | null
  /** Begin recording (call on mousedown/keydown) */
  startListening: () => void
  /** Stop recording and finalize (call on mouseup/keyup) */
  stopListening: () => void
  /** Clear the current error */
  clearError: () => void
}

// Chromium in Electron supports SpeechRecognition (may be prefixed)
const getSpeechRecognitionClass = (): (new () => SpeechRecognition) | null => {
  if (typeof window === 'undefined') return null
  return (
    (window as unknown as { SpeechRecognition?: new () => SpeechRecognition }).SpeechRecognition ||
    (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognition })
      .webkitSpeechRecognition ||
    null
  )
}

export function useVoiceInput({
  onTranscript,
  onInterimTranscript,
  language = 'en-US'
}: UseVoiceInputOptions): UseVoiceInputReturn {
  const [isListening, setIsListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const isListeningRef = useRef(false)

  const isSupported = getSpeechRecognitionClass() !== null

  const startListening = useCallback(() => {
    const SpeechRecognitionClass = getSpeechRecognitionClass()
    if (!SpeechRecognitionClass || isListeningRef.current) return

    const recognition = new SpeechRecognitionClass()
    recognition.continuous = true // Keep listening until explicitly stopped
    recognition.interimResults = true // Show live preview while speaking
    recognition.lang = language

    recognition.onresult = (event: SpeechRecognitionEvent): void => {
      let finalTranscript = ''
      let interimTranscript = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript
        if (event.results[i].isFinal) {
          finalTranscript += transcript
        } else {
          interimTranscript += transcript
        }
      }

      if (finalTranscript) {
        onTranscript(finalTranscript)
      }
      if (interimTranscript && onInterimTranscript) {
        onInterimTranscript(interimTranscript)
      }
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent): void => {
      // 'aborted' is expected when we call stop() — not a real error
      if (event.error !== 'aborted') {
        setError(
          event.error === 'not-allowed'
            ? 'Microphone access denied. Check System Preferences → Privacy → Microphone.'
            : `Speech recognition error: ${event.error}`
        )
      }
      setIsListening(false)
      isListeningRef.current = false
    }

    recognition.onend = (): void => {
      setIsListening(false)
      isListeningRef.current = false
    }

    recognitionRef.current = recognition
    recognition.start()
    setIsListening(true)
    isListeningRef.current = true
    setError(null)
  }, [language, onTranscript, onInterimTranscript])

  const stopListening = useCallback(() => {
    if (recognitionRef.current && isListeningRef.current) {
      recognitionRef.current.stop()
    }
    setIsListening(false)
    isListeningRef.current = false
  }, [])

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return (): void => {
      recognitionRef.current?.stop()
    }
  }, [])

  return { isListening, isSupported, error, startListening, stopListening, clearError }
}
