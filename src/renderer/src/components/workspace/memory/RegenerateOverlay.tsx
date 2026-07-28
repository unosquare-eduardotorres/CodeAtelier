import { Sparkles } from 'lucide-react'

interface RegenerateOverlayProps {
  message: string | null
  onCancel: () => void
}

/**
 * Full-panel animated overlay shown while CLAUDE.md regeneration is running.
 * Streams feedMessage progress lines and shows a pulsing sparkle spinner.
 */
export default function RegenerateOverlay({
  message,
  onCancel
}: RegenerateOverlayProps): React.JSX.Element {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-surface-base/80 backdrop-blur-sm rounded-lg">
      {/* Pulsing sparkle */}
      <div className="relative mb-6">
        <Sparkles className="w-10 h-10 text-primary-text animate-sparkle" />
        <div className="absolute inset-0 w-10 h-10 rounded-full bg-primary/20 animate-ping" />
      </div>

      <p className="text-sm font-medium text-text-primary mb-2">Regenerating CLAUDE.md…</p>

      {/* Streaming progress line */}
      {message && (
        <p className="text-xs text-text-muted max-w-md text-center px-4 animate-fade-in">
          {message}
        </p>
      )}

      <button
        onClick={onCancel}
        className="mt-6 px-3 py-1.5 text-xs text-text-muted hover:text-text-primary bg-surface-overlay border border-border-default rounded-md transition-colors"
      >
        Cancel
      </button>

      {/* Keyframe animations */}
      <style>{`
        @keyframes sparkle {
          0%, 100% { opacity: 1; transform: scale(1) rotate(0deg); }
          50% { opacity: 0.7; transform: scale(1.15) rotate(8deg); }
        }
        .animate-sparkle { animation: sparkle 2s ease-in-out infinite; }
        @keyframes fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in { animation: fade-in 0.3s ease-out; }
      `}</style>
    </div>
  )
}
