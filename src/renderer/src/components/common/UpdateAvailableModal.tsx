import { Sparkles, Download, RefreshCw, AlertCircle, X } from 'lucide-react'
import { useUpdateStore } from '@renderer/store'

export default function UpdateAvailableModal(): React.JSX.Element | null {
  const {
    showModal,
    status,
    availableVersion,
    releaseNotes,
    releaseDate,
    downloadProgress,
    errorMessage,
    downloadUpdate,
    installUpdate,
    checkForUpdates,
    closeModal,
    dismiss
  } = useUpdateStore()

  if (!showModal) return null

  // Format release date
  const formattedDate = releaseDate
    ? new Date(releaseDate).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
    : null

  // Format download progress
  const progressPercent = Math.round(downloadProgress)

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-modal-title"
    >
      <div className="bg-surface-float border border-border-default rounded-xl shadow-2xl overflow-hidden w-[440px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 bg-surface-overlay border-b border-border-default">
          <div className="flex items-center gap-2.5">
            {status === 'downloading' ? (
              <RefreshCw size={18} className="text-info animate-spin" />
            ) : status === 'ready' ? (
              <Sparkles size={18} className="text-success" />
            ) : status === 'error' ? (
              <AlertCircle size={18} className="text-danger" />
            ) : (
              <Sparkles size={18} className="text-primary" />
            )}
            <h3 id="update-modal-title" className="text-sm font-semibold text-text-primary">
              {status === 'downloading'
                ? 'Downloading Update'
                : status === 'ready'
                  ? 'Ready to Install'
                  : status === 'error'
                    ? 'Update Error'
                    : 'Update Available'}
            </h3>
          </div>
          <button
            onClick={closeModal}
            className="p-1 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-5 space-y-4">
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

          {/* Downloading state */}
          {status === 'downloading' && (
            <>
              <div className="text-center space-y-3">
                <p className="text-sm text-text-primary font-medium">
                  Downloading v{availableVersion}
                </p>
                <div className="w-full h-2.5 bg-surface-base rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <p className="text-xs text-text-secondary">{progressPercent}% complete</p>
              </div>
            </>
          )}

          {/* Ready to install state */}
          {status === 'ready' && (
            <>
              <div className="text-center space-y-2">
                <p className="text-sm text-text-primary">
                  <span className="font-semibold">v{availableVersion}</span> has been downloaded and
                  is ready to install.
                </p>
                <p className="text-xs text-text-secondary">
                  The application will restart to complete the update.
                </p>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={closeModal}
                  className="px-4 py-2 text-xs font-medium rounded-lg text-text-secondary hover:bg-surface-overlay transition-colors"
                >
                  Later
                </button>
                <button
                  onClick={installUpdate}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-success text-white hover:bg-success/90 transition-colors"
                >
                  <RefreshCw size={12} />
                  Restart & Install
                </button>
              </div>
            </>
          )}

          {/* Available state (default) */}
          {status === 'available' && (
            <>
              <div className="text-center space-y-1">
                <p className="text-lg font-semibold text-text-primary">
                  Code Atelier v{availableVersion}
                </p>
                {formattedDate && (
                  <p className="text-xs text-text-secondary">Released {formattedDate}</p>
                )}
              </div>

              {/* Release notes */}
              {releaseNotes && (
                <div className="bg-surface-base border border-border-subtle rounded-lg px-4 py-3 max-h-36 overflow-y-auto">
                  <p className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider mb-1.5">
                    Release Notes
                  </p>
                  <p className="text-xs text-text-body whitespace-pre-wrap leading-relaxed">
                    {releaseNotes}
                  </p>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  onClick={closeModal}
                  className="px-4 py-2 text-xs font-medium rounded-lg text-text-secondary hover:bg-surface-overlay transition-colors"
                >
                  Later
                </button>
                <button
                  onClick={downloadUpdate}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors"
                >
                  <Download size={12} />
                  Update Now
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
