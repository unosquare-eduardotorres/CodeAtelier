import { useState, useEffect } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { useSettingsStore } from '@renderer/store/settings.store'
import { useSpecialistStore } from '@renderer/store'
import { getAgentMeta } from '@renderer/utils/agentMeta'
import AgentYamlEditor from './AgentYamlEditor'
import type { DiscoveredAgent, DiscoveredSkill } from '../../../../shared/types'

interface AgentDetailPageProps {
  agent: DiscoveredAgent
  workspacePath: string
  onBack: () => void
}

export default function AgentDetailPage({
  agent,
  workspacePath,
  onBack
}: AgentDetailPageProps): React.JSX.Element {
  const { skills, readFile, saveFile, activeFileContent, isFileLoading } = useSettingsStore()
  const { specialists } = useSpecialistStore()
  const [localSkills, setLocalSkills] = useState<string[]>(agent.parsed.skills)

  const meta = getAgentMeta(agent.parsed.name, specialists)
  const icon = meta.icon
  const color = meta.color
  const displayName = meta.displayName

  // Load file content on mount
  useEffect(() => {
    if (agent.isDeployed) {
      const deployedPath = `${workspacePath}/.claude/agents/${agent.filename}`
      readFile(deployedPath)
    } else {
      readFile(agent.filePath)
    }
  }, [agent, workspacePath, readFile])

  const handleSave = async (content: string): Promise<void> => {
    const targetPath = agent.isDeployed
      ? `${workspacePath}/.claude/agents/${agent.filename}`
      : agent.filePath
    await saveFile(targetPath, content)
  }

  const handleSkillToggle = (skillName: string): void => {
    setLocalSkills((prev) => {
      if (prev.includes(skillName)) {
        return prev.filter((s) => s !== skillName)
      }
      return [...prev, skillName]
    })
  }

  // Get all available skills (from workspace scan)
  const allSkillNames = skills.map((s: DiscoveredSkill) => s.name)

  return (
    <div className="flex-1 flex flex-col bg-surface-base min-w-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border-subtle bg-surface-base">
        <button
          onClick={onBack}
          className="p-1.5 rounded-md hover:bg-surface-raised text-text-muted hover:text-text-primary transition-colors"
          aria-label="Back to Agents"
        >
          <ArrowLeft size={16} />
        </button>
        <div
          className="flex items-center justify-center w-7 h-7 rounded-md text-sm"
          style={{ backgroundColor: `${color}20` }}
        >
          {icon}
        </div>
        <span className="text-sm font-semibold text-text-primary">{displayName}</span>
        <span
          className={`px-1.5 py-0.5 text-[10px] rounded-full font-medium ${
            agent.isDeployed
              ? 'bg-success-muted text-success'
              : 'bg-surface-overlay/30 text-text-muted'
          }`}
        >
          {agent.isDeployed ? 'Deployed' : 'Not deployed'}
        </span>
      </div>

      {/* Content: two columns */}
      <div className="flex-1 flex min-h-0">
        {/* Left sidebar: Skills */}
        <div className="w-56 flex-shrink-0 border-r border-border-default overflow-y-auto p-4">
          <h4 className="text-xs font-medium text-text-muted mb-3">Skills assigned</h4>

          {allSkillNames.length === 0 ? (
            <p className="text-[11px] text-text-secondary">No skills available</p>
          ) : (
            <div className="space-y-1.5">
              {allSkillNames.map((skillName) => (
                <label
                  key={skillName}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-surface-raised transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={localSkills.includes(skillName)}
                    onChange={() => handleSkillToggle(skillName)}
                    className="rounded border-border-subtle text-primary focus:ring-primary bg-surface-raised w-3.5 h-3.5"
                  />
                  <span className="text-xs text-text-secondary">{skillName}</span>
                </label>
              ))}
            </div>
          )}

          {/* Agent properties */}
          <div className="mt-6 pt-4 border-t border-border-default">
            <h4 className="text-xs font-medium text-text-muted mb-3">Properties</h4>
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] text-text-muted mb-1">Model</label>
                <span className="text-xs text-text-secondary">{agent.parsed.model}</span>
              </div>
              <div>
                <label className="block text-[10px] text-text-muted mb-1">Tools</label>
                <div className="flex flex-wrap gap-1">
                  {agent.parsed.tools.map((tool) => (
                    <span
                      key={tool}
                      className="px-1.5 py-0.5 text-[10px] rounded-full bg-primary-muted text-primary-text font-medium"
                    >
                      {tool}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-[10px] text-text-muted mb-1">Filename</label>
                <span className="text-[11px] text-text-muted font-mono">{agent.filename}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Main: YAML editor */}
        <div className="flex-1 overflow-y-auto p-4">
          {isFileLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={18} className="animate-spin text-text-muted" />
            </div>
          ) : activeFileContent !== null ? (
            <AgentYamlEditor
              filePath={agent.filename}
              initialContent={activeFileContent}
              onSave={handleSave}
              readOnly={!agent.isDeployed}
            />
          ) : (
            <div className="flex items-center justify-center py-12">
              <p className="text-sm text-text-muted">Could not load agent file</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
