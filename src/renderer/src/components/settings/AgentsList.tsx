import { useState, useEffect, useCallback } from 'react'
import { Bot, RefreshCw, Trash2, Loader2, Rocket, Save, Power, PowerOff } from 'lucide-react'
import { useSettingsStore } from '@renderer/store/settings.store'
import { ConfirmDialog } from '@renderer/components/common'
import CodeEditor from './CodeEditor'
import { AGENT_META } from '../../../../shared/constants'
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
      if (updated) {
        setSelectedAgent(updated)
      }
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
      await window.api.syncAgentToWorkspace({
        workspacePath,
        filename: agent.filename
      })
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
      await window.api.deleteAgentFromWorkspace({
        workspacePath,
        filename: deleteTarget.filename
      })
      // If we deleted the selected agent, deselect
      if (selectedAgent?.filename === deleteTarget.filename) {
        setSelectedAgent(null)
      }
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
        await window.api.deactivateAgent({
          workspacePath,
          agentName: agent.parsed.name
        })
      } else {
        await window.api.activateAgent({
          workspacePath,
          agentName: agent.parsed.name
        })
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

  const handleDeployAll = async (): Promise<void> => {
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
        <h4 className="text-sm font-medium text-text-secondary mb-2">
          No specialists deployed yet
        </h4>
        <p className="text-xs text-text-muted max-w-sm mb-4">
          Deploy the preset of specialist agents to this workspace. Each agent starts inactive —
          activate the ones you need for your project.
        </p>
        <button
          onClick={handleDeployAll}
          disabled={isDeploying}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary hover:bg-primary-hover text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isDeploying ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Deploying...
            </>
          ) : (
            <>
              <Rocket size={14} />
              Deploy Agents &amp; Skills
            </>
          )}
        </button>
      </div>
    )
  }

  return (
    <>
      <div className="flex h-full min-h-0">
        {/* Left: Agent list */}
        <div className="w-[280px] flex-shrink-0 border-r border-border-subtle overflow-y-auto">
          <div className="p-3">
            <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">
              Agents ({sortedAgents.length})
            </h3>
            <div className="space-y-1">
              {sortedAgents.map((agent) => {
                const meta = AGENT_META[agent.parsed.name]
                const icon = meta?.icon ?? '🤖'
                const displayName = meta?.displayName ?? agent.parsed.name
                const isSelected = selectedAgent?.filename === agent.filename
                const isSyncing = syncingIds.has(agent.filename)
                const isDeleting = deletingId === agent.filename
                const isToggling = togglingId === agent.filename

                return (
                  <div
                    key={agent.filename}
                    onClick={() => handleSelectAgent(agent)}
                    className={`group flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-primary-muted border border-primary/20'
                        : 'hover:bg-surface-overlay border border-transparent'
                    }`}
                  >
                    {/* Icon */}
                    <span className="text-base flex-shrink-0">{icon}</span>

                    {/* Name + status */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium text-text-primary truncate">
                          {displayName}
                        </span>
                        {/* Active indicator dot */}
                        <span
                          className={`w-2 h-2 rounded-full flex-shrink-0 ${
                            agent.isActive ? 'bg-green-400' : 'bg-gray-600'
                          }`}
                          title={agent.isActive ? 'Active' : 'Inactive'}
                        />
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span
                          className={`text-xs ${
                            agent.isDeployed ? 'text-green-500' : 'text-text-muted'
                          }`}
                        >
                          {agent.isDeployed ? 'Deployed' : 'Not deployed'}
                        </span>
                      </div>
                    </div>

                    {/* Inline actions */}
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      {/* Sync */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleSync(agent)
                        }}
                        disabled={isSyncing}
                        className="p-1 rounded hover:bg-primary-muted text-text-muted hover:text-primary-text transition-colors disabled:opacity-50"
                        title="Sync agent to workspace"
                      >
                        {isSyncing ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <RefreshCw size={12} />
                        )}
                      </button>

                      {/* Activate/Deactivate */}
                      {agent.isDeployed && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleActivateToggle(agent)
                          }}
                          disabled={isToggling}
                          className={`p-1 rounded transition-colors disabled:opacity-50 ${
                            agent.isActive
                              ? 'hover:bg-warning-muted text-green-400 hover:text-amber-400'
                              : 'hover:bg-success-muted text-text-muted hover:text-green-400'
                          }`}
                          title={agent.isActive ? 'Deactivate' : 'Activate'}
                        >
                          {isToggling ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : agent.isActive ? (
                            <PowerOff size={12} />
                          ) : (
                            <Power size={12} />
                          )}
                        </button>
                      )}

                      {/* Delete */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setDeleteTarget(agent)
                        }}
                        disabled={isDeleting}
                        className="p-1 rounded hover:bg-danger-muted text-text-muted hover:text-red-400 transition-colors disabled:opacity-50"
                        title="Delete agent from workspace"
                      >
                        {isDeleting ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Trash2 size={12} />
                        )}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* Right: Detail panel */}
        <div className="flex-1 overflow-y-auto">
          {selectedAgent ? (
            <div className="p-4 space-y-4">
              {/* Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">
                    {AGENT_META[selectedAgent.parsed.name]?.icon ?? '🤖'}
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary">
                      {AGENT_META[selectedAgent.parsed.name]?.displayName ??
                        selectedAgent.parsed.name}
                    </h3>
                    {selectedAgent.parsed.description && (
                      <p className="text-xs text-text-secondary mt-0.5">
                        {selectedAgent.parsed.description}
                      </p>
                    )}
                  </div>
                </div>

                {/* Activate/Deactivate button */}
                {selectedAgent.isDeployed && (
                  <button
                    onClick={() => handleActivateToggle(selectedAgent)}
                    disabled={togglingId === selectedAgent.filename}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
                      selectedAgent.isActive
                        ? 'bg-warning-muted text-amber-400 border border-amber-500/30 hover:bg-amber-500/20'
                        : 'bg-success-muted text-green-400 border border-green-500/30 hover:bg-green-500/20'
                    }`}
                  >
                    {togglingId === selectedAgent.filename ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : selectedAgent.isActive ? (
                      <PowerOff size={12} />
                    ) : (
                      <Power size={12} />
                    )}
                    {selectedAgent.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                )}
              </div>

              {/* Config info */}
              <div className="grid grid-cols-2 gap-3">
                {/* Model */}
                <div className="bg-surface-overlay rounded-lg p-3 border border-border-subtle">
                  <label className="text-xs text-text-muted uppercase tracking-wider font-medium">
                    Model
                  </label>
                  <p className="text-sm text-text-primary mt-1">{selectedAgent.parsed.model}</p>
                </div>

                {/* Status */}
                <div className="bg-surface-overlay rounded-lg p-3 border border-border-subtle">
                  <label className="text-xs text-text-muted uppercase tracking-wider font-medium">
                    Status
                  </label>
                  <div className="flex items-center gap-2 mt-1">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        selectedAgent.isActive ? 'bg-green-400' : 'bg-gray-600'
                      }`}
                    />
                    <span
                      className={`text-sm ${
                        selectedAgent.isActive ? 'text-green-400' : 'text-text-secondary'
                      }`}
                    >
                      {selectedAgent.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Tools */}
              {selectedAgent.parsed.tools.length > 0 && (
                <div className="bg-surface-overlay rounded-lg p-3 border border-border-subtle">
                  <label className="text-xs text-text-muted uppercase tracking-wider font-medium">
                    Tools
                  </label>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {selectedAgent.parsed.tools.map((tool) => (
                      <span
                        key={tool}
                        className="px-2 py-0.5 text-xs rounded-md bg-surface-float text-text-body font-mono"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Skills */}
              {selectedAgent.parsed.skills.length > 0 && (
                <div className="bg-surface-overlay rounded-lg p-3 border border-border-subtle">
                  <label className="text-xs text-text-muted uppercase tracking-wider font-medium">
                    Skills
                  </label>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {selectedAgent.parsed.skills.map((skill) => (
                      <span
                        key={skill}
                        className="px-2 py-0.5 text-xs rounded-md bg-primary-muted text-primary-text font-medium"
                      >
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* YAML Editor */}
              {selectedAgent.isDeployed && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-text-muted uppercase tracking-wider font-medium">
                      Agent YAML
                    </label>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-muted font-mono truncate max-w-[200px]">
                        {selectedAgent.filePath}
                      </span>
                      <button
                        onClick={handleSaveYaml}
                        disabled={!hasEditorChanges || isSaving}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                          hasEditorChanges
                            ? 'bg-primary hover:bg-primary-hover text-white'
                            : 'bg-surface-overlay text-text-muted cursor-not-allowed'
                        }`}
                      >
                        {isSaving ? (
                          <>
                            <Loader2 size={12} className="animate-spin" />
                            Saving...
                          </>
                        ) : (
                          <>
                            <Save size={12} />
                            Save
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                  <CodeEditor
                    value={editorContent}
                    onChange={handleEditorChange}
                    language="yaml"
                    className="min-h-[300px] max-h-[500px]"
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full py-16 text-center">
              <Bot size={24} className="text-border-default mb-2" />
              <p className="text-sm text-text-secondary">Select an agent to view details</p>
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation */}
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
