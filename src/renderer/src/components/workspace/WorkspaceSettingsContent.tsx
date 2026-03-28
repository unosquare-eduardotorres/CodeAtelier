import { useEffect, useState } from 'react'
import { Lightbulb } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'
import { useSettingsStore } from '@renderer/store/settings.store'
import TokenUsagePage from './TokenUsagePage'
import EventLogPage from './EventLogPage'
import IdeasList from './IdeasList'
import GrillPage from './GrillPage'
import MemorySettingsPage from './MemorySettingsPage'
import DocumentsPage from './DocumentsPage'
import ModelConfigTab from './ModelConfigTab'
import RepositorySettingsTab from './RepositorySettingsTab'
import { SkillDetailPage, SpecialistMarketplace } from '@renderer/components/settings'
import ClaudeMdDiffModal from '@renderer/components/settings/ClaudeMdDiffModal'
import type { SettingsTab } from './WorkspaceSettingsPanel'

interface WorkspaceSettingsContentProps {
  tab: SettingsTab
  onNavigateToChat: () => void
}

export default function WorkspaceSettingsContent({
  tab,
  onNavigateToChat
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
    <div className={`flex-1 flex flex-col bg-surface-raised min-w-0 ${tab === 'ideas' && activeGrill ? 'overflow-hidden' : 'overflow-y-auto'}`}>
      {tab === 'models' && <ModelConfigTab />}
      {tab === 'repository' && <RepositorySettingsTab />}

      {tab === 'team' && workspacePath && (
        <div className="flex-1 min-h-0">
          <SpecialistMarketplace workspacePath={workspacePath} />
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
          />
        ) : (
          <div className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <Lightbulb size={16} className="text-yellow-400" />
              <h3 className="text-sm font-semibold text-text-primary">Ideas</h3>
            </div>
            <p className="text-xs text-text-secondary mb-4">
              Captured ideas for future work items. Refine them with &quot;Grill Me&quot; or convert
              directly into conversations.
            </p>
            <IdeasList
              onNavigateToChat={onNavigateToChat}
              onOpenGrillSession={(ideaId, conversationId, ideaTitle, isNewSession, ideaDescription) =>
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
