/**
 * NotificationSection — settings toggle for OS notifications.
 *
 * When enabled, the app shows native OS notifications for background
 * workspace events (blueprint questions, grill completion, audit results, etc.)
 * when the window is hidden or minimized.
 */

import { useNotificationsEnabled, useAppPreferenceActions } from '@renderer/store'
import { Bell, BellOff } from 'lucide-react'

export default function NotificationSection(): React.JSX.Element {
  const enabled = useNotificationsEnabled()
  const { setPreference } = useAppPreferenceActions()

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
    </div>
  )
}
