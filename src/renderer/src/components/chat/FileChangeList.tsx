import {
  Check,
  FileCode,
  FileMinus,
  FilePlus,
  Loader2,
  Minus,
  Square,
  CheckSquare,
  GitBranch,
  Settings
} from 'lucide-react'
import type { FileChangeDetail } from '@renderer/store'
import type { DiffComparisonMode } from '../../../../shared/types'

interface FileChangeListProps {
  files: FileChangeDetail[]
  selectedFile: string | null
  checkedFiles: Set<string>
  onSelectFile: (filePath: string) => void
  onToggleCheck: (filePath: string) => void
  onSelectAll: () => void
  onDeselectAll: () => void
  isLoading: boolean
  isGitConfigured?: boolean
  onNavigateToSettings?: () => void
  comparisonMode?: DiffComparisonMode
  currentBranch?: string
  targetBranch?: string
}

const CHANGE_TYPE_CONFIG = {
  created: {
    icon: FilePlus,
    badge: 'A',
    badgeClass: 'bg-success-muted text-success border-success/30',
    iconClass: 'text-success'
  },
  modified: {
    icon: FileCode,
    badge: 'M',
    badgeClass: 'bg-warning-muted text-warning border-warning/30',
    iconClass: 'text-warning'
  },
  deleted: {
    icon: FileMinus,
    badge: 'D',
    badgeClass: 'bg-danger-muted text-danger border-danger/30',
    iconClass: 'text-danger'
  }
} as const

export default function FileChangeList({
  files,
  selectedFile,
  checkedFiles,
  onSelectFile,
  onToggleCheck,
  onSelectAll,
  onDeselectAll,
  isLoading,
  isGitConfigured = true,
  onNavigateToSettings,
  comparisonMode = 'uncommitted',
  currentBranch = '',
  targetBranch = ''
}: FileChangeListProps): React.JSX.Element {
  const allChecked = files.length > 0 && checkedFiles.size === files.length
  const someChecked = checkedFiles.size > 0 && checkedFiles.size < files.length

  if (files.length === 0 && !isLoading) {
    // State A — No git repo
    if (!isGitConfigured) {
      return (
        <div className="w-[30%] min-w-[240px] border-r border-border-subtle flex flex-col items-center justify-center px-4 py-12 text-center">
          <div className="w-12 h-12 rounded-full bg-warning-muted flex items-center justify-center mb-3">
            <GitBranch size={24} className="text-warning" />
          </div>
          <p className="text-sm font-medium text-text-primary mb-1">Git is not configured</p>
          <p className="text-xs text-text-secondary mb-3">
            Set up a repository to track your changes
          </p>
          {onNavigateToSettings && (
            <button
              onClick={onNavigateToSettings}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-primary text-white hover:brightness-110 transition-colors"
            >
              <Settings size={12} />
              Set up Repository
            </button>
          )}
        </div>
      )
    }

    // State B — Git configured, no changes
    const emptyMessage =
      comparisonMode === 'uncommitted'
        ? 'No uncommitted changes'
        : `No differences between ${currentBranch || 'current branch'} and ${targetBranch || 'target'}`
    const emptyDetail =
      comparisonMode === 'uncommitted'
        ? 'All file changes have been committed.'
        : 'Both branches are in sync.'

    return (
      <div className="w-[30%] min-w-[240px] border-r border-border-subtle flex flex-col items-center justify-center px-4 py-12 text-center">
        <div className="w-12 h-12 rounded-full bg-success-muted flex items-center justify-center mb-3">
          <Check size={24} className="text-success" />
        </div>
        <p className="text-sm font-medium text-text-primary mb-1">{emptyMessage}</p>
        <p className="text-xs text-text-secondary">{emptyDetail}</p>
      </div>
    )
  }

  // State C — Loading
  if (isLoading) {
    return (
      <div className="w-[30%] min-w-[240px] border-r border-border-subtle flex items-center justify-center">
        <Loader2 size={20} className="text-text-muted animate-spin" />
      </div>
    )
  }

  return (
    <div data-testid="file-change-list" className="w-[30%] min-w-[240px] border-r border-border-subtle flex flex-col min-h-0">
      {/* Header with select all */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle bg-surface-overlay/50">
        {comparisonMode === 'uncommitted' ? (
          <button
            type="button"
            onClick={allChecked ? onDeselectAll : onSelectAll}
            className="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            {allChecked ? (
              <CheckSquare size={14} className="text-primary-text" />
            ) : someChecked ? (
              <Minus size={14} className="text-primary-text" />
            ) : (
              <Square size={14} />
            )}
            {allChecked ? 'Deselect all' : 'Select all'}
          </button>
        ) : (
          <span className="text-xs text-text-secondary">Changed files</span>
        )}
        <span className="text-[10px] text-text-muted tabular-nums">
          {files.length} file{files.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {files.map((file) => {
          const config = CHANGE_TYPE_CONFIG[file.changeType]
          const Icon = config.icon
          const isSelected = selectedFile === file.filePath
          const isChecked = checkedFiles.has(file.filePath)
          const fileName = file.filePath.split('/').pop() ?? file.filePath
          const dirPath = file.filePath.includes('/')
            ? file.filePath.slice(0, file.filePath.lastIndexOf('/'))
            : ''

          return (
            <div
              key={file.filePath}
              className={`
                flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors
                border-b border-border-subtle/30
                ${isSelected ? 'bg-primary-muted/30 border-l-2 border-l-primary' : 'hover:bg-surface-overlay/40'}
              `}
              onClick={() => onSelectFile(file.filePath)}
            >
              {/* Checkbox — only in uncommitted mode */}
              {comparisonMode === 'uncommitted' && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggleCheck(file.filePath)
                  }}
                  className="shrink-0 p-0.5 rounded transition-colors hover:bg-surface-overlay"
                >
                  {isChecked ? (
                    <CheckSquare size={14} className="text-primary-text" />
                  ) : (
                    <Square size={14} className="text-text-muted" />
                  )}
                </button>
              )}

              {/* File icon */}
              <Icon size={14} className={`shrink-0 ${config.iconClass}`} />

              {/* File name + path */}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-text-primary truncate">{fileName}</p>
                {dirPath && <p className="text-[10px] text-text-muted truncate">{dirPath}</p>}
              </div>

              {/* Change type badge */}
              <span
                className={`shrink-0 inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold border ${config.badgeClass}`}
              >
                {config.badge}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
