import { ArrowLeft, Settings, RefreshCw, Download, CheckCircle2 } from 'lucide-react'
import { useUpdateStore } from '@renderer/store'

function UpdateButton(): React.JSX.Element {
  const { status, availableVersion, checkForUpdates, installUpdate } = useUpdateStore()

  if (status === 'ready') {
    return (
      <button
        onClick={installUpdate}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/10 transition-colors"
      >
        <CheckCircle2 size={12} />
        Install Update (v{availableVersion})
      </button>
    )
  }

  if (status === 'available') {
    return (
      <button
        onClick={() => useUpdateStore.getState().downloadUpdate()}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-indigo-400 border border-indigo-500/30 hover:bg-indigo-500/10 transition-colors"
      >
        <Download size={12} />
        Download v{availableVersion}
      </button>
    )
  }

  return (
    <button
      onClick={checkForUpdates}
      disabled={status === 'checking' || status === 'downloading'}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-400 border border-gray-600/30 hover:bg-gray-700/30 hover:text-gray-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <RefreshCw size={12} className={status === 'checking' ? 'animate-spin' : ''} />
      {status === 'checking'
        ? 'Checking...'
        : status === 'downloading'
          ? 'Downloading...'
          : 'Check for Updates'}
    </button>
  )
}

interface SettingsPageProps {
  onBack: () => void
}

export default function SettingsPage({ onBack }: SettingsPageProps): React.JSX.Element {
  return (
    <div className="flex-1 flex flex-col bg-gray-900 min-w-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-700 bg-gray-900">
        <button
          onClick={onBack}
          className="p-1.5 rounded-md hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
          aria-label="Back to chat"
          title="Back to chat"
        >
          <ArrowLeft size={16} />
        </button>
        <Settings size={16} className="text-indigo-400" />
        <span className="text-sm font-semibold text-gray-200">App Settings</span>
        <div className="ml-auto">
          <UpdateButton />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-8">
          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-gray-200 mb-2">Application</h3>
              <p className="text-xs text-gray-500">
                App-level settings and updates. Agents and skills are managed per workspace in
                Workspace Settings.
              </p>
            </div>

            {/* Update section */}
            <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-medium text-gray-200">Updates</h4>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Check for and install application updates
                  </p>
                </div>
                <UpdateButton />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
