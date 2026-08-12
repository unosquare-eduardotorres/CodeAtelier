import { useEffect, useState } from 'react'
import {
  Sparkles,
  Download,
  RefreshCw,
  AlertCircle,
  X,
  ChevronDown,
  CalendarDays
} from 'lucide-react'
import { useUpdateStore } from '@renderer/store'

/** Radius of the download progress ring — circumference drives the dash offset. */
const RING_RADIUS = 42
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

function formatMB(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

/** Per-status hero palette: [gradient classes, accent text class]. */
const HERO: Record<string, { gradient: string; accent: string }> = {
  available: { gradient: 'from-primary/30 via-info/25 to-primary/30', accent: 'text-primary' },
  downloading: { gradient: 'from-info/30 via-primary/25 to-info/30', accent: 'text-info' },
  staging: { gradient: 'from-info/30 via-primary/25 to-info/30', accent: 'text-info' },
  ready: { gradient: 'from-success/30 via-info/25 to-success/30', accent: 'text-success' },
  error: { gradient: 'from-danger/25 via-danger/15 to-danger/25', accent: 'text-danger' }
}

export default function UpdateAvailableModal(): React.JSX.Element | null {
  const {
    showModal,
    status,
    availableVersion,
    releaseNotes,
    releaseDate,
    downloadProgress,
    downloadSpeed,
    downloadTransferred,
    downloadTotal,
    installCountdown,
    errorMessage,
    downloadUpdate,
    installUpdate,
    cancelAutoInstall,
    checkForUpdates,
    closeModal,
    dismiss
  } = useUpdateStore()

  const [notesOpen, setNotesOpen] = useState(false)
  const [currentVersion, setCurrentVersion] = useState<string>('')

  useEffect(() => {
    window.api
      .getPlatformInfo()
      .then((info) => setCurrentVersion(info.appVersion))
      .catch(() => setCurrentVersion(''))
  }, [])

  if (!showModal) return null

  const formattedDate = releaseDate
    ? new Date(releaseDate).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
    : null

  const progressPercent = Math.round(downloadProgress)
  const hero = HERO[status] ?? HERO.available
  const isCountingDown = status === 'ready' && installCountdown !== null

  const title =
    status === 'downloading'
      ? 'Downloading Update'
      : status === 'staging'
        ? 'Preparing Update'
        : status === 'ready'
          ? 'Ready to Install'
          : status === 'error'
            ? 'Update Error'
            : 'Update Available'

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-modal-title"
    >
      <div
        data-testid="update-available-modal"
        className="bg-surface-float border border-border-default rounded-2xl shadow-2xl overflow-hidden w-[480px] max-h-[85vh] flex flex-col update-card-enter"
      >
        {/* ── Hero ── */}
        <div
          className={`relative h-32 shrink-0 flex items-center justify-center overflow-hidden update-aurora bg-gradient-to-r ${hero.gradient}`}
        >
          <div className={`update-ring update-ring-1 ${hero.accent}`} />
          <div className={`update-ring update-ring-2 ${hero.accent}`} />

          <div
            className={`update-icon-pulse relative z-10 w-14 h-14 rounded-2xl bg-surface-float/80 border border-border-subtle flex items-center justify-center ${hero.accent}`}
          >
            {status === 'downloading' || status === 'staging' ? (
              <RefreshCw size={26} className="animate-spin" />
            ) : status === 'ready' ? (
              /* Stroke-drawn checkmark — reads as "finished", not just "green". */
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M4 12.5 L9.5 18 L20 6.5"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="update-check-draw"
                />
              </svg>
            ) : status === 'error' ? (
              <AlertCircle size={26} />
            ) : (
              <Sparkles size={26} />
            )}
          </div>

          <button
            onClick={() => {
              // Closing the dialog must not leave a restart armed with no visible
              // countdown — the app would quit and reinstall out of nowhere.
              if (isCountingDown) cancelAutoInstall()
              closeModal()
            }}
            className="absolute top-3 right-3 z-20 p-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-overlay/70 transition-colors"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        {/* ── Body ── */}
        <div className="px-6 pt-4 pb-5 space-y-4 overflow-y-auto">
          <h3
            id="update-modal-title"
            className="text-sm font-semibold text-text-primary text-center tracking-wide"
          >
            {title}
          </h3>

          {/* Error state */}
          {status === 'error' && (
            <>
              <div className="bg-danger-muted border border-danger/30 rounded-lg px-4 py-3">
                <p className="text-sm text-danger">{errorMessage ?? 'An unknown error occurred'}</p>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => {
                    dismiss()
                    closeModal()
                  }}
                  className="px-4 py-2 text-xs font-medium rounded-lg text-text-secondary hover:bg-surface-overlay transition-colors"
                >
                  Dismiss
                </button>
                <button
                  onClick={checkForUpdates}
                  className="px-4 py-2 text-xs font-medium rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors"
                >
                  Retry
                </button>
              </div>
            </>
          )}

          {/* Downloading state — circular ring */}
          {status === 'downloading' && (
            <div className="flex flex-col items-center gap-3">
              <div className="relative w-[104px] h-[104px]">
                <svg width="104" height="104" viewBox="0 0 104 104" className="-rotate-90">
                  <circle
                    cx="52"
                    cy="52"
                    r={RING_RADIUS}
                    fill="none"
                    strokeWidth="6"
                    stroke="var(--color-surface-base)"
                  />
                  <circle
                    data-testid="update-progress-ring"
                    cx="52"
                    cy="52"
                    r={RING_RADIUS}
                    fill="none"
                    strokeWidth="6"
                    strokeLinecap="round"
                    stroke="var(--color-primary)"
                    className="transition-[stroke-dashoffset] duration-200 ease-out"
                    strokeDasharray={RING_CIRCUMFERENCE}
                    strokeDashoffset={RING_CIRCUMFERENCE * (1 - progressPercent / 100)}
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-xl font-semibold text-text-primary tabular-nums">
                    {progressPercent}%
                  </span>
                </div>
              </div>
              <p className="text-xs text-text-secondary tabular-nums">
                {downloadTotal > 0
                  ? `${formatMB(downloadTransferred)} of ${formatMB(downloadTotal)}`
                  : `v${availableVersion}`}
                {downloadSpeed > 0 && ` · ${formatMB(downloadSpeed)}/s`}
              </p>
              <p className="text-[11px] text-text-muted">
                The app will restart automatically when this finishes.
              </p>
            </div>
          )}

          {/* Preparing — downloaded, but the OS is still staging it.
              Deliberately no restart button: quitAndInstall() is a no-op until
              staging completes, so offering it here is offering a dead click. */}
          {status === 'staging' && (
            <div data-testid="update-staging" className="flex flex-col items-center gap-3">
              <p className="text-sm text-text-primary text-center">
                <span className="font-semibold">v{availableVersion}</span> is downloaded — preparing
                it for install…
              </p>
              <p className="text-[11px] text-text-muted text-center">
                This takes a few seconds. The restart option appears as soon as it is ready.
              </p>
              <div className="w-full flex items-center justify-end">
                <button
                  onClick={closeModal}
                  className="px-4 py-2 text-xs font-medium rounded-lg text-text-secondary hover:bg-surface-overlay transition-colors"
                >
                  Later
                </button>
              </div>
            </div>
          )}

          {/* Ready to install */}
          {status === 'ready' && (
            <>
              <div className="text-center space-y-1.5">
                <p className="text-sm text-text-primary">
                  <span className="font-semibold">v{availableVersion}</span> is downloaded and
                  ready.
                </p>
                {isCountingDown ? (
                  <p className="text-xs text-text-secondary tabular-nums">
                    {`Restarting in ${installCountdown}…`}
                  </p>
                ) : (
                  <p className="text-xs text-text-secondary">
                    The application will restart to complete the update.
                  </p>
                )}
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => {
                    // Cancelling only defers: installOnQuitIfReady() applies it
                    // the next time the app is closed.
                    cancelAutoInstall()
                    closeModal()
                  }}
                  className="px-4 py-2 text-xs font-medium rounded-lg text-text-secondary hover:bg-surface-overlay transition-colors"
                >
                  {isCountingDown ? 'Not now — install on quit' : 'Later'}
                </button>
                <button
                  onClick={installUpdate}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-success text-white hover:bg-success/90 transition-colors"
                >
                  <RefreshCw size={12} />
                  {isCountingDown ? 'Restart now' : 'Restart & Install'}
                </button>
              </div>
            </>
          )}

          {/* Available (default) */}
          {status === 'available' && (
            <>
              {/* Version transition */}
              <div className="flex items-center justify-center gap-3">
                {currentVersion && (
                  <span className="text-sm text-text-muted tabular-nums">v{currentVersion}</span>
                )}
                {currentVersion && (
                  <span className="update-arrow-enter text-text-secondary text-sm">→</span>
                )}
                <span className="update-arrow-enter text-2xl font-bold tabular-nums bg-gradient-to-r from-primary to-info bg-clip-text text-transparent">
                  v{availableVersion}
                </span>
              </div>

              {formattedDate && (
                <div className="flex justify-center">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-base border border-border-subtle text-[11px] text-text-secondary">
                    <CalendarDays size={11} />
                    Released {formattedDate}
                  </span>
                </div>
              )}

              {/* Release notes — collapsed so the sparse case stays clean */}
              {releaseNotes && (
                <div className="bg-surface-base border border-border-subtle rounded-lg overflow-hidden">
                  <button
                    onClick={() => setNotesOpen((o) => !o)}
                    aria-expanded={notesOpen}
                    className="w-full flex items-center justify-between px-3.5 py-2.5 text-[11px] font-semibold text-text-secondary uppercase tracking-wider hover:text-text-primary transition-colors"
                  >
                    What&apos;s new
                    <ChevronDown
                      size={14}
                      className={`transition-transform duration-200 ${notesOpen ? 'rotate-180' : ''}`}
                    />
                  </button>
                  {notesOpen && (
                    <p className="px-3.5 pb-3 text-xs text-text-body whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
                      {releaseNotes}
                    </p>
                  )}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  onClick={closeModal}
                  className="px-4 py-2 text-xs font-medium rounded-lg text-text-secondary hover:bg-surface-overlay transition-colors"
                >
                  Later
                </button>
                <button
                  onClick={downloadUpdate}
                  className="group flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg text-white bg-gradient-to-r from-primary to-info hover:opacity-90 transition-opacity"
                >
                  <Download
                    size={12}
                    className="transition-transform duration-200 group-hover:translate-y-0.5"
                  />
                  Update Now
                </button>
              </div>
              <p className="text-[11px] text-text-muted text-center">
                Downloads and installs automatically, then reopens.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
