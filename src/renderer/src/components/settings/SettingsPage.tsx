import { useState, useEffect } from 'react'
import { ArrowLeft, Settings, Bot, Sparkles, Loader2 } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'
import { useSettingsStore } from '@renderer/store/settings.store'
import ActivationBanner from './ActivationBanner'
import AgentsList from './AgentsList'
import AgentDetailPage from './AgentDetailPage'
import SkillsList from './SkillsList'
import SkillDetailPage from './SkillDetailPage'
import ClaudeMdDiffModal from './ClaudeMdDiffModal'
import SyncBanner from './SyncBanner'
import SyncReviewModal from './SyncReviewModal'

interface SettingsPageProps {
  onBack: () => void
}

export default function SettingsPage({ onBack }: SettingsPageProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<'agents' | 'skills'>('agents')
  const { activeWorkspace } = useWorkspaceStore()
  const [showSyncReview, setShowSyncReview] = useState(false)
  const {
    claudeStatus,
    isScanning,
    selectedAgent,
    selectedSkill,
    pendingClaudeMd,
    isConfirmingClaudeMd,
    syncDiff,
    isSyncing,
    scanWorkspace,
    loadAgents,
    loadSkills,
    selectAgent,
    selectSkill,
    confirmClaudeMd,
    dismissClaudeMdPreview,
    computeSyncDiff,
    applySync,
    reset
  } = useSettingsStore()

  const workspacePath = activeWorkspace?.repoPath ?? null

  // Scan workspace on mount
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

  // No workspace selected
  if (!activeWorkspace || !workspacePath) {
    return (
      <div className="flex-1 flex flex-col bg-gray-900 min-w-0">
        <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-700 bg-gray-900">
          <button
            onClick={onBack}
            className="p-1.5 rounded-md hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
            aria-label="Back to chat"
          >
            <ArrowLeft size={16} />
          </button>
          <Settings size={16} className="text-indigo-400" />
          <span className="text-sm font-semibold text-gray-200">Settings</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Settings size={32} className="text-gray-700 mx-auto mb-3" />
            <p className="text-sm text-gray-500">Select a workspace first</p>
            <p className="text-xs text-gray-600 mt-1">
              Open a workspace to manage its agents and skills
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Sync review modal (full page overlay)
  if (showSyncReview && syncDiff?.hasChanges) {
    return (
      <SyncReviewModal
        syncDiff={syncDiff}
        isSyncing={isSyncing}
        onApply={async (options) => {
          const result = await applySync(workspacePath, options)
          return result
        }}
        onDismiss={() => setShowSyncReview(false)}
      />
    )
  }

  // CLAUDE.md diff review (full page overlay)
  if (pendingClaudeMd) {
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
  if (selectedAgent) {
    return (
      <AgentDetailPage
        agent={selectedAgent}
        workspacePath={workspacePath}
        onBack={() => selectAgent(null)}
      />
    )
  }

  if (selectedSkill) {
    return (
      <SkillDetailPage
        skill={selectedSkill}
        onBack={() => selectSkill(null)}
      />
    )
  }

  const tabs = [
    { id: 'agents' as const, label: 'Agents', icon: Bot },
    { id: 'skills' as const, label: 'Skills', icon: Sparkles }
  ]

  const needsActivation = claudeStatus && !claudeStatus.hasAgentsDir && !claudeStatus.hasSkillsDir

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
        <span className="text-sm font-semibold text-gray-200">Settings</span>
        <span className="text-xs text-gray-500">
          — {activeWorkspace.name}
        </span>
      </div>

      {/* Loading state */}
      {isScanning ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex items-center gap-3 text-gray-400">
            <Loader2 size={18} className="animate-spin" />
            <span className="text-sm">Scanning workspace...</span>
          </div>
        </div>
      ) : (
        <>
          {/* Activation banner (if needed) */}
          {needsActivation && (
            <div className="px-6 pt-4">
              <ActivationBanner workspacePath={workspacePath} />
            </div>
          )}

          {/* Sync banner (if YAML ↔ DB drift detected) */}
          {syncDiff?.hasChanges && (
            <div className="px-6 pt-4">
              <SyncBanner
                syncDiff={syncDiff}
                isSyncing={isSyncing}
                onReviewSync={() => setShowSyncReview(true)}
                onAutoSync={async () => {
                  await applySync(workspacePath, { skipRemoved: true })
                  // Refresh lists after sync
                  loadAgents(workspacePath)
                  loadSkills(workspacePath)
                }}
              />
            </div>
          )}

          {/* Tab bar */}
          <div className="flex gap-1 px-6 pt-4 pb-2 border-b border-gray-800">
            {tabs.map((tab) => {
              const Icon = tab.icon
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                    isActive
                      ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                  }`}
                >
                  <Icon size={14} />
                  {tab.label}
                </button>
              )
            })}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto px-6 py-6">
              {activeTab === 'agents' ? (
                <AgentsList workspacePath={workspacePath} />
              ) : (
                <SkillsList workspacePath={workspacePath} />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
