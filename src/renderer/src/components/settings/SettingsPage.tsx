import { ArrowLeft, Settings } from 'lucide-react'
import AISubscriptionsSection from './AISubscriptionsSection'
import ThemeSection from './ThemeSection'
import ChatBubbleSizeSection from './ChatBubbleSizeSection'
import BlueprintBuildSection from './BlueprintBuildSection'
import SpecialistWarningPreferencesSection from './SpecialistWarningSection'
import SpecialistOrder from './SpecialistOrder'
import UpdateSettingsSection from './UpdateSettingsSection'
import NotificationSection from './NotificationSection'
import ProfileSection from './ProfileSection'

interface SettingsPageProps {
  onBack: () => void
}

export default function SettingsPage({ onBack }: SettingsPageProps): React.JSX.Element {
  return (
    <div data-testid="app-settings-page" className="flex-1 flex flex-col bg-surface-raised min-w-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border-subtle bg-surface-raised">
        <button
          onClick={onBack}
          className="p-1.5 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
          aria-label="Back to chat"
          title="Back to chat"
        >
          <ArrowLeft size={16} />
        </button>
        <Settings size={16} className="text-primary-text" />
        <span className="text-sm font-semibold text-text-primary">App Settings</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-8">
          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-text-primary mb-2">Application</h3>
              <p className="text-xs text-text-secondary">
                App-level settings and updates. Agents and skills are managed per workspace in
                Workspace Settings.
              </p>
            </div>

            {/* Profile — avatar + display name */}
            <ProfileSection />

            {/* AI Subscriptions section */}
            <AISubscriptionsSection />

            {/* Theme selection */}
            <ThemeSection />

            {/* OS Notifications */}
            <NotificationSection />

            {/* Chat bubble size */}
            <ChatBubbleSizeSection />

            {/* Blueprint parallel build agents */}
            <BlueprintBuildSection />

            {/* Specialist warning preferences */}
            <SpecialistWarningPreferencesSection />

            {/* Specialist Priority Order */}
            <SpecialistOrder />

            {/* Update section — expanded */}
            <UpdateSettingsSection />
          </div>
        </div>
      </div>
    </div>
  )
}
