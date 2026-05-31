import { Bot, Loader2, Save, Power, PowerOff } from 'lucide-react'
import { useSpecialistStore } from '@renderer/store'
import { getAgentMeta } from '@renderer/utils/agentMeta'
import CodeEditor from './CodeEditor'
import type { DiscoveredAgent } from '../../../../shared/types'

interface AgentDetailPanelProps {
  selectedAgent: DiscoveredAgent | null
  togglingId: string | null
  editorContent: string
  hasEditorChanges: boolean
  isSaving: boolean
  onActivateToggle: (agent: DiscoveredAgent) => void
  onEditorChange: (value: string) => void
  onSaveYaml: () => void
}

export default function AgentDetailPanel({
  selectedAgent,
  togglingId,
  editorContent,
  hasEditorChanges,
  isSaving,
  onActivateToggle,
  onEditorChange,
  onSaveYaml
}: AgentDetailPanelProps): React.JSX.Element {
  const { specialists } = useSpecialistStore()

  if (!selectedAgent) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center h-full py-16 text-center">
        <Bot size={24} className="text-border-default mb-2" />
        <p className="text-sm text-text-secondary">Select an agent to view details</p>
      </div>
    )
  }

  const meta = getAgentMeta(selectedAgent.parsed.name, specialists)

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xl">{meta?.icon ?? '🤖'}</span>
            <div>
              <h3 className="text-sm font-semibold text-text-primary">
                {meta?.displayName ?? selectedAgent.parsed.name}
              </h3>
              {selectedAgent.parsed.description && (
                <p className="text-xs text-text-secondary mt-0.5">
                  {selectedAgent.parsed.description}
                </p>
              )}
            </div>
          </div>

          {selectedAgent.isDeployed && (
            <button
              onClick={() => onActivateToggle(selectedAgent)}
              disabled={togglingId === selectedAgent.filename}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
                selectedAgent.isActive
                  ? 'bg-warning-muted text-mode-build-text border border-mode-build/30 hover:bg-mode-build-muted'
                  : 'bg-success-muted text-success border border-success/30 hover:bg-success-muted'
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
          <div className="bg-surface-overlay rounded-lg p-3 border border-border-subtle">
            <label className="text-xs text-text-muted uppercase tracking-wider font-medium">
              Model
            </label>
            <p className="text-sm text-text-primary mt-1">{selectedAgent.parsed.model}</p>
          </div>

          <div className="bg-surface-overlay rounded-lg p-3 border border-border-subtle">
            <label className="text-xs text-text-muted uppercase tracking-wider font-medium">
              Status
            </label>
            <div className="flex items-center gap-2 mt-1">
              <span
                className={`w-2 h-2 rounded-full ${
                  selectedAgent.isActive ? 'bg-success' : 'bg-surface-overlay'
                }`}
              />
              <span
                className={`text-sm ${
                  selectedAgent.isActive ? 'text-success' : 'text-text-secondary'
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
                  onClick={onSaveYaml}
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
              onChange={onEditorChange}
              language="yaml"
              className="min-h-[300px] max-h-[500px]"
            />
          </div>
        )}
      </div>
    </div>
  )
}
