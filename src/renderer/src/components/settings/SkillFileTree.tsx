import { FileText, FolderOpen } from 'lucide-react'
import type { DiscoveredSkill } from '../../../../shared/types'

interface SkillFileTreeProps {
  skill: DiscoveredSkill
  selectedFile: string | null
  onSelectFile: (filePath: string) => void
}

export default function SkillFileTree({
  skill,
  selectedFile,
  onSelectFile
}: SkillFileTreeProps): React.JSX.Element {
  const skillMdPath = `${skill.dirPath}/SKILL.md`
  const hasReferences = skill.referenceFiles.length > 0

  return (
    <div className="space-y-1">
      <h4 className="text-xs font-medium text-gray-400 mb-2 flex items-center gap-1.5">
        <FolderOpen size={12} />
        {skill.name}
      </h4>

      {/* SKILL.md */}
      {skill.hasSkillMd && (
        <button
          onClick={() => onSelectFile(skillMdPath)}
          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-left transition-colors ${
            selectedFile === skillMdPath
              ? 'bg-indigo-600/20 text-indigo-400'
              : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
          }`}
        >
          <FileText size={12} className="flex-shrink-0" />
          SKILL.md
        </button>
      )}

      {/* References */}
      {hasReferences && (
        <div className="ml-2">
          <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] text-gray-500">
            <FolderOpen size={10} />
            references/
          </div>
          {skill.referenceFiles.map((refFile) => {
            const refPath = `${skill.dirPath}/references/${refFile}`
            return (
              <button
                key={refFile}
                onClick={() => onSelectFile(refPath)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 ml-3 rounded-md text-xs text-left transition-colors ${
                  selectedFile === refPath
                    ? 'bg-indigo-600/20 text-indigo-400'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                }`}
              >
                <FileText size={11} className="flex-shrink-0" />
                <span className="truncate">{refFile}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
