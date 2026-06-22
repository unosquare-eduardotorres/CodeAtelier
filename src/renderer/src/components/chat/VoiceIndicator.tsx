import { Mic, X } from 'lucide-react'

interface VoiceIndicatorProps {
  isListening: boolean
  interimText: string
  error: string | null
  onDismissError?: () => void
}

export default function VoiceIndicator({
  isListening,
  interimText,
  error,
  onDismissError
}: VoiceIndicatorProps): React.JSX.Element | null {
  if (!isListening && !error) return null

  // Error state
  if (error) {
    return (
      <div data-testid="voice-indicator-error" className="flex items-center gap-2 px-3 py-1.5 mb-1 text-xs text-danger bg-danger-muted rounded-lg border border-danger/20">
        <Mic size={12} />
        <span className="flex-1">{error}</span>
        {onDismissError && (
          <button
            onClick={onDismissError}
            className="p-0.5 rounded hover:bg-danger-muted transition-colors"
            aria-label="Dismiss error"
          >
            <X size={12} />
          </button>
        )}
      </div>
    )
  }

  // Recording state
  return (
    <div data-testid="voice-indicator-listening" className="flex items-center gap-2 px-3 py-1.5 mb-1 text-xs text-danger bg-danger-muted rounded-lg border border-danger/20 animate-pulse">
      <Mic size={12} className="text-danger" />
      <span className="text-text-secondary truncate flex-1">{interimText || 'Listening...'}</span>
      {/* Animated recording dots */}
      <div className="flex items-center gap-0.5 ml-auto flex-shrink-0">
        <div className="w-1.5 h-1.5 bg-danger rounded-full animate-bounce [animation-delay:-0.3s]" />
        <div className="w-1.5 h-1.5 bg-danger rounded-full animate-bounce [animation-delay:-0.15s]" />
        <div className="w-1.5 h-1.5 bg-danger rounded-full animate-bounce" />
      </div>
    </div>
  )
}
