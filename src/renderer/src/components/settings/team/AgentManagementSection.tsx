/**
 * AgentManagementSection — agent grid, expand/collapse, sync, delete, toggle,
 * YAML editing, and auto-activate. Extracted from TeamPage for decomposition.
 */

import { useState, useCallback, useRef, forwardRef, useImperativeHandle } from 'react'
import {
  Bot,
  RefreshCw,
  Trash2,
  Loader2,
  Power,
  PowerOff,
  Sparkles
} from 'lucide-react'
import { useSettingsStore } from '@renderer/store/settings.store'
import { ConfirmDialog } from '@renderer/components/common'
import { useSpecialistStore } from '@renderer/store'
import { getAgentMeta } from '@renderer/utils/agentMeta'
import type { DiscoveredAgent } from '../../../../../shared/types'
import AgentDetailPanel from './AgentDetailPanel'

// ── Types ──

export interface AgentManagementSectionProps {
  workspacePath: string
  activeAgents: DiscoveredAgent[]
  inactiveAgents: DiscoveredAgent[]
  agents: DiscoveredAgent[]
  onSkillClick: (skillName: string) => void
}

export interface AgentManagementHandle {
  scrollToAgent: (agentName: string) => void
}

// ── Component ──

const AgentManagementSection = forwardRef<AgentManagementHandle, AgentManagementSectionProps>(
  function AgentManagementSection(
    { workspacePath, activeAgents, inactiveAgents, agents, onSkillClick },
    ref
  ) {
  const { loadAgents, deployAll } = useSettingsStore()
  const { specialists } = useSpecialistStore()

  // Agent interaction state
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null)
  const [syncingAgentIds, setSyncingAgentIds] = useState<Set<string>>(new Set())
  const [deleteAgentTarget, setDeleteAgentTarget] = useState<DiscoveredAgent | null>(null)
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [isDeploying, setIsDeploying] = useState(false)
  const [showInactive, setShowInactive] = useState(false)

  // YAML editor state
  const [editorContent, setEditorContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [hasEditorChanges, setHasEditorChanges] = useState(false)
  const [initialContent, setInitialContent] = useState('')
  const [yamlOpen, setYamlOpen] = useState(false)

  // Scroll refs for cross-navigation
  const agentCardsRef = useRef<Map<string, HTMLDivElement>>(new Map())

  // ── Agent YAML loading ──

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

  // ── Agent handlers ──

  const handleExpandAgent = (agent: DiscoveredAgent): void => {
    const key = agent.filename
    if (expandedAgent === key) {
      setExpandedAgent(null)
      setYamlOpen(false)
    } else {
      setExpandedAgent(key)
      setYamlOpen(false)
      loadAgentContent(agent)
    }
  }

  const handleSyncAgent = async (agent: DiscoveredAgent): Promise<void> => {
    const id = agent.filename
    setSyncingAgentIds((prev) => new Set(prev).add(id))
    try {
      await window.api.syncAgentToWorkspace({ workspacePath, filename: agent.filename })
      await loadAgents(workspacePath)
    } catch (error) {
      console.error('Failed to sync agent:', error)
    } finally {
      setSyncingAgentIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const handleDeleteAgentConfirm = async (): Promise<void> => {
    if (!deleteAgentTarget) return
    setDeletingAgentId(deleteAgentTarget.filename)
    try {
      await window.api.deleteAgentFromWorkspace({
        workspacePath,
        filename: deleteAgentTarget.filename
      })
      if (expandedAgent === deleteAgentTarget.filename) {
        setExpandedAgent(null)
      }
      await loadAgents(workspacePath)
    } catch (error) {
      console.error('Failed to delete agent:', error)
    } finally {
      setDeleteAgentTarget(null)
      setDeletingAgentId(null)
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

  const handleSaveYaml = async (agent: DiscoveredAgent): Promise<void> => {
    if (!hasEditorChanges) return
    setIsSaving(true)
    try {
      await window.api.writeWorkspaceFile({ filePath: agent.filePath, content: editorContent })
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

  /** Navigate to a specific agent (used by SkillManagementSection cross-nav) */
  const scrollToAgentByName = useCallback(
    (agentName: string): void => {
      const agent = agents.find((a) => {
        const meta = getAgentMeta(a.parsed.name, specialists)
        return (meta?.displayName ?? a.parsed.name) === agentName
      })
      if (agent) {
        setExpandedAgent(agent.filename)
        loadAgentContent(agent)
        setTimeout(() => {
          const el = agentCardsRef.current.get(agent.filename)
          el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }, 100)
      }
    },
    [agents, specialists, loadAgentContent]
  )

  // Expose scrollToAgent to parent for cross-section navigation
  useImperativeHandle(ref, () => ({ scrollToAgent: scrollToAgentByName }), [scrollToAgentByName])

  return (
    <>
      <section>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Bot size={16} className="text-info" />
            <h3 className="text-sm font-semibold text-text-primary">
              Agents ({activeAgents.length} active)
            </h3>
          </div>
          {inactiveAgents.length > 0 && (
            <button
              onClick={() => setShowInactive(!showInactive)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary border border-border-subtle hover:bg-surface-float transition-colors"
            >
              {showInactive ? 'Hide' : 'Show'} inactive ({inactiveAgents.length})
            </button>
          )}
        </div>

        {/* Active agents */}
        {activeAgents.length > 0 && (
          <div className="mb-4">
            <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">
              Active
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {activeAgents.map((agent) => (
                <AgentCard
                  key={agent.filename}
                  agent={agent}
                  isExpanded={expandedAgent === agent.filename}
                  isSyncing={syncingAgentIds.has(agent.filename)}
                  isDeleting={deletingAgentId === agent.filename}
                  isToggling={togglingId === agent.filename}
                  onExpand={() => handleExpandAgent(agent)}
                  onSync={() => handleSyncAgent(agent)}
                  onDelete={() => setDeleteAgentTarget(agent)}
                  onToggle={() => handleActivateToggle(agent)}
                  onSkillClick={onSkillClick}
                  ref={(el) => {
                    if (el) agentCardsRef.current.set(agent.filename, el)
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Divider between active and inactive */}
        {showInactive && activeAgents.length > 0 && inactiveAgents.length > 0 && (
          <div className="border-t border-border-subtle my-4" />
        )}

        {/* Inactive agents — only when toggled */}
        {showInactive && inactiveAgents.length > 0 && (
          <div>
            <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">
              Inactive
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {inactiveAgents.map((agent) => (
                <AgentCard
                  key={agent.filename}
                  agent={agent}
                  isExpanded={expandedAgent === agent.filename}
                  isSyncing={syncingAgentIds.has(agent.filename)}
                  isDeleting={deletingAgentId === agent.filename}
                  isToggling={togglingId === agent.filename}
                  onExpand={() => handleExpandAgent(agent)}
                  onSync={() => handleSyncAgent(agent)}
                  onDelete={() => setDeleteAgentTarget(agent)}
                  onToggle={() => handleActivateToggle(agent)}
                  onSkillClick={onSkillClick}
                  ref={(el) => {
                    if (el) agentCardsRef.current.set(agent.filename, el)
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Agent detail — inline expand */}
        {expandedAgent &&
          (() => {
            const agent = agents.find((a) => a.filename === expandedAgent)
            if (!agent) return null
            return (
              <AgentDetailPanel
                agent={agent}
                togglingId={togglingId}
                syncingAgentIds={syncingAgentIds}
                deletingAgentId={deletingAgentId}
                yamlOpen={yamlOpen}
                setYamlOpen={setYamlOpen}
                editorContent={editorContent}
                hasEditorChanges={hasEditorChanges}
                isSaving={isSaving}
                onActivateToggle={handleActivateToggle}
                onSyncAgent={handleSyncAgent}
                onSaveYaml={handleSaveYaml}
                onEditorChange={handleEditorChange}
                onDeleteAgent={setDeleteAgentTarget}
                onClose={() => setExpandedAgent(null)}
                onSkillClick={onSkillClick}
              />
            )
          })()}
      </section>

      {/* Delete agent confirmation */}
      <ConfirmDialog
        isOpen={deleteAgentTarget !== null}
        title="Delete Agent"
        message={`Remove "${deleteAgentTarget?.parsed.name ?? ''}" from this workspace? This will delete the agent YAML from .claude/agents/ and remove references from CLAUDE.md.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleDeleteAgentConfirm}
        onCancel={() => setDeleteAgentTarget(null)}
      />
    </>
  )
  }
)

export default AgentManagementSection

// ── Agent Card Sub-component ──

interface AgentCardProps {
  agent: DiscoveredAgent
  isExpanded: boolean
  isSyncing: boolean
  isDeleting: boolean
  isToggling: boolean
  onExpand: () => void
  onSync: () => void
  onDelete: () => void
  onToggle: () => void
  onSkillClick: (skillName: string) => void
}

const AgentCard = forwardRef<HTMLDivElement, AgentCardProps>(function AgentCard(
  {
    agent,
    isExpanded,
    isSyncing,
    isDeleting,
    isToggling,
    onExpand,
    onSync,
    onDelete,
    onToggle,
    onSkillClick
  },
  ref
) {
  const { specialists } = useSpecialistStore()
  const meta = getAgentMeta(agent.parsed.name, specialists)
  const icon = meta?.icon ?? '🤖'
  const displayName = meta?.displayName ?? agent.parsed.name
  const color = meta?.color ?? '#6366F1'

  // Model abbreviation
  const modelAbbrev = agent.parsed.model?.includes('opus')
    ? 'O'
    : agent.parsed.model?.includes('sonnet')
      ? 'S'
      : agent.parsed.model?.includes('haiku')
        ? 'H'
        : '?'

  return (
    <div
      ref={ref}
      onClick={onExpand}
      className={`group relative bg-surface-overlay border rounded p-3.5 cursor-pointer transition-all duration-200 min-h-[88px] ${
        isExpanded
          ? 'border-primary/30 shadow-md ring-1 ring-primary/10'
          : 'border-border-subtle hover:border-border-default hover:shadow-md'
      } ${!agent.isActive ? 'opacity-70' : ''}`}
      style={{ borderLeftWidth: '3px', borderLeftColor: agent.isActive ? color : 'transparent' }}
      role="button"
      tabIndex={0}
      aria-expanded={isExpanded}
      aria-label={`${displayName} — ${agent.isActive ? 'Active' : 'Inactive'}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onExpand()
        }
      }}
    >
      {/* Top row: icon + name + status + model */}
      <div className="flex items-center gap-2.5">
        <span className="text-lg flex-shrink-0">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-text-primary truncate">{displayName}</span>
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 ${
                agent.isActive ? 'bg-success' : 'bg-surface-overlay'
              }`}
              title={agent.isActive ? 'Active' : 'Inactive'}
            />
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`text-xs ${agent.isDeployed ? 'text-success' : 'text-text-muted'}`}>
              {agent.isDeployed ? 'Deployed' : 'Not deployed'}
            </span>
          </div>
        </div>
        {/* Model badge */}
        <span
          className="flex items-center justify-center w-6 h-6 rounded-md bg-surface-float text-xs font-bold text-text-secondary flex-shrink-0"
          title={agent.parsed.model}
        >
          {modelAbbrev}
        </span>
      </div>

      {/* Skill chips */}
      {agent.parsed.skills.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2.5">
          {agent.parsed.skills.map((skill) => (
            <button
              key={skill}
              onClick={(e) => {
                e.stopPropagation()
                onSkillClick(skill)
              }}
              className="px-1.5 py-0.5 text-[10px] rounded bg-primary-muted text-primary-text font-medium hover:bg-primary/20 transition-colors leading-tight"
              aria-label={`View skill: ${skill}`}
            >
              {skill}
            </button>
          ))}
        </div>
      )}

      {/* Hover actions (top-right) */}
      <div className="absolute top-2 right-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {agent.isDeployed && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
            disabled={isToggling}
            className={`p-1 rounded transition-colors disabled:opacity-50 ${
              agent.isActive
                ? 'hover:bg-warning-muted text-success hover:text-mode-build-text'
                : 'hover:bg-success-muted text-text-muted hover:text-success'
            }`}
            title={agent.isActive ? 'Deactivate' : 'Activate'}
            aria-label={agent.isActive ? 'Deactivate agent' : 'Activate agent'}
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
        <button
          onClick={(e) => {
            e.stopPropagation()
            onSync()
          }}
          disabled={isSyncing}
          className="p-1 rounded hover:bg-primary-muted text-text-muted hover:text-primary-text transition-colors disabled:opacity-50"
          title="Sync agent"
          aria-label="Sync agent to workspace"
        >
          {isSyncing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          disabled={isDeleting}
          className="p-1 rounded hover:bg-danger-muted text-text-muted hover:text-danger transition-colors disabled:opacity-50"
          title="Delete agent"
          aria-label="Delete agent from workspace"
        >
          {isDeleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
        </button>
      </div>
    </div>
  )
})
