import { useState, useEffect } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { useSettingsStore } from '@renderer/store/settings.store'
import SkillFileTree from './SkillFileTree'
import MarkdownViewer from './MarkdownViewer'
import type { DiscoveredSkill } from '../../../../shared/types'

interface SkillDetailPageProps {
  skill: DiscoveredSkill
  onBack: () => void
}

export default function SkillDetailPage({
  skill,
  onBack
}: SkillDetailPageProps): React.JSX.Element {
  const { agents, readFile, saveFile, activeFileContent, activeFilePath, isFileLoading } =
    useSettingsStore()
  const initialFile = skill.hasSkillMd ? `${skill.dirPath}/SKILL.md` : null
  const [selectedFile, setSelectedFile] = useState<string | null>(initialFile)

  // Auto-select SKILL.md on mount
  useEffect(() => {
    if (skill.hasSkillMd) {
      const path = `${skill.dirPath}/SKILL.md`
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedFile(path)
      readFile(path)
    }
  }, [skill, readFile])

  const handleSelectFile = (filePath: string): void => {
    setSelectedFile(filePath)
    readFile(filePath)
  }

  const handleSave = async (content: string): Promise<void> => {
    if (!selectedFile) return
    await saveFile(selectedFile, content)
  }

  // Find which agents use this skill
  const usedByAgents = agents.filter((a) => a.parsed.skills.includes(skill.name))

  const isWorkspaceSkill = skill.source === 'workspace'

  return (
    <div className="flex-1 flex flex-col bg-surface-raised min-w-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border-subtle bg-surface-raised">
        <button
          onClick={onBack}
          className="p-1.5 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
          aria-label="Back to Skills"
        >
          <ArrowLeft size={16} />
        </button>
        <span className="text-sm font-semibold text-text-primary">{skill.name}</span>
        <span
          className={`px-1.5 py-0.5 text-xs rounded-full font-medium ${
            skill.isActive ? 'bg-success-muted text-success' : 'bg-surface-overlay text-text-muted'
          }`}
        >
          {skill.isActive ? 'Active' : 'Inactive'}
        </span>
        {skill.lastUpdated && (
          <span className="text-xs text-text-muted">Last updated: {skill.lastUpdated}</span>
        )}
      </div>

      {/* Content: two columns */}
      <div className="flex-1 flex min-h-0">
        {/* Left sidebar: File tree + Used by */}
        <div className="w-56 flex-shrink-0 border-r border-border-subtle overflow-y-auto p-4">
          <SkillFileTree
            skill={skill}
            selectedFile={selectedFile}
            onSelectFile={handleSelectFile}
          />

          {/* Used by agents */}
          {usedByAgents.length > 0 && (
            <div className="mt-6 pt-4 border-t border-border-subtle">
              <h4 className="text-xs font-medium text-text-secondary mb-2">Used by</h4>
              <div className="space-y-1">
                {usedByAgents.map((agent) => (
                  <div
                    key={agent.filename}
                    className="text-xs text-text-secondary px-2 py-1 rounded-md bg-surface-overlay"
                  >
                    {agent.parsed.name}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Skill metadata */}
          {skill.frontmatter && (
            <div className="mt-6 pt-4 border-t border-border-subtle">
              <h4 className="text-xs font-medium text-text-secondary mb-2">Info</h4>
              {skill.frontmatter.description && (
                <p className="text-xs text-text-muted leading-relaxed">
                  {skill.frontmatter.description}
                </p>
              )}
              <div className="mt-2 text-xs text-text-muted">
                <div>Files: SKILL.md + {skill.referenceFiles.length} references</div>
                <div>Source: {skill.source}</div>
              </div>
            </div>
          )}
        </div>

        {/* Main: File viewer */}
        <div className="flex-1 overflow-y-auto p-4">
          {!selectedFile ? (
            <div className="flex items-center justify-center py-12">
              <p className="text-sm text-text-secondary">Select a file to view</p>
            </div>
          ) : isFileLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={18} className="animate-spin text-text-muted" />
            </div>
          ) : activeFileContent !== null && activeFilePath === selectedFile ? (
            <MarkdownViewer
              filePath={selectedFile.split('/').pop() ?? selectedFile}
              initialContent={activeFileContent}
              onSave={handleSave}
              readOnly={!isWorkspaceSkill}
            />
          ) : (
            <div className="flex items-center justify-center py-12">
              <p className="text-sm text-text-secondary">Could not load file</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
