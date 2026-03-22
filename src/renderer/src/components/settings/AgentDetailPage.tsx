import { useState, useEffect } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { useSettingsStore } from '@renderer/store/settings.store'
import { AGENT_META } from '../../../../shared/constants'
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
  const [localSkills, setLocalSkills] = useState<string[]>(agent.parsed.skills)

  const meta = AGENT_META[agent.parsed.name]
  const icon = meta?.icon ?? '🤖'
  const color = meta?.color ?? '#6366F1'
  const displayName = meta?.displayName ?? agent.parsed.name

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
    <div className="flex-1 flex flex-col bg-gray-900 min-w-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-700 bg-gray-900">
        <button
          onClick={onBack}
          className="p-1.5 rounded-md hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
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
        <span className="text-sm font-semibold text-gray-200">{displayName}</span>
        <span
          className={`px-1.5 py-0.5 text-[10px] rounded-full font-medium ${
            agent.isDeployed
              ? 'bg-green-500/10 text-green-400'
              : 'bg-gray-600/30 text-gray-500'
          }`}
        >
          {agent.isDeployed ? 'Deployed' : 'Not deployed'}
        </span>
      </div>

      {/* Content: two columns */}
      <div className="flex-1 flex min-h-0">
        {/* Left sidebar: Skills */}
        <div className="w-56 flex-shrink-0 border-r border-gray-800 overflow-y-auto p-4">
          <h4 className="text-xs font-medium text-gray-400 mb-3">Skills assigned</h4>

          {allSkillNames.length === 0 ? (
            <p className="text-[11px] text-gray-600">No skills available</p>
          ) : (
            <div className="space-y-1.5">
              {allSkillNames.map((skillName) => (
                <label
                  key={skillName}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-gray-800 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={localSkills.includes(skillName)}
                    onChange={() => handleSkillToggle(skillName)}
                    className="rounded border-gray-600 text-indigo-500 focus:ring-indigo-500 bg-gray-800 w-3.5 h-3.5"
                  />
                  <span className="text-xs text-gray-300">{skillName}</span>
                </label>
              ))}
            </div>
          )}

          {/* Agent properties */}
          <div className="mt-6 pt-4 border-t border-gray-800">
            <h4 className="text-xs font-medium text-gray-400 mb-3">Properties</h4>
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] text-gray-500 mb-1">Model</label>
                <span className="text-xs text-gray-300">{agent.parsed.model}</span>
              </div>
              <div>
                <label className="block text-[10px] text-gray-500 mb-1">Tools</label>
                <div className="flex flex-wrap gap-1">
                  {agent.parsed.tools.map((tool) => (
                    <span
                      key={tool}
                      className="px-1.5 py-0.5 text-[10px] rounded bg-gray-800 text-gray-400"
                    >
                      {tool}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-[10px] text-gray-500 mb-1">Filename</label>
                <span className="text-[11px] text-gray-400 font-mono">{agent.filename}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Main: YAML editor */}
        <div className="flex-1 overflow-y-auto p-4">
          {isFileLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={18} className="animate-spin text-gray-500" />
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
              <p className="text-sm text-gray-500">Could not load agent file</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
