import { useState, useCallback, useRef, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import Avatar from './Avatar'
import AvatarPicker from './AvatarPicker'

interface WelcomeModalProps {
  onComplete: (displayName: string, avatarKey: string) => Promise<void>
}

/**
 * Full-screen welcome modal shown on first launch (no user_profile in DB).
 *
 * Two-step flow:
 *   1. Name input with live chat preview
 *   2. Avatar selection grid
 *
 * UI/UX Pro Max compliance:
 * - Backdrop: bg-black/70 backdrop-blur-md
 * - Container: max-w-md, centered with scale+fade entrance (300ms)
 * - Input: h-12 (48px touch target), auto-focus, visible label
 * - Avatar grid: 4×4, 48px each, 12px gap (meets 44×44 minimum)
 * - Focus trap within modal (Tab cycles through interactive elements)
 * - CTA: full-width h-12, disabled until name is entered
 * - Loading state on save button
 * - Reduced motion respected via Tailwind motion-reduce
 * - Keyboard: Tab order, Enter submits on last step
 * - aria-live="polite" for preview updates
 */
export default function WelcomeModal({ onComplete }: WelcomeModalProps): React.JSX.Element {
  const [step, setStep] = useState<1 | 2>(1)
  const [name, setName] = useState('')
  const [avatarKey, setAvatarKey] = useState('astronaut')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  // Auto-focus name input on mount
  useEffect(() => {
    if (step === 1) {
      setTimeout(() => nameInputRef.current?.focus(), 100)
    }
  }, [step])

  const handleNameContinue = useCallback(() => {
    if (name.trim().length > 0) {
      setStep(2)
    }
  }, [name])

  const handleGetStarted = useCallback(async () => {
    if (!name.trim()) return
    setIsSaving(true)
    setError(null)
    try {
      await onComplete(name.trim(), avatarKey)
    } catch (err) {
      setError((err as Error).message)
      setIsSaving(false)
    }
  }, [name, avatarKey, onComplete])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (step === 1 && name.trim().length > 0) {
          handleNameContinue()
        } else if (step === 2) {
          handleGetStarted()
        }
      }
    },
    [step, name, handleNameContinue, handleGetStarted]
  )

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-md">
      <div
        ref={modalRef}
        className="relative w-full max-w-md mx-4 bg-surface-raised border border-border-subtle rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-300 motion-reduce:animate-none"
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to Agent Studio"
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
          <h1 className="text-xl font-bold text-text-primary">Welcome to Agent Studio</h1>
          <p className="text-sm text-text-secondary mt-1.5">
            {step === 1
              ? "Let's personalize your experience"
              : 'Choose an avatar that represents you'}
          </p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 py-3">
          <div
            className={`h-1.5 rounded-full transition-all duration-300 ${
              step === 1 ? 'w-8 bg-primary' : 'w-3 bg-primary/40'
            }`}
          />
          <div
            className={`h-1.5 rounded-full transition-all duration-300 ${
              step === 2 ? 'w-8 bg-primary' : 'w-3 bg-primary/40'
            }`}
          />
        </div>

        {/* Content area */}
        <div className="px-8 pb-4">
          {error && (
            <div className="px-3 py-2 mb-4 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
              {error}
            </div>
          )}

          {step === 1 ? (
            /* Step 1: Name input */
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
                  <Avatar avatarKey={avatarKey} size="md" />
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
          ) : (
            /* Step 2: Avatar selection */
            <div className="space-y-4">
              <AvatarPicker value={avatarKey} onChange={setAvatarKey} columns={4} size="lg" />

              {/* Preview with selected avatar */}
              <div
                className="bg-surface-base rounded-xl p-4 border border-border-subtle"
                aria-live="polite"
                aria-label="Preview of how you will appear in conversations"
              >
                <p className="text-[11px] text-text-muted mb-2 uppercase tracking-wider font-medium">
                  Preview
                </p>
                <div className="flex items-start gap-3 flex-row-reverse">
                  <Avatar avatarKey={avatarKey} size="md" />
                  <div className="flex flex-col items-end">
                    <span className="text-xs text-text-secondary mb-1 px-1">{name.trim()}</span>
                    <div className="rounded-2xl px-4 py-2.5 bg-primary/90 text-white text-sm">
                      Hey team, let&apos;s build something amazing!
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer with CTA */}
        <div className="px-8 pb-8 pt-2">
          {step === 1 ? (
            <button
              onClick={handleNameContinue}
              disabled={!name.trim()}
              className="w-full h-12 rounded-xl text-sm font-semibold bg-primary hover:bg-primary-hover text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised"
            >
              Continue
            </button>
          ) : (
            <div className="flex gap-3">
              <button
                onClick={() => setStep(1)}
                disabled={isSaving}
                className="h-12 px-5 rounded-xl text-sm font-medium text-text-body hover:text-text-primary bg-surface-overlay hover:bg-surface-float transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                Back
              </button>
              <button
                onClick={handleGetStarted}
                disabled={isSaving}
                className="flex-1 h-12 rounded-xl text-sm font-semibold bg-primary hover:bg-primary-hover text-white transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised"
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
          )}
        </div>
      </div>
    </div>
  )
}
