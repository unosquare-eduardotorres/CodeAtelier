/**
 * NotificationSection — settings toggle for OS notifications.
 *
 * When enabled, the app shows native OS notifications for background
 * workspace events (blueprint questions, grill completion, audit results, etc.)
 * when the window is hidden or minimized.
 */

import { useEffect, useState } from 'react'
import { useNotificationsEnabled, useAppPreferenceActions } from '@renderer/store'
import { Bell, BellOff, AlertTriangle } from 'lucide-react'

export default function NotificationSection(): React.JSX.Element {
  const enabled = useNotificationsEnabled()
  const { setPreference } = useAppPreferenceActions()
  const [probeResult, setProbeResult] = useState<'granted' | 'denied' | 'unsupported' | null>(null)

  useEffect(() => {
    if (enabled) {
      window.api.probeNotificationSupport().then(setProbeResult).catch(() => setProbeResult(null))
    } else {
      setProbeResult(null)
    }
  }, [enabled])

  return (
    <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <h4 className="text-sm font-medium text-text-primary">OS Notifications</h4>
          <p className="text-xs text-text-secondary mt-0.5">
            Show native notifications when processes complete or need your input while the app is in
            the background.
          </p>
        </div>
        <button
          onClick={() => void setPreference('notificationsEnabled', !enabled).catch(console.error)}
          className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
            enabled
              ? 'border-primary bg-primary-muted text-primary-text'
              : 'border-border-subtle hover:bg-surface-overlay text-text-secondary'
          }`}
        >
          {enabled ? <Bell size={14} /> : <BellOff size={14} />}
          {enabled ? 'Enabled' : 'Disabled'}
        </button>
      </div>

      {/* Warning banner — shown when enabled but macOS won't deliver */}
      {enabled && probeResult === 'denied' && (
        <div className="mt-3 flex items-start gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/20">
          <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-medium text-amber-400">macOS notifications unavailable</p>
            <p className="text-xs text-text-secondary mt-0.5">
              This app needs to be code-signed and notarized for native macOS notifications. In-app
              toasts will still appear when background tasks complete.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
