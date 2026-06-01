import { useEffect, useState } from 'react'
import { Landmark, Lightbulb } from 'lucide-react'
import { useWorkspaceStore, useChatStore, useMpaStore } from '@renderer/store'
import { useSettingsStore } from '@renderer/store/settings.store'
import TokenUsagePage from './TokenUsagePage'
import EventLogPage from './EventLogPage'
import IdeasList from './IdeasList'
import GrillPage from './GrillPage'
import MemorySettingsPage from './MemorySettingsPage'
import DocumentsPage from './DocumentsPage'
import ModelConfigTab from './ModelConfigTab'
import RepositorySettingsTab from './RepositorySettingsTab'
import CodeIntelligencePage from './CodeIntelligencePage'
import IntegrationsPage from './IntegrationsPage'
import SpecialistPage from './SpecialistPage'
import HealthPage from './HealthPage'
import GoalPage from './GoalPage'
import { CouncilLanding } from './council'
import { SkillDetailPage } from '@renderer/components/settings'
import CoreTeamPage from '@renderer/components/settings/CoreTeamPage'
import ClaudeMdDiffModal from '@renderer/components/settings/ClaudeMdDiffModal'
import type { SettingsTab } from './WorkspaceSettingsPanel'

interface WorkspaceSettingsContentProps {
  tab: SettingsTab
  onNavigateToChat: () => void
  onFixInNewChat: () => void
  onSettingsTabChange?: (tab: SettingsTab) => void
  onSendPlanToGrill?: (title: string, description: string) => void
  pendingGrill?: {
    ideaId: string
    conversationId: string
    ideaTitle: string
    ideaDescription?: string
    isNewSession?: boolean
  } | null
  onPendingGrillConsumed?: () => void
}

export default function WorkspaceSettingsContent({
  tab,
  onNavigateToChat,
  onFixInNewChat,
  onSettingsTabChange,
  onSendPlanToGrill,
  pendingGrill,
  onPendingGrillConsumed
}: WorkspaceSettingsContentProps): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()

  const {
    selectedSkill,
    pendingClaudeMd,
    isConfirmingClaudeMd,
    selectSkill,
    confirmClaudeMd,
    dismissClaudeMdPreview,
    reset
  } = useSettingsStore()

  const [activeGrill, setActiveGrill] = useState<{
    ideaId: string
    conversationId: string
    ideaTitle: string
    ideaDescription?: string
    isNewSession?: boolean
  } | null>(null)

  const workspacePath = activeWorkspace?.repoPath ?? null

  // Reset settings store on unmount
  useEffect(() => {
    return () => {
      reset()
    }
  }, [workspacePath, reset])

  // Auto-activate grill page when navigated from /grillme command
  useEffect(() => {
    if (pendingGrill) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- consuming pending navigation action
      setActiveGrill({
        ideaId: pendingGrill.ideaId,
        conversationId: pendingGrill.conversationId,
        ideaTitle: pendingGrill.ideaTitle,
        ideaDescription: pendingGrill.ideaDescription,
        isNewSession: pendingGrill.isNewSession
      })
      onPendingGrillConsumed?.()
    }
  }, [pendingGrill, onPendingGrillConsumed])

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
    <div
      className={`flex-1 flex flex-col bg-surface-raised min-w-0 ${tab === 'ideas' && activeGrill ? 'overflow-hidden' : 'overflow-y-auto'}`}
    >
      {tab === 'specialist' && <SpecialistPage />}
      {tab === 'health' && (
        <HealthPage
          onNavigateToChat={onNavigateToChat}
          onFixInNewChat={onFixInNewChat}
          onSendPlanToGrill={onSendPlanToGrill}
          onNavigateToCouncil={() => onSettingsTabChange?.('council')}
          onNavigateToGoals={() => onSettingsTabChange?.('goals')}
        />
      )}
      {tab === 'goals' && <GoalPage onNavigateToChat={onNavigateToChat} />}
      {tab === 'council' && (
        <div className="p-6">
          <div className="flex items-center gap-2 mb-2">
            <Landmark size={16} className="text-indigo-400" />
            <h3 className="text-sm font-semibold text-text-primary">Council</h3>
          </div>
          <p className="text-xs text-text-secondary mb-4">
            5 independent AI advisors review your plans, cross-examine each other, and deliver a
            scored verdict with recommendations.
          </p>
          <CouncilLanding
            onAcceptAndBuild={() => {
              onNavigateToChat()
            }}
            onRevisePlan={(feedback) => {
              const { appendLocalMessage } = useChatStore.getState()
              appendLocalMessage(
                `🏛️ **Council Review Feedback:**\n\n${feedback}\n\nPlease revise the plan based on this feedback.`,
                { role: 'user' }
              )
              onNavigateToChat()
            }}
            onDismiss={() => {
              // In standalone context: just reset, stay on council page
              // CouncilView already calls reset() before onDismiss
            }}
            onSendToGoal={(goal, title) => {
              const { setPreloadedGoal } = useMpaStore.getState()
              setPreloadedGoal({ text: `${title}\n\n${goal}` })
              onSettingsTabChange?.('goals')
            }}
          />
        </div>
      )}
      {tab === 'models' && <ModelConfigTab />}
      {tab === 'repository' && <RepositorySettingsTab />}
      {tab === 'code-intelligence' && <CodeIntelligencePage />}
      {tab === 'integrations' && <IntegrationsPage />}

      {tab === 'team' && workspacePath && (
        <div className="flex-1 min-h-0">
          <CoreTeamPage />
        </div>
      )}

      {tab === 'ideas' &&
        (activeGrill ? (
          <GrillPage
            ideaId={activeGrill.ideaId}
            conversationId={activeGrill.conversationId}
            ideaTitle={activeGrill.ideaTitle}
            ideaDescription={activeGrill.ideaDescription}
            isNewSession={activeGrill.isNewSession}
            onBack={() => setActiveGrill(null)}
            onComplete={() => {
              setActiveGrill(null)
              onNavigateToChat()
            }}
            onNavigateToGoals={() => {
              setActiveGrill(null)
              onSettingsTabChange?.('goals')
            }}
          />
        ) : (
          <div className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <Lightbulb size={16} className="text-warning" />
              <h3 className="text-sm font-semibold text-text-primary">Ideas</h3>
            </div>
            <p className="text-xs text-text-secondary mb-4">
              Your idea parking lot. Grill ideas with an AI analyst before building, or jump
              straight into a chat session.
            </p>
            <IdeasList
              onNavigateToChat={onNavigateToChat}
              onOpenGrillSession={(
                ideaId,
                conversationId,
                ideaTitle,
                isNewSession,
                ideaDescription
              ) =>
                setActiveGrill({ ideaId, conversationId, ideaTitle, ideaDescription, isNewSession })
              }
            />
          </div>
        ))}
      {tab === 'memory' && <MemorySettingsPage />}
      {tab === 'documents' && <DocumentsPage />}
      {tab === 'tokens' && <TokenUsagePage />}
      {tab === 'events' && <EventLogPage />}
    </div>
  )
}
