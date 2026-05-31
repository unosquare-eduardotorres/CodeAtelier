import {
  RefreshCw,
  Trash2,
  Loader2,
  Save,
  Power,
  PowerOff,
  ChevronDown,
  ChevronRight,
  X
} from 'lucide-react'
import { useSpecialistStore } from '@renderer/store'
import { getAgentMeta } from '@renderer/utils/agentMeta'
import type { DiscoveredAgent } from '../../../../../shared/types'
import CodeEditor from '../CodeEditor'

export interface AgentDetailPanelProps {
  agent: DiscoveredAgent
  togglingId: string | null
  syncingAgentIds: Set<string>
  deletingAgentId: string | null
  yamlOpen: boolean
  setYamlOpen: (open: boolean) => void
  editorContent: string
  hasEditorChanges: boolean
  isSaving: boolean
  onActivateToggle: (agent: DiscoveredAgent) => void
  onSyncAgent: (agent: DiscoveredAgent) => void
  onSaveYaml: (agent: DiscoveredAgent) => void
  onEditorChange: (value: string) => void
  onDeleteAgent: (agent: DiscoveredAgent) => void
  onClose: () => void
  onSkillClick: (skillName: string) => void
}

export default function AgentDetailPanel({
  agent,
  togglingId,
  syncingAgentIds,
  deletingAgentId,
  yamlOpen,
  setYamlOpen,
  editorContent,
  hasEditorChanges,
  isSaving,
  onActivateToggle,
  onSyncAgent,
  onSaveYaml,
  onEditorChange,
  onDeleteAgent,
  onClose,
  onSkillClick
}: AgentDetailPanelProps): React.JSX.Element {
  const { specialists } = useSpecialistStore()
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
              <p className="text-xs text-text-secondary mt-0.5">{agent.parsed.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {agent.isDeployed && (
            <button
              onClick={() => onActivateToggle(agent)}
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
            onClick={onClose}
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
              className={`w-2 h-2 rounded-full ${agent.isActive ? 'bg-success' : 'bg-surface-overlay'}`}
            />
            <span className={`text-sm ${agent.isActive ? 'text-success' : 'text-text-secondary'}`}>
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
                onClick={() => onSkillClick(skill)}
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
                  onClick={() => onSaveYaml(agent)}
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
                onChange={onEditorChange}
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
          onClick={() => onSyncAgent(agent)}
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
          onClick={() => onDeleteAgent(agent)}
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
}
