import { useState } from 'react'
import { ArrowLeft, FolderOpen, Settings, Zap, Lightbulb, Brain } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import WorkspaceGeneralTab from './WorkspaceGeneralTab'
import TokenUsagePage from './TokenUsagePage'
import IdeasList from './IdeasList'
import BrainSettingsPage from './BrainSettingsPage'

type SettingsTab = 'workspace' | 'ideas' | 'brain' | 'tokens'

const SETTINGS_MENU: { id: SettingsTab; label: string; icon: LucideIcon; iconColor?: string }[] = [
  { id: 'workspace', label: 'Workspace', icon: FolderOpen },
  { id: 'ideas', label: 'Ideas', icon: Lightbulb, iconColor: 'text-yellow-400' },
  { id: 'brain', label: 'Brain', icon: Brain, iconColor: 'text-purple-400' },
  { id: 'tokens', label: 'Tokens', icon: Zap }
]

interface WorkspaceSettingsPageProps {
  onBack: () => void
}

export default function WorkspaceSettingsPage({
  onBack
}: WorkspaceSettingsPageProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<SettingsTab>('workspace')

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
        <span className="text-sm font-semibold text-gray-200">Workspace Settings</span>
      </div>

      {/* Two-column layout: left nav + content */}
      <div className="flex flex-1 min-h-0">
        {/* Left navigation */}
        <nav className="w-[200px] border-r border-gray-700 p-3 flex-shrink-0">
          <div className="space-y-0.5">
            {SETTINGS_MENU.map((item) => {
              const Icon = item.icon
              const isActive = activeTab === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                      : 'text-gray-400 hover:bg-gray-800/60 hover:text-gray-200 border border-transparent'
                  }`}
                >
                  <Icon
                    size={16}
                    className={isActive ? undefined : item.iconColor}
                  />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>
        </nav>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'workspace' && <WorkspaceGeneralTab />}
          {activeTab === 'ideas' && (
            <div className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <Lightbulb size={16} className="text-yellow-400" />
                <h3 className="text-sm font-semibold text-gray-200">Ideas</h3>
              </div>
              <p className="text-xs text-gray-500 mb-4">
                Captured ideas for future work items. Refine them with &quot;Grill Me&quot; or
                convert directly into conversations.
              </p>
              <IdeasList onNavigateToChat={onBack} />
            </div>
          )}
          {activeTab === 'brain' && <BrainSettingsPage />}
          {activeTab === 'tokens' && <TokenUsagePage />}
        </div>
      </div>
    </div>
  )
}
