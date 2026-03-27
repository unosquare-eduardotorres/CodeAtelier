import { useState, useEffect } from 'react'
import {
  Lightbulb,
  Loader2,
  Trash2
} from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'
import { useSettingsStore } from '@renderer/store/settings.store'
import WorkspaceGeneralTab from './WorkspaceGeneralTab'
import TokenUsagePage from './TokenUsagePage'
import IdeasList from './IdeasList'
import MemorySettingsPage from './MemorySettingsPage'
import DocumentsPage from './DocumentsPage'
import RepositorySettingsTab from './RepositorySettingsTab'
import {
  AgentsList,
  SkillsList,
  SkillDetailPage,
  ActivationBanner
} from '@renderer/components/settings'
import ClaudeMdDiffModal from '@renderer/components/settings/ClaudeMdDiffModal'
import SyncBanner from '@renderer/components/settings/SyncBanner'
import SyncReviewModal from '@renderer/components/settings/SyncReviewModal'
import type { SettingsTab } from './WorkspaceSettingsPanel'

interface WorkspaceSettingsContentProps {
  tab: SettingsTab
  onNavigateToChat: () => void
}

export default function WorkspaceSettingsContent({
  tab,
  onNavigateToChat
}: WorkspaceSettingsContentProps): React.JSX.Element {
  const [showSyncReview, setShowSyncReview] = useState(false)
  const { activeWorkspace } = useWorkspaceStore()

  const {
    claudeStatus,
    isScanning,
    selectedSkill,
    pendingClaudeMd,
    isConfirmingClaudeMd,
    syncDiff,
    isSyncing,
    isActivating,
    scanWorkspace,
    loadAgents,
    loadSkills,
    selectSkill,
    confirmClaudeMd,
    dismissClaudeMdPreview,
    computeSyncDiff,
    applySync,
    deleteAllAgents,
    deleteAllSkills,
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
  if (selectedSkill) {
    return <SkillDetailPage skill={selectedSkill} onBack={() => selectSkill(null)} />
  }

  return (
    <div className="flex-1 flex flex-col bg-surface-raised min-w-0 overflow-y-auto">
      {/* Delete All buttons for agents/skills */}
      {tab === 'agents' && workspacePath && !needsActivation && !isActivating && (
        <div className="px-6 pt-4 flex justify-end">
          <button
            onClick={() => {
              if (
                confirm(
                  'Delete ALL agents from workspace? This removes .claude/agents/, all DB records, and CLAUDE.md references.'
                )
              ) {
                deleteAllAgents(workspacePath)
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-red-400 border border-red-500/30 hover:bg-danger-muted transition-colors"
          >
            <Trash2 size={12} />
            Delete All Agents
          </button>
        </div>
      )}
      {tab === 'skills' && workspacePath && !needsActivation && !isActivating && (
        <div className="px-6 pt-4 flex justify-end">
          <button
            onClick={() => {
              if (
                confirm(
                  'Delete ALL skills from workspace? This removes .claude/skills/, all DB records, and CLAUDE.md references.'
                )
              ) {
                deleteAllSkills(workspacePath)
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-red-400 border border-red-500/30 hover:bg-danger-muted transition-colors"
          >
            <Trash2 size={12} />
            Delete All Skills
          </button>
        </div>
      )}

      {tab === 'workspace' && <WorkspaceGeneralTab />}
      {tab === 'repository' && <RepositorySettingsTab />}

      {tab === 'agents' && workspacePath && (
        <div className="flex-1 flex flex-col min-h-0">
          {isScanning ? (
            <div className="flex items-center justify-center py-16">
              <div className="flex items-center gap-3 text-text-secondary">
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
              {!needsActivation && (
                <div className="flex-1 min-h-0">
                  <AgentsList workspacePath={workspacePath} />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'skills' && workspacePath && (
        <div className="flex-1 overflow-y-auto">
          {isScanning ? (
            <div className="flex items-center justify-center py-16">
              <div className="flex items-center gap-3 text-text-secondary">
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

      {tab === 'ideas' && (
        <div className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <Lightbulb size={16} className="text-yellow-400" />
            <h3 className="text-sm font-semibold text-text-primary">Ideas</h3>
          </div>
          <p className="text-xs text-text-secondary mb-4">
            Captured ideas for future work items. Refine them with &quot;Grill Me&quot; or convert
            directly into conversations.
          </p>
          <IdeasList onNavigateToChat={onNavigateToChat} />
        </div>
      )}
      {tab === 'memory' && <MemorySettingsPage />}
      {tab === 'documents' && <DocumentsPage />}
      {tab === 'tokens' && <TokenUsagePage />}
    </div>
  )
}
