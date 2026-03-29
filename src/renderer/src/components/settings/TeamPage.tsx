import { useState, useCallback, useRef, useMemo } from 'react'
import {
  Bot,
  RefreshCw,
  Trash2,
  Loader2,
  Rocket,
  Save,
  Power,
  PowerOff,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  AlertTriangle,
  X,
  Upload,
  Sparkles
} from 'lucide-react'
import { useSettingsStore } from '@renderer/store/settings.store'
import { ConfirmDialog } from '@renderer/components/common'
import CodeEditor from './CodeEditor'
import SkillImportDropzone from './SkillImportDropzone'
import { useSpecialistStore } from '@renderer/store'
import { getAgentMeta } from '@renderer/utils/agentMeta'
import type { DiscoveredAgent, DiscoveredSkill } from '../../../../shared/types'

// ── Helpers ──

function isStale(lastUpdated: string | null): boolean {
  if (!lastUpdated) return false
  const date = new Date(lastUpdated)
  const sixMonthsAgo = new Date()
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
  return date < sixMonthsAgo
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'Unknown'
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  } catch {
    return dateStr
  }
}

/** Build a map: skillName → list of agent display names that reference it */
function buildSkillAgentMap(
  agents: DiscoveredAgent[],
  specialists: import('../../../../shared/types').Specialist[]
): Map<string, { name: string; icon: string }[]> {
  const map = new Map<string, { name: string; icon: string }[]>()
  for (const agent of agents) {
    const meta = getAgentMeta(agent.parsed.name, specialists)
    const displayName = meta?.displayName ?? agent.parsed.name
    const icon = meta?.icon ?? '🤖'
    for (const skillName of agent.parsed.skills) {
      const list = map.get(skillName) ?? []
      list.push({ name: displayName, icon })
      map.set(skillName, list)
    }
  }
  return map
}

// ── Props ──

interface TeamPageProps {
  workspacePath: string
}

// ── Component ──

export default function TeamPage({ workspacePath }: TeamPageProps): React.JSX.Element {
  const {
    agents,
    skills,
    loadAgents,
    loadSkills,
    selectSkill,
    deployAll
  } = useSettingsStore()
  const { specialists } = useSpecialistStore()

  // Agent interaction state
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null)
  const [syncingAgentIds, setSyncingAgentIds] = useState<Set<string>>(new Set())
  const [deleteAgentTarget, setDeleteAgentTarget] = useState<DiscoveredAgent | null>(null)
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [isDeploying, setIsDeploying] = useState(false)

  // YAML editor state
  const [editorContent, setEditorContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [hasEditorChanges, setHasEditorChanges] = useState(false)
  const [initialContent, setInitialContent] = useState('')
  const [yamlOpen, setYamlOpen] = useState(false)

  // Skill interaction state
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null)
  const [syncingSkillIds, setSyncingSkillIds] = useState<Set<string>>(new Set())
  const [deleteSkillTarget, setDeleteSkillTarget] = useState<DiscoveredSkill | null>(null)
  const [deletingSkillId, setDeletingSkillId] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)

  // Scroll refs
  const skillsStripRef = useRef<HTMLDivElement>(null)
  const agentCardsRef = useRef<Map<string, HTMLDivElement>>(new Map())

  // Derived data
  const skillAgentMap = useMemo(() => buildSkillAgentMap(agents, specialists), [agents, specialists])

  // Sort agents: active first, then by name
  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
      if (a.isDeployed !== b.isDeployed) return a.isDeployed ? -1 : 1
      return a.parsed.name.localeCompare(b.parsed.name)
    })
  }, [agents])

  // Sort skills: active first, then by name
  const sortedSkills = useMemo(() => {
    return [...skills].sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [skills])

  const activeAgents = useMemo(() => sortedAgents.filter((a) => a.isActive), [sortedAgents])
  const inactiveAgents = useMemo(() => sortedAgents.filter((a) => !a.isActive), [sortedAgents])

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

  const handleDeployAll = async (): Promise<void> => {
    setIsDeploying(true)
    try {
      await deployAll(workspacePath)
    } finally {
      setIsDeploying(false)
    }
  }

  // ── Skill handlers ──

  const handleSyncSkill = async (skill: DiscoveredSkill): Promise<void> => {
    const id = skill.name
    setSyncingSkillIds((prev) => new Set(prev).add(id))
    try {
      await window.api.syncSkillToWorkspace({ workspacePath, skillName: skill.name })
      await loadSkills(workspacePath)
    } catch (error) {
      console.error('Failed to sync skill:', error)
    } finally {
      setSyncingSkillIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const handleDeleteSkillConfirm = async (): Promise<void> => {
    if (!deleteSkillTarget) return
    setDeletingSkillId(deleteSkillTarget.name)
    try {
      await window.api.deleteSkillFromWorkspace({
        workspacePath,
        skillName: deleteSkillTarget.name
      })
      if (expandedSkill === deleteSkillTarget.name) {
        setExpandedSkill(null)
      }
      await loadSkills(workspacePath)
    } catch (error) {
      console.error('Failed to delete skill:', error)
    } finally {
      setDeleteSkillTarget(null)
      setDeletingSkillId(null)
    }
  }

  // ── Cross-navigation ──

  const scrollToSkill = (skillName: string): void => {
    setExpandedSkill(skillName)
    // Scroll skills strip into view
    setTimeout(() => {
      const el = document.getElementById(`skill-tag-${skillName}`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 100)
  }

  const scrollToAgent = (agentName: string): void => {
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
  }

  // ── Empty state: no agents deployed at all ──

  if (sortedAgents.length === 0 && sortedSkills.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-10">
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-2xl bg-primary-muted flex items-center justify-center mb-4">
              <Rocket size={28} className="text-primary-text" />
            </div>
            <h3 className="text-base font-semibold text-text-primary mb-2">Get Started</h3>
            <p className="text-sm text-text-secondary max-w-md mb-6">
              Deploy specialist agents and skills to this workspace. Each starts inactive —
              activate the ones you need for your project.
            </p>
            <button
              onClick={handleDeployAll}
              disabled={isDeploying}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary hover:bg-primary-hover text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-primary/50"
              aria-label="Deploy specialist agents and skills"
            >
              {isDeploying ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Deploying...
                </>
              ) : (
                <>
                  <Rocket size={16} />
                  Deploy Team
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Main layout ──

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-8">
        {/* ────────────────────────────────────────────────────────
            Section A: Agents Grid
           ──────────────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Bot size={16} className="text-info" />
              <h3 className="text-sm font-semibold text-text-primary">
                Agents ({sortedAgents.length})
              </h3>
            </div>
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
                    onSkillClick={scrollToSkill}
                    ref={(el) => {
                      if (el) agentCardsRef.current.set(agent.filename, el)
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Divider between active and inactive */}
          {activeAgents.length > 0 && inactiveAgents.length > 0 && (
            <div className="border-t border-border-subtle my-4" />
          )}

          {/* Inactive agents */}
          {inactiveAgents.length > 0 && (
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
                    onSkillClick={scrollToSkill}
                    ref={(el) => {
                      if (el) agentCardsRef.current.set(agent.filename, el)
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Agent detail — inline expand */}
          {expandedAgent && (() => {
            const agent = agents.find((a) => a.filename === expandedAgent)
            if (!agent) return null
            const meta = getAgentMeta(agent.parsed.name, specialists)
            const displayName = meta?.displayName ?? agent.parsed.name
            const icon = meta?.icon ?? '🤖'

            return (
              <div className="mt-4 bg-surface-overlay border border-border-subtle rounded p-5 space-y-4 animate-in fade-in duration-200">
                {/* Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-xl">{icon}</span>
                    <div>
                      <h4 className="text-sm font-semibold text-text-primary">{displayName}</h4>
                      {agent.parsed.description && (
                        <p className="text-xs text-text-secondary mt-0.5">
                          {agent.parsed.description}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {agent.isDeployed && (
                      <button
                        onClick={() => handleActivateToggle(agent)}
                        disabled={togglingId === agent.filename}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
                          agent.isActive
                            ? 'bg-warning-muted text-mode-build-text border border-mode-build/30 hover:bg-mode-build-muted'
                            : 'bg-success-muted text-success border border-success/30 hover:bg-success-muted'
                        }`}
                        aria-label={agent.isActive ? 'Deactivate agent' : 'Activate agent'}
                      >
                        {togglingId === agent.filename ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : agent.isActive ? (
                          <PowerOff size={12} />
                        ) : (
                          <Power size={12} />
                        )}
                        {agent.isActive ? 'Deactivate' : 'Activate'}
                      </button>
                    )}
                    <button
                      onClick={() => setExpandedAgent(null)}
                      className="p-1 rounded-md hover:bg-surface-float text-text-secondary hover:text-text-primary transition-colors"
                      aria-label="Close agent detail"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>

                {/* Info grid */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-surface-float rounded-lg p-3 border border-border-subtle">
                    <label className="text-xs text-text-muted uppercase tracking-wider font-medium">
                      Model
                    </label>
                    <p className="text-sm text-text-primary mt-1">{agent.parsed.model}</p>
                  </div>
                  <div className="bg-surface-float rounded-lg p-3 border border-border-subtle">
                    <label className="text-xs text-text-muted uppercase tracking-wider font-medium">
                      Status
                    </label>
                    <div className="flex items-center gap-2 mt-1">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          agent.isActive ? 'bg-success' : 'bg-surface-overlay'
                        }`}
                      />
                      <span
                        className={`text-sm ${
                          agent.isActive ? 'text-success' : 'text-text-secondary'
                        }`}
                      >
                        {agent.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Tools */}
                {agent.parsed.tools.length > 0 && (
                  <div className="bg-surface-float rounded-lg p-3 border border-border-subtle">
                    <label className="text-xs text-text-muted uppercase tracking-wider font-medium">
                      Tools
                    </label>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {agent.parsed.tools.map((tool) => (
                        <span
                          key={tool}
                          className="px-2 py-0.5 text-xs rounded-md bg-surface-overlay text-text-body font-mono"
                        >
                          {tool}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Skills with clickable links */}
                {agent.parsed.skills.length > 0 && (
                  <div className="bg-surface-float rounded-lg p-3 border border-border-subtle">
                    <label className="text-xs text-text-muted uppercase tracking-wider font-medium">
                      Skills
                    </label>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {agent.parsed.skills.map((skill) => (
                        <button
                          key={skill}
                          onClick={() => scrollToSkill(skill)}
                          className="px-2 py-0.5 text-xs rounded-md bg-primary-muted text-primary-text font-medium hover:bg-primary/20 transition-colors cursor-pointer"
                          aria-label={`View skill: ${skill}`}
                        >
                          {skill}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* YAML Editor accordion */}
                {agent.isDeployed && (
                  <div className="border border-border-subtle rounded-lg overflow-hidden">
                    <button
                      onClick={() => setYamlOpen(!yamlOpen)}
                      className="flex items-center justify-between w-full px-4 py-2.5 bg-surface-float hover:bg-surface-overlay transition-colors text-left"
                      aria-expanded={yamlOpen}
                      aria-label="Toggle YAML editor"
                    >
                      <span className="text-xs text-text-muted uppercase tracking-wider font-medium">
                        Agent YAML
                      </span>
                      {yamlOpen ? (
                        <ChevronDown size={14} className="text-text-muted" />
                      ) : (
                        <ChevronRight size={14} className="text-text-muted" />
                      )}
                    </button>
                    {yamlOpen && (
                      <div className="border-t border-border-subtle p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-text-muted font-mono truncate max-w-[250px]">
                            {agent.filePath}
                          </span>
                          <button
                            onClick={() => handleSaveYaml(agent)}
                            disabled={!hasEditorChanges || isSaving}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                              hasEditorChanges
                                ? 'bg-primary hover:bg-primary-hover text-white'
                                : 'bg-surface-overlay text-text-muted cursor-not-allowed'
                            }`}
                            aria-label="Save YAML changes"
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
                        <CodeEditor
                          value={editorContent}
                          onChange={handleEditorChange}
                          language="yaml"
                          className="min-h-[300px] max-h-[500px]"
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Actions row */}
                <div className="flex items-center gap-2 pt-2 border-t border-border-subtle">
                  <button
                    onClick={() => handleSyncAgent(agent)}
                    disabled={syncingAgentIds.has(agent.filename)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary border border-border-subtle hover:bg-surface-float transition-colors disabled:opacity-50"
                    aria-label="Sync agent from master"
                  >
                    {syncingAgentIds.has(agent.filename) ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <RefreshCw size={12} />
                    )}
                    Sync from master
                  </button>
                  <button
                    onClick={() => setDeleteAgentTarget(agent)}
                    disabled={deletingAgentId === agent.filename}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-danger border border-danger/30 hover:bg-danger-muted transition-colors disabled:opacity-50"
                    aria-label="Delete agent from workspace"
                  >
                    {deletingAgentId === agent.filename ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Trash2 size={12} />
                    )}
                    Delete from workspace
                  </button>
                </div>
              </div>
            )
          })()}
        </section>

        {/* ────────────────────────────────────────────────────────
            Section B: Skills Strip
           ──────────────────────────────────────────────────────── */}
        <section ref={skillsStripRef}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-mode-build-text" />
              <h3 className="text-sm font-semibold text-text-primary">
                Skills ({sortedSkills.length})
              </h3>
            </div>
            <button
              onClick={() => setShowImport(!showImport)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                showImport
                  ? 'bg-primary-muted text-primary-text'
                  : 'text-text-secondary border border-border-subtle hover:bg-surface-float'
              }`}
              aria-label={showImport ? 'Hide import area' : 'Import a skill'}
            >
              <Upload size={12} />
              Import Skill
            </button>
          </div>

          {/* Import dropzone — inline toggle */}
          {showImport && (
            <div className="mb-4">
              <SkillImportDropzone />
            </div>
          )}

          {/* Skill tags row */}
          {sortedSkills.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <p className="text-sm text-text-secondary mb-1">No skills found</p>
              <p className="text-xs text-text-muted">
                Deploy the team or import a skill file to get started
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Compact tag strip */}
              <div className="flex flex-wrap gap-2">
                {sortedSkills.map((skill) => {
                  const stale = isStale(skill.lastUpdated)
                  const agentCount = skillAgentMap.get(skill.name)?.length ?? 0
                  const isExpanded = expandedSkill === skill.name

                  return (
                    <button
                      key={skill.name}
                      id={`skill-tag-${skill.name}`}
                      onClick={() =>
                        setExpandedSkill(isExpanded ? null : skill.name)
                      }
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all min-h-[36px] ${
                        isExpanded
                          ? 'bg-primary-muted text-primary-text border border-primary/30 shadow-sm'
                          : 'bg-surface-overlay text-text-body border border-border-subtle hover:border-border-default hover:shadow-sm'
                      }`}
                      aria-label={`Skill: ${skill.name} (${agentCount} agent${agentCount !== 1 ? 's' : ''})`}
                      aria-expanded={isExpanded}
                    >
                      <FolderOpen size={12} className={isExpanded ? 'text-primary-text' : 'text-text-muted'} />
                      <span>{skill.name}</span>
                      {agentCount > 0 && (
                        <span className="text-text-muted">
                          ({agentCount})
                        </span>
                      )}
                      {stale && <AlertTriangle size={10} className="text-mode-build-text" />}
                      {!skill.isActive && (
                        <span className="w-1.5 h-1.5 rounded-full bg-surface-overlay" title="Not deployed" />
                      )}
                    </button>
                  )
                })}
              </div>

              {/* Expanded skill detail */}
              {expandedSkill && (() => {
                const skill = skills.find((s) => s.name === expandedSkill)
                if (!skill) return null
                const stale = isStale(skill.lastUpdated)
                const usedByAgents = skillAgentMap.get(skill.name) ?? []
                const isSyncing = syncingSkillIds.has(skill.name)
                const isDeleting = deletingSkillId === skill.name

                return (
                  <div className="bg-surface-overlay border border-border-subtle rounded p-5 space-y-3 animate-in fade-in duration-200">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary-muted text-primary-text flex-shrink-0 mt-0.5">
                          <FolderOpen size={16} />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h4 className="text-sm font-semibold text-text-primary">
                              {skill.name}
                            </h4>
                            <span
                              className={`px-1.5 py-0.5 text-xs rounded-full font-medium ${
                                skill.isActive
                                  ? 'bg-success-muted text-success'
                                  : 'bg-surface-float text-text-muted'
                              }`}
                            >
                              {skill.isActive ? 'Deployed' : 'Not deployed'}
                            </span>
                          </div>
                          {skill.frontmatter?.description && (
                            <p className="text-xs text-text-secondary mt-0.5">
                              {skill.frontmatter.description}
                            </p>
                          )}
                          <div className="flex items-center gap-3 mt-1.5">
                            <span className="text-xs text-text-muted">
                              {skill.hasSkillMd ? 'SKILL.md' : 'no SKILL.md'} +{' '}
                              {skill.referenceFiles.length} reference
                              {skill.referenceFiles.length !== 1 ? 's' : ''}
                            </span>
                            {skill.lastUpdated && (
                              <span className="text-xs text-text-muted">
                                Updated: {formatDate(skill.lastUpdated)}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <button
                          onClick={() => handleSyncSkill(skill)}
                          disabled={isSyncing}
                          className="p-1.5 rounded-md hover:bg-primary-muted text-text-secondary hover:text-primary-text transition-colors disabled:opacity-50"
                          aria-label={`Sync ${skill.name}`}
                          title="Sync skill to workspace"
                        >
                          {isSyncing ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <RefreshCw size={14} />
                          )}
                        </button>
                        <button
                          onClick={() => selectSkill(skill)}
                          className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-surface-float transition-colors"
                          aria-label={`View full details for ${skill.name}`}
                        >
                          View
                          <ChevronRight size={12} />
                        </button>
                        <button
                          onClick={() => setDeleteSkillTarget(skill)}
                          disabled={isDeleting}
                          className="p-1.5 rounded-md hover:bg-danger-muted text-text-muted hover:text-danger transition-colors disabled:opacity-50"
                          aria-label={`Delete ${skill.name}`}
                          title="Delete skill from workspace"
                        >
                          {isDeleting ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Trash2 size={14} />
                          )}
                        </button>
                        <button
                          onClick={() => setExpandedSkill(null)}
                          className="p-1 rounded-md hover:bg-surface-float text-text-secondary hover:text-text-primary transition-colors"
                          aria-label="Close skill detail"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>

                    {/* Staleness warning */}
                    {stale && (
                      <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-warning-muted border border-mode-build/20">
                        <AlertTriangle size={12} className="text-mode-build-text flex-shrink-0" />
                        <span className="text-xs text-mode-build-text">
                          This skill might require an update.
                        </span>
                      </div>
                    )}

                    {/* Used by agents */}
                    {usedByAgents.length > 0 && (
                      <div>
                        <label className="text-xs text-text-muted uppercase tracking-wider font-medium">
                          Used by
                        </label>
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          {usedByAgents.map((a) => (
                            <button
                              key={a.name}
                              onClick={() => scrollToAgent(a.name)}
                              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-surface-float text-text-body hover:bg-surface-overlay hover:text-text-primary transition-colors cursor-pointer"
                              aria-label={`Navigate to agent: ${a.name}`}
                            >
                              <span>{a.icon}</span>
                              <span>{a.name}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {usedByAgents.length === 0 && (
                      <p className="text-xs text-text-muted italic">
                        No agents currently reference this skill
                      </p>
                    )}
                  </div>
                )
              })()}
            </div>
          )}
        </section>
      </div>

      {/* ── Confirmation dialogs ── */}
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

      <ConfirmDialog
        isOpen={deleteSkillTarget !== null}
        title="Delete Skill"
        message={`Remove "${deleteSkillTarget?.name ?? ''}" from this workspace? This will delete the skill directory from .claude/skills/ and remove references from CLAUDE.md.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleDeleteSkillConfirm}
        onCancel={() => setDeleteSkillTarget(null)}
      />
    </div>
  )
}

// ── Agent Card Sub-component ──

import { forwardRef } from 'react'

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
  { agent, isExpanded, isSyncing, isDeleting, isToggling, onExpand, onSync, onDelete, onToggle, onSkillClick },
  ref
) {
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
            <span
              className={`text-xs ${agent.isDeployed ? 'text-success' : 'text-text-muted'}`}
            >
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
          {isSyncing ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <RefreshCw size={12} />
          )}
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
          {isDeleting ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Trash2 size={12} />
          )}
        </button>
      </div>
    </div>
  )
})
