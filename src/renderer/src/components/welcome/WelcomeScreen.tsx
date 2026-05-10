import { useCallback, useState } from 'react'
import { Bot, FolderOpen, Plus, Sparkles, Mic, Keyboard, Flame } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'
import { useWorkspaceCardsData } from '@renderer/hooks/useWorkspaceCardsData'
import { ConfirmDialog } from '@renderer/components/common'
import FloatingIconField from './FloatingIconField'
import WorkspaceCard from './WorkspaceCard'
import CreateProjectWizard from './CreateProjectWizard'

const isMac = navigator.platform.toUpperCase().includes('MAC')
const metaKey = isMac ? '⌘' : 'Ctrl+'

const tips = [
  {
    icon: Mic,
    title: 'Voice Mode',
    description: 'Type /voice to dictate messages'
  },
  {
    icon: Keyboard,
    title: 'Shortcuts',
    description: `${metaKey}N new chat, ${metaKey}B sidebar, ${metaKey}J agents`
  },
  {
    icon: Flame,
    title: 'Grill Mode',
    description: 'Type /grillme to stress-test your plan'
  }
] as const

interface AddWorkspaceCardProps {
  onClick: () => void
}

/**
 * Local presentational sub-component — kept inside WelcomeScreen to avoid a new file.
 * Reuses the dashed-border treatment as a card-shaped tile that fills a grid cell.
 */
function AddWorkspaceCard({ onClick }: AddWorkspaceCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-center justify-center gap-3 w-full min-h-[12rem] text-center p-4 rounded-2xl border-2 border-dashed border-border-default hover:border-primary/50 hover:bg-surface-overlay/60 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-surface-overlay border border-border-subtle text-text-muted group-hover:text-primary-text group-hover:border-primary/30 transition-colors">
        <Plus size={18} />
      </div>
      <div>
        <div className="text-sm font-medium text-text-secondary group-hover:text-text-primary transition-colors">
          Add Workspace
        </div>
        <div className="text-xs text-text-muted mt-0.5">Open a project folder</div>
      </div>
      <FolderOpen
        size={16}
        className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity"
      />
    </button>
  )
}

/**
 * "Create New Project" dashed card — opens the wizard.
 */
function CreateProjectCard({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-center justify-center gap-3 w-full min-h-[12rem] text-center p-4 rounded-2xl border-2 border-dashed border-border-default hover:border-primary/50 hover:bg-surface-overlay/60 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary-muted border border-primary/30 text-primary-text group-hover:border-primary/50 transition-colors">
        <Sparkles size={18} />
      </div>
      <div>
        <div className="text-sm font-medium text-text-secondary group-hover:text-text-primary transition-colors">
          Create New Project
        </div>
        <div className="text-xs text-text-muted mt-0.5">Start from scratch with AI guidance</div>
      </div>
    </button>
  )
}

export default function WelcomeScreen(): React.JSX.Element {
  const { workspaces, openWorkspace, createWorkspace, deleteWorkspace } = useWorkspaceStore()
  const cardData = useWorkspaceCardsData(workspaces)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [showWizard, setShowWizard] = useState(false)

  const handleAddWorkspace = useCallback(async (): Promise<void> => {
    try {
      const dirPath = await window.api.selectDirectory()
      if (dirPath) {
        const name = dirPath.split(/[\\/]/).filter(Boolean).pop() || 'Untitled'
        await createWorkspace(name, dirPath)
      }
    } catch (error) {
      console.error('Failed to add workspace:', error)
    }
  }, [createWorkspace])

  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-gradient-to-b from-surface-base via-surface-overlay/20 to-surface-base overflow-y-auto relative">
      {/* Animated background: floating dev icons + mini avatars */}
      <FloatingIconField />

      {/* All content stays above floating icons */}
      <div className="w-full max-w-5xl px-8 py-12 relative z-10">
        {/* Hero: Logo + Tagline */}
        <div className="flex items-center gap-3 mb-10 justify-center">
          <div className="w-14 h-14 rounded-2xl bg-primary-muted border border-primary/30 flex items-center justify-center">
            <Bot size={28} className="text-primary-text" />
          </div>
          <div className="text-left">
            <h1 className="text-2xl font-bold text-text-primary">Code Atelier</h1>
            <p className="text-sm text-text-secondary">AI-Powered Development Team</p>
          </div>
        </div>

        {/* Workspace Section */}
        <div className="mb-8">
          <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3 px-1">
            Your Workspaces
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {workspaces.map((ws) => (
              <WorkspaceCard
                key={ws.id}
                workspace={ws}
                data={cardData[ws.id]}
                onOpen={openWorkspace}
                onDelete={(id) => setDeleteTarget(id)}
              />
            ))}
            <AddWorkspaceCard onClick={handleAddWorkspace} />
            <CreateProjectCard onClick={() => setShowWizard(true)} />
          </div>

          {workspaces.length === 0 && (
            <p className="mt-3 text-center text-xs text-text-muted">
              No workspaces yet. Add a project folder to get started.
            </p>
          )}
        </div>

        {/* Quick Tips */}
        <div className="mb-8">
          <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3 px-1">
            Quick Tips
          </h2>
          <div className="grid grid-cols-3 gap-3">
            {tips.map((tip) => (
              <div
                key={tip.title}
                className="bg-surface-overlay/60 border border-border-subtle rounded-lg px-3 py-3"
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <tip.icon size={14} className="text-primary-text flex-shrink-0" />
                  <span className="text-xs font-medium text-text-primary">{tip.title}</span>
                </div>
                <p className="text-xs text-text-secondary leading-relaxed">{tip.description}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Footer: Version */}
        <div className="text-center">
          <span className="text-xs text-text-muted">v1.0.0</span>
        </div>
      </div>

      {/* Confirm dialog for workspace removal */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="Remove Workspace"
        message="Remove this workspace from Code Atelier? Your project files will not be deleted."
        confirmLabel="Remove"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          if (deleteTarget) {
            deleteWorkspace(deleteTarget)
          }
          setDeleteTarget(null)
        }}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Create New Project wizard overlay */}
      {showWizard && (
        <CreateProjectWizard
          onClose={() => setShowWizard(false)}
          onCreated={(workspaceId) => {
            setShowWizard(false)
            openWorkspace(workspaceId)
          }}
        />
      )}
    </div>
  )
}
