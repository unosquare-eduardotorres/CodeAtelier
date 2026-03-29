import { Download, RefreshCw, X, AlertCircle, CheckCircle2 } from 'lucide-react'
import { useUpdateStore } from '@renderer/store'

export default function UpdateBanner(): React.JSX.Element | null {
  const {
    status,
    availableVersion,
    downloadProgress,
    errorMessage,
    downloadUpdate,
    installUpdate,
    dismiss
  } = useUpdateStore()

  if (status === 'idle' || status === 'checking') {
    return null
  }

  if (status === 'error') {
    return (
      <div className="flex items-center gap-3 px-4 py-2.5 bg-danger-muted border-b border-danger/50 text-sm">
        <AlertCircle size={14} className="text-danger shrink-0" />
        <span className="text-danger flex-1">Update error: {errorMessage ?? 'Unknown error'}</span>
        <button
          onClick={dismiss}
          className="p-1 rounded hover:bg-danger-muted text-danger hover:text-danger transition-colors"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  if (status === 'available') {
    return (
      <div className="flex items-center gap-3 px-4 py-2.5 bg-info-muted border-b border-info/50 text-sm">
        <Download size={14} className="text-info shrink-0" />
        <span className="text-info flex-1">
          Update <span className="font-semibold">v{availableVersion}</span> is available!
        </span>
        <button
          onClick={downloadUpdate}
          className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-primary hover:bg-primary-hover text-white text-xs font-medium transition-colors"
        >
          <Download size={12} />
          Download
        </button>
        <button
          onClick={dismiss}
          className="p-1 rounded hover:bg-info-muted text-info hover:text-info transition-colors"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  if (status === 'downloading') {
    return (
      <div className="flex items-center gap-3 px-4 py-2.5 bg-info-muted border-b border-info/50 text-sm">
        <RefreshCw size={14} className="text-info shrink-0 animate-spin" />
        <span className="text-info flex-1">
          Downloading update... {Math.round(downloadProgress)}%
        </span>
        <div className="w-32 h-2 bg-surface-base rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-300"
            style={{ width: `${downloadProgress}%` }}
          />
        </div>
      </div>
    )
  }

  if (status === 'ready') {
    return (
      <div className="flex items-center gap-3 px-4 py-2.5 bg-success-muted border-b border-success/50 text-sm">
        <CheckCircle2 size={14} className="text-success shrink-0" />
        <span className="text-success flex-1">
          Update <span className="font-semibold">v{availableVersion}</span> is ready to install!
        </span>
        <button
          onClick={installUpdate}
          className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-success hover:bg-success text-white text-xs font-medium transition-colors"
        >
          <RefreshCw size={12} />
          Restart & Install
        </button>
        <button
          onClick={dismiss}
          className="p-1 rounded hover:bg-success-muted text-success hover:text-success transition-colors"
          aria-label="Later"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  return null
}
