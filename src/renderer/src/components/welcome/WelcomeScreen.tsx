import { useCallback } from 'react'
import { Bot, FolderOpen, Plus, Mic, Keyboard, Flame, ChevronRight } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'

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

export default function WelcomeScreen(): React.JSX.Element {
  const { workspaces, openWorkspace, createWorkspace } = useWorkspaceStore()

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
    <div className="flex-1 flex flex-col items-center justify-center bg-gradient-to-b from-surface-base via-surface-overlay/20 to-surface-base overflow-y-auto">
      <div className="w-full max-w-2xl px-8 py-12">
        {/* Hero: Logo + Tagline */}
        <div className="flex items-center gap-3 mb-10 justify-center">
          <div className="w-14 h-14 rounded-2xl bg-primary-muted border border-primary/30 flex items-center justify-center">
            <Bot size={28} className="text-primary-text" />
          </div>
          <div className="text-left">
            <h1 className="text-2xl font-bold text-text-primary">Agent Studio</h1>
            <p className="text-sm text-text-secondary">AI-Powered Development Team</p>
          </div>
        </div>

        {/* Workspace Section */}
        <div className="mb-8">
          <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3 px-1">
            Your Workspaces
          </h2>

          <div className="space-y-2">
            {workspaces.length > 0 ? (
              workspaces.map((ws) => (
                <button
                  key={ws.id}
                  onClick={() => openWorkspace(ws.id)}
                  className="group flex items-center gap-3 w-full px-4 py-3 rounded-xl bg-surface-overlay border border-border-subtle hover:bg-surface-float hover:border-border-default transition-all text-left focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary-muted text-primary-text text-sm font-semibold flex-shrink-0">
                    {ws.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-primary truncate">{ws.name}</div>
                    <div className="text-xs text-text-secondary truncate">{ws.repoPath}</div>
                  </div>
                  <ChevronRight
                    size={16}
                    className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                  />
                </button>
              ))
            ) : (
              <div className="px-4 py-6 rounded-xl bg-surface-overlay border border-border-subtle text-center">
                <p className="text-sm text-text-secondary">
                  No workspaces yet. Add a project folder to get started.
                </p>
              </div>
            )}

            {/* Add Workspace — dashed card */}
            <button
              onClick={handleAddWorkspace}
              className="group flex items-center gap-3 w-full px-4 py-3 rounded-xl border-2 border-dashed border-border-default hover:border-primary/50 hover:bg-surface-overlay/60 transition-all text-left focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-surface-overlay border border-border-subtle text-text-muted group-hover:text-primary-text group-hover:border-primary/30 transition-colors flex-shrink-0">
                <Plus size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text-secondary group-hover:text-text-primary transition-colors">
                  Add Workspace
                </div>
                <div className="text-xs text-text-muted">Open a project folder</div>
              </div>
              <FolderOpen
                size={16}
                className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
              />
            </button>
          </div>
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
    </div>
  )
}
