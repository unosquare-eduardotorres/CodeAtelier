import { useState, useCallback, useRef, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import Avatar from './Avatar'
import { USER_AVATAR_KEY } from '@renderer/utils/agentIdentity'

interface WelcomeModalProps {
  onComplete: (displayName: string, avatarKey: string) => Promise<void>
}

/**
 * Full-screen welcome modal shown on first launch (no user_profile in DB).
 *
 * Single-step flow:
 *   - Name input with live chat preview using the fixed User portrait
 *
 * UI/UX Pro Max compliance:
 * - Backdrop: bg-[rgba(15,21,23,0.85)] backdrop-blur-md
 * - Container: max-w-md, centered with scale+fade entrance (300ms)
 * - Input: h-12 (48px touch target), auto-focus, visible label
 * - CTA: full-width h-12, disabled until name is entered
 * - Loading state on save button
 * - Reduced motion respected via Tailwind motion-reduce
 * - Keyboard: Tab order, Enter submits
 * - aria-live="polite" for preview updates
 */
export default function WelcomeModal({ onComplete }: WelcomeModalProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  // Auto-focus name input on mount
  useEffect(() => {
    setTimeout(() => nameInputRef.current?.focus(), 100)
  }, [])

  const handleGetStarted = useCallback(async () => {
    if (!name.trim()) return
    setIsSaving(true)
    setError(null)
    try {
      await onComplete(name.trim(), USER_AVATAR_KEY)
    } catch (err) {
      setError((err as Error).message)
      setIsSaving(false)
    }
  }, [name, onComplete])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (name.trim().length > 0) {
          handleGetStarted()
        }
      }
    },
    [name, handleGetStarted]
  )

  return (
    <div data-testid="welcome-modal" className="fixed inset-0 z-[200] flex items-center justify-center bg-[rgba(15,21,23,0.85)] backdrop-blur-md">
      <div
        ref={modalRef}
        className="relative w-full max-w-md mx-4 bg-surface-raised border border-border-subtle rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-300 motion-reduce:animate-none"
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to Code Atelier"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="px-8 pt-8 pb-2 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/15 mb-4">
            <svg
              viewBox="0 0 24 24"
              width={32}
              height={32}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-primary-text"
            >
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-text-primary">Welcome to Code Atelier</h1>
          <p className="text-sm text-text-secondary mt-1.5">
            Let&apos;s personalize your experience
          </p>
        </div>

        {/* Content area */}
        <div className="px-8 pb-4 pt-3">
          {error && (
            <div className="px-3 py-2 mb-4 rounded-lg bg-danger-muted border border-danger/20 text-sm text-danger">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label
                htmlFor="welcome-name"
                className="block text-sm font-semibold text-text-primary mb-2"
              >
                What should we call you?
              </label>
              <input
                ref={nameInputRef}
                id="welcome-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter your name"
                maxLength={50}
                autoComplete="off"
                className="w-full h-12 px-4 rounded-xl bg-surface-base border border-border-subtle text-base text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary transition-colors"
                aria-describedby="welcome-name-hint"
              />
              <p id="welcome-name-hint" className="text-xs text-text-muted mt-2">
                This name will appear in your chat messages
              </p>
            </div>

            {/* Live preview */}
            <div
              className="bg-surface-base rounded-xl p-4 border border-border-subtle"
              aria-live="polite"
              aria-label="Preview of how your name will appear"
            >
              <p className="text-[11px] text-text-muted mb-2 uppercase tracking-wider font-medium">
                Preview
              </p>
              <div className="flex items-start gap-3 flex-row-reverse">
                <Avatar avatarKey={USER_AVATAR_KEY} size="md" />
                <div className="flex flex-col items-end">
                  <span className="text-xs text-text-secondary mb-1 px-1">
                    {name.trim() || 'You'}
                  </span>
                  <div className="rounded-2xl px-4 py-2.5 bg-primary/90 text-white text-sm">
                    Hey team, let&apos;s build something amazing!
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer with CTA */}
        <div className="px-8 pb-8 pt-2">
          <button
            onClick={handleGetStarted}
            disabled={!name.trim() || isSaving}
            className="w-full h-12 rounded-xl text-sm font-semibold bg-primary hover:bg-primary-hover text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised"
          >
            {isSaving ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Setting up...
              </>
            ) : (
              'Get Started'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
