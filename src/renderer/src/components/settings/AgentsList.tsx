import { useState, useEffect, useCallback } from 'react'
import { Bot, Loader2, Sparkles } from 'lucide-react'
import { useSettingsStore } from '@renderer/store/settings.store'
import { ConfirmDialog } from '@renderer/components/common'
import AgentListPanel from './AgentListPanel'
import AgentDetailPanel from './AgentDetailPanel'
import type { DiscoveredAgent } from '../../../../shared/types'

interface AgentsListProps {
  workspacePath: string
}

export default function AgentsList({ workspacePath }: AgentsListProps): React.JSX.Element {
  const { agents, loadAgents, deployAll } = useSettingsStore()
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<DiscoveredAgent | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<DiscoveredAgent | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [isDeploying, setIsDeploying] = useState(false)

  // YAML editor state
  const [editorContent, setEditorContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [hasEditorChanges, setHasEditorChanges] = useState(false)
  const [initialContent, setInitialContent] = useState('')

  // Load YAML content when agent is selected
  const loadAgentContent = useCallback(async (agent: DiscoveredAgent) => {
    if (!agent.isDeployed) {
      setEditorContent('')
      setInitialContent('')
      return
    }
    try {
      const content = await window.api.readWorkspaceFile({ filePath: agent.filePath })
      setEditorContent(content)
      setInitialContent(content)
      setHasEditorChanges(false)
    } catch {
      setEditorContent('')
      setInitialContent('')
    }
  }, [])

  // Update selected agent when agents list refreshes
  useEffect(() => {
    if (selectedAgent) {
      const updated = agents.find((a) => a.filename === selectedAgent.filename)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync selected agent with refreshed list
      if (updated) setSelectedAgent(updated)
    }
  }, [agents, selectedAgent])

  const handleSelectAgent = (agent: DiscoveredAgent): void => {
    setSelectedAgent(agent)
    loadAgentContent(agent)
  }

  const handleSync = async (agent: DiscoveredAgent): Promise<void> => {
    const id = agent.filename
    setSyncingIds((prev) => new Set(prev).add(id))
    try {
      await window.api.syncAgentToWorkspace({ workspacePath, filename: agent.filename })
      await loadAgents(workspacePath)
    } catch (error) {
      console.error('Failed to sync agent:', error)
    } finally {
      setSyncingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const handleDeleteConfirm = async (): Promise<void> => {
    if (!deleteTarget) return
    setDeletingId(deleteTarget.filename)
    try {
      await window.api.deleteAgentFromWorkspace({ workspacePath, filename: deleteTarget.filename })
      if (selectedAgent?.filename === deleteTarget.filename) setSelectedAgent(null)
      await loadAgents(workspacePath)
    } catch (error) {
      console.error('Failed to delete agent:', error)
    } finally {
      setDeleteTarget(null)
      setDeletingId(null)
    }
  }

  const handleActivateToggle = async (agent: DiscoveredAgent): Promise<void> => {
    setTogglingId(agent.filename)
    try {
      if (agent.isActive) {
        await window.api.deactivateAgent({ workspacePath, agentName: agent.parsed.name })
      } else {
        await window.api.activateAgent({ workspacePath, agentName: agent.parsed.name })
      }
      await loadAgents(workspacePath)
    } catch (error) {
      console.error('Failed to toggle agent:', error)
    } finally {
      setTogglingId(null)
    }
  }

  const handleSaveYaml = async (): Promise<void> => {
    if (!selectedAgent || !hasEditorChanges) return
    setIsSaving(true)
    try {
      await window.api.writeWorkspaceFile({
        filePath: selectedAgent.filePath,
        content: editorContent
      })
      setInitialContent(editorContent)
      setHasEditorChanges(false)
      await loadAgents(workspacePath)
    } catch (error) {
      console.error('Failed to save YAML:', error)
    } finally {
      setIsSaving(false)
    }
  }

  const handleEditorChange = (value: string): void => {
    setEditorContent(value)
    setHasEditorChanges(value !== initialContent)
  }

  const handleAutoActivate = async (): Promise<void> => {
    setIsDeploying(true)
    try {
      await deployAll(workspacePath)
    } finally {
      setIsDeploying(false)
    }
  }

  // Sort: deployed first, then by name
  const sortedAgents = [...agents].sort((a, b) => {
    if (a.isDeployed !== b.isDeployed) return a.isDeployed ? -1 : 1
    return a.parsed.name.localeCompare(b.parsed.name)
  })

  // Empty state
  if (sortedAgents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Bot size={32} className="text-border-default mb-3" />
        <h4 className="text-sm font-medium text-text-secondary mb-2">No specialists active yet</h4>
        <p className="text-xs text-text-muted max-w-sm mb-4">
          Activate specialist agents for this workspace. Each agent can be individually activated or
          deactivated as needed for your project.
        </p>
        <button
          onClick={handleAutoActivate}
          disabled={isDeploying}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary hover:bg-primary-hover text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isDeploying ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Activating...
            </>
          ) : (
            <>
              <Sparkles size={14} />
              Auto-Activate Agents
            </>
          )}
        </button>
      </div>
    )
  }

  return (
    <>
      <div className="flex h-full min-h-0">
        <AgentListPanel
          agents={sortedAgents}
          selectedAgent={selectedAgent}
          syncingIds={syncingIds}
          deletingId={deletingId}
          togglingId={togglingId}
          onSelect={handleSelectAgent}
          onSync={handleSync}
          onActivateToggle={handleActivateToggle}
          onDelete={setDeleteTarget}
        />
        <AgentDetailPanel
          selectedAgent={selectedAgent}
          togglingId={togglingId}
          editorContent={editorContent}
          hasEditorChanges={hasEditorChanges}
          isSaving={isSaving}
          onActivateToggle={handleActivateToggle}
          onEditorChange={handleEditorChange}
          onSaveYaml={handleSaveYaml}
        />
      </div>

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="Delete Agent"
        message={`Remove "${deleteTarget?.parsed.name ?? ''}" from this workspace? This will delete the agent YAML from .claude/agents/ and remove references from CLAUDE.md.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  )
}
