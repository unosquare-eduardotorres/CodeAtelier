import { Download, RefreshCw, X, AlertCircle, CheckCircle2 } from 'lucide-react'
import { useUpdateStore } from '@renderer/store'

export default function UpdateBanner(): React.JSX.Element | null {
  const { status, availableVersion, downloadProgress, errorMessage, downloadUpdate, installUpdate, dismiss } =
    useUpdateStore()

  if (status === 'idle' || status === 'checking') {
    return null
  }

  if (status === 'error') {
    return (
      <div className="flex items-center gap-3 px-4 py-2.5 bg-red-900/30 border-b border-red-800/50 text-sm">
        <AlertCircle size={14} className="text-red-400 shrink-0" />
        <span className="text-red-300 flex-1">
          Update error: {errorMessage ?? 'Unknown error'}
        </span>
        <button
          onClick={dismiss}
          className="p-1 rounded hover:bg-red-800/40 text-red-400 hover:text-red-300 transition-colors"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  if (status === 'available') {
    return (
      <div className="flex items-center gap-3 px-4 py-2.5 bg-indigo-900/30 border-b border-indigo-800/50 text-sm">
        <Download size={14} className="text-indigo-400 shrink-0" />
        <span className="text-indigo-200 flex-1">
          Update <span className="font-semibold">v{availableVersion}</span> is available!
        </span>
        <button
          onClick={downloadUpdate}
          className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors"
        >
          <Download size={12} />
          Download
        </button>
        <button
          onClick={dismiss}
          className="p-1 rounded hover:bg-indigo-800/40 text-indigo-400 hover:text-indigo-300 transition-colors"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  if (status === 'downloading') {
    return (
      <div className="flex items-center gap-3 px-4 py-2.5 bg-indigo-900/30 border-b border-indigo-800/50 text-sm">
        <RefreshCw size={14} className="text-indigo-400 shrink-0 animate-spin" />
        <span className="text-indigo-200 flex-1">
          Downloading update... {Math.round(downloadProgress)}%
        </span>
        <div className="w-32 h-1.5 bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-indigo-500 rounded-full transition-all duration-300"
            style={{ width: `${downloadProgress}%` }}
          />
        </div>
      </div>
    )
  }

  if (status === 'ready') {
    return (
      <div className="flex items-center gap-3 px-4 py-2.5 bg-emerald-900/30 border-b border-emerald-800/50 text-sm">
        <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />
        <span className="text-emerald-200 flex-1">
          Update <span className="font-semibold">v{availableVersion}</span> is ready to install!
        </span>
        <button
          onClick={installUpdate}
          className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
        >
          <RefreshCw size={12} />
          Restart & Install
        </button>
        <button
          onClick={dismiss}
          className="p-1 rounded hover:bg-emerald-800/40 text-emerald-400 hover:text-emerald-300 transition-colors"
          aria-label="Later"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  return null
}
