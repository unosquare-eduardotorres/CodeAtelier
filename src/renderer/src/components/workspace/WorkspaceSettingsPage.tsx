import { useState, useEffect } from 'react'
import {
  ArrowLeft,
  FolderOpen,
  Settings,
  Zap,
  Lightbulb,
  Brain,
  Bot,
  Sparkles,
  Loader2,
  RotateCcw
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'
import { useSettingsStore } from '@renderer/store/settings.store'
import WorkspaceGeneralTab from './WorkspaceGeneralTab'
import TokenUsagePage from './TokenUsagePage'
import IdeasList from './IdeasList'
import BrainSettingsPage from './BrainSettingsPage'
import {
  AgentsList,
  AgentDetailPage,
  SkillsList,
  SkillDetailPage,
  ActivationBanner
} from '@renderer/components/settings'
import ClaudeMdDiffModal from '@renderer/components/settings/ClaudeMdDiffModal'
import SyncBanner from '@renderer/components/settings/SyncBanner'
import SyncReviewModal from '@renderer/components/settings/SyncReviewModal'

type SettingsTab = 'workspace' | 'agents' | 'skills' | 'ideas' | 'brain' | 'tokens'

const SETTINGS_MENU: { id: SettingsTab; label: string; icon: LucideIcon; iconColor?: string }[] = [
  { id: 'workspace', label: 'Workspace', icon: FolderOpen },
  { id: 'agents', label: 'Agents', icon: Bot, iconColor: 'text-blue-400' },
  { id: 'skills', label: 'Skills', icon: Sparkles, iconColor: 'text-amber-400' },
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
  const [showSyncReview, setShowSyncReview] = useState(false)
  const { activeWorkspace } = useWorkspaceStore()

  const {
    claudeStatus,
    isScanning,
    selectedAgent,
    selectedSkill,
    pendingClaudeMd,
    isConfirmingClaudeMd,
    syncDiff,
    isSyncing,
    isActivating,
    scanWorkspace,
    loadAgents,
    loadSkills,
    selectAgent,
    selectSkill,
    confirmClaudeMd,
    dismissClaudeMdPreview,
    computeSyncDiff,
    applySync,
    cleanAndReactivate,
    reset
  } = useSettingsStore()

  const workspacePath = activeWorkspace?.repoPath ?? null

  // Scan workspace on mount (for agents/skills tabs)
  useEffect(() => {
    if (workspacePath) {
      scanWorkspace(workspacePath)
      loadAgents(workspacePath)
      loadSkills(workspacePath)
      computeSyncDiff(workspacePath)
    }
    return () => {
      reset()
    }
  }, [workspacePath, scanWorkspace, loadAgents, loadSkills, computeSyncDiff, reset])

  const needsActivation = claudeStatus && !claudeStatus.hasAgentsDir && !claudeStatus.hasSkillsDir

  const isAgentsOrSkillsTab = activeTab === 'agents' || activeTab === 'skills'

  // Sync review modal (full page overlay)
  if (showSyncReview && syncDiff?.hasChanges) {
    return (
      <SyncReviewModal
        syncDiff={syncDiff}
        isSyncing={isSyncing}
        onApply={async (options) => {
          const result = await applySync(workspacePath!, options)
          return result
        }}
        onDismiss={() => setShowSyncReview(false)}
      />
    )
  }

  // CLAUDE.md diff review (full page overlay)
  if (pendingClaudeMd && workspacePath) {
    return (
      <ClaudeMdDiffModal
        existing={pendingClaudeMd.existing}
        proposed={pendingClaudeMd.proposed}
        workspacePath={workspacePath}
        onConfirm={(content) => confirmClaudeMd(workspacePath, content)}
        onDismiss={dismissClaudeMdPreview}
        isConfirming={isConfirmingClaudeMd}
      />
    )
  }

  // Detail views (full page)
  if (selectedAgent && workspacePath) {
    return (
      <AgentDetailPage
        agent={selectedAgent}
        workspacePath={workspacePath}
        onBack={() => selectAgent(null)}
      />
    )
  }

  if (selectedSkill) {
    return <SkillDetailPage skill={selectedSkill} onBack={() => selectSkill(null)} />
  }

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
        {activeWorkspace && <span className="text-xs text-gray-500">— {activeWorkspace.name}</span>}
        {/* Re-activate button for agents/skills tabs */}
        {isAgentsOrSkillsTab && workspacePath && !needsActivation && !isActivating && (
          <div className="ml-auto">
            <button
              onClick={() => {
                if (
                  confirm(
                    'This will remove all deployed agents and skills, then re-activate from scratch. Continue?'
                  )
                ) {
                  cleanAndReactivate(workspacePath)
                }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-amber-400 border border-amber-500/30 hover:bg-amber-500/10 transition-colors"
            >
              <RotateCcw size={12} />
              Re-activate
            </button>
          </div>
        )}
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
                  <Icon size={16} className={isActive ? undefined : item.iconColor} />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>
        </nav>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'workspace' && <WorkspaceGeneralTab />}

          {activeTab === 'agents' && workspacePath && (
            <div className="flex-1 overflow-y-auto">
              {isScanning ? (
                <div className="flex items-center justify-center py-16">
                  <div className="flex items-center gap-3 text-gray-400">
                    <Loader2 size={18} className="animate-spin" />
                    <span className="text-sm">Scanning workspace...</span>
                  </div>
                </div>
              ) : (
                <>
                  {needsActivation && (
                    <div className="px-6 pt-4">
                      <ActivationBanner workspacePath={workspacePath} />
                    </div>
                  )}
                  {syncDiff?.hasChanges && (
                    <div className="px-6 pt-4">
                      <SyncBanner
                        syncDiff={syncDiff}
                        isSyncing={isSyncing}
                        onReviewSync={() => setShowSyncReview(true)}
                        onAutoSync={async () => {
                          await applySync(workspacePath, { skipRemoved: true })
                          loadAgents(workspacePath)
                          loadSkills(workspacePath)
                        }}
                      />
                    </div>
                  )}
                  <div className="max-w-3xl mx-auto px-6 py-6">
                    <AgentsList workspacePath={workspacePath} />
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === 'skills' && workspacePath && (
            <div className="flex-1 overflow-y-auto">
              {isScanning ? (
                <div className="flex items-center justify-center py-16">
                  <div className="flex items-center gap-3 text-gray-400">
                    <Loader2 size={18} className="animate-spin" />
                    <span className="text-sm">Scanning workspace...</span>
                  </div>
                </div>
              ) : (
                <>
                  {needsActivation && (
                    <div className="px-6 pt-4">
                      <ActivationBanner workspacePath={workspacePath} />
                    </div>
                  )}
                  <div className="max-w-3xl mx-auto px-6 py-6">
                    <SkillsList workspacePath={workspacePath} />
                  </div>
                </>
              )}
            </div>
          )}

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
