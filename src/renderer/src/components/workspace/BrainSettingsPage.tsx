import { useState, useEffect, useCallback } from 'react'
import { Brain, BarChart3, FileText, Compass, Zap, RefreshCw, Eye, X, Shrink } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'
import type { BrainStatus, BrainFileInfo } from '../../../../shared/types'

/** Max lines threshold for progress bar display */
const MAX_LINES = 500

/** Icon mapping per brain file */
const FILE_ICONS: Record<string, { icon: typeof BarChart3; color: string }> = {
  'project-state.md': { icon: BarChart3, color: 'text-blue-400' },
  'changelog.md': { icon: FileText, color: 'text-emerald-400' },
  'decisions-log.md': { icon: Compass, color: 'text-amber-400' },
  'errors-resolutions.md': { icon: Zap, color: 'text-red-400' }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return tokens.toString()
}

function timeAgo(isoDate: string): string {
  if (!isoDate) return 'Never'
  const diffMs = Date.now() - new Date(isoDate).getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHrs = Math.floor(diffMin / 60)
  if (diffHrs < 24) return `${diffHrs}h ago`
  const diffDays = Math.floor(diffHrs / 24)
  return `${diffDays}d ago`
}

function LineProgressBar({ current, max }: { current: number; max: number }): React.JSX.Element {
  const pct = Math.min((current / max) * 100, 100)
  const color = pct < 60 ? 'bg-green-500' : pct < 90 ? 'bg-amber-500' : 'bg-red-500'

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full ${color} rounded-full transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-gray-500 whitespace-nowrap">
        {current}/{max} ({Math.round(pct)}%)
      </span>
    </div>
  )
}

export default function BrainSettingsPage(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const [brainStatus, setBrainStatus] = useState<BrainStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [viewingFile, setViewingFile] = useState<string | null>(null)
  const [viewContent, setViewContent] = useState<string | null>(null)
  const [compacting, setCompacting] = useState<string | null>(null)
  const [toggling, setToggling] = useState(false)

  const loadBrainInfo = useCallback(async () => {
    if (!activeWorkspace?.repoPath) return
    try {
      setIsLoading(true)
      const status = await window.api.brainGetFilesInfo({
        workspacePath: activeWorkspace.repoPath
      })
      setBrainStatus(status)
    } catch (err) {
      console.error('Failed to load brain info:', err)
    } finally {
      setIsLoading(false)
    }
  }, [activeWorkspace?.repoPath])

  useEffect(() => {
    loadBrainInfo()
  }, [loadBrainInfo])

  const handleToggle = async (): Promise<void> => {
    if (!activeWorkspace || !brainStatus) return
    try {
      setToggling(true)
      const newEnabled = !brainStatus.enabled
      await window.api.brainUpdateSetting({
        workspaceId: activeWorkspace.id,
        brainEnabled: newEnabled
      })
      setBrainStatus((prev) => (prev ? { ...prev, enabled: newEnabled } : prev))
    } catch (err) {
      console.error('Failed to toggle brain:', err)
    } finally {
      setToggling(false)
    }
  }

  const handleCompactFile = async (fileName: string): Promise<void> => {
    if (!activeWorkspace?.repoPath) return
    try {
      setCompacting(fileName)
      const updatedFile = await window.api.brainCompactFile({
        workspacePath: activeWorkspace.repoPath,
        fileName
      })
      setBrainStatus((prev) => {
        if (!prev) return prev
        const files = prev.files.map((f) => (f.fileName === fileName ? updatedFile : f))
        return {
          ...prev,
          files,
          totalLines: files.reduce((s, f) => s + f.lineCount, 0),
          totalSizeBytes: files.reduce((s, f) => s + f.sizeBytes, 0),
          totalEstimatedTokens: files.reduce((s, f) => s + f.estimatedTokens, 0)
        }
      })
    } catch (err) {
      console.error('Failed to compact file:', err)
    } finally {
      setCompacting(null)
    }
  }

  const handleCompactAll = async (): Promise<void> => {
    if (!activeWorkspace?.repoPath) return
    try {
      setCompacting('all')
      const status = await window.api.brainCompactAll({
        workspacePath: activeWorkspace.repoPath
      })
      setBrainStatus(status)
    } catch (err) {
      console.error('Failed to compact all:', err)
    } finally {
      setCompacting(null)
    }
  }

  const handleViewFile = async (filePath: string, fileName: string): Promise<void> => {
    try {
      const content = await window.api.readWorkspaceFile({ filePath })
      setViewContent(content)
      setViewingFile(fileName)
    } catch (err) {
      console.error('Failed to read brain file:', err)
    }
  }

  if (isLoading) {
    return (
      <div className="p-6 flex items-center justify-center">
        <RefreshCw size={16} className="animate-spin text-gray-500" />
        <span className="ml-2 text-sm text-gray-500">Loading brain info...</span>
      </div>
    )
  }

  if (!brainStatus) {
    return (
      <div className="p-6">
        <p className="text-sm text-gray-500">
          Brain not initialized. Open a workspace to initialize the project brain.
        </p>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-5">
      {/* Header with toggle */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          <Brain size={18} className="text-purple-400" />
          <div>
            <h3 className="text-sm font-semibold text-gray-200">Project Brain</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Persistent memory injected into new conversations
            </p>
          </div>
        </div>
        <button
          onClick={handleToggle}
          disabled={toggling}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            brainStatus.enabled ? 'bg-purple-600' : 'bg-gray-600'
          } ${toggling ? 'opacity-50' : ''}`}
          aria-label={brainStatus.enabled ? 'Disable brain' : 'Enable brain'}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              brainStatus.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
            }`}
          />
        </button>
      </div>

      {/* Summary card */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 text-xs text-gray-400">
            <span>
              <strong className="text-gray-200">{brainStatus.totalLines.toLocaleString()}</strong>{' '}
              lines
            </span>
            <span>{formatBytes(brainStatus.totalSizeBytes)}</span>
            <span>~{formatTokens(brainStatus.totalEstimatedTokens)} tokens</span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                brainStatus.enabled
                  ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                  : 'bg-gray-600/20 text-gray-500 border border-gray-600/30'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${brainStatus.enabled ? 'bg-green-400' : 'bg-gray-500'}`}
              />
              {brainStatus.enabled ? 'Active' : 'Disabled'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCompactAll}
            disabled={compacting !== null}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-md transition-colors disabled:opacity-50"
          >
            {compacting === 'all' ? (
              <RefreshCw size={11} className="animate-spin" />
            ) : (
              <Shrink size={11} />
            )}
            Compact All
          </button>
          <button
            onClick={loadBrainInfo}
            disabled={isLoading}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-md transition-colors disabled:opacity-50"
          >
            <RefreshCw size={11} />
            Refresh
          </button>
        </div>
      </div>

      {/* File cards */}
      <div className="space-y-3">
        {brainStatus.files.map((file) => {
          const iconConfig = FILE_ICONS[file.fileName] ?? {
            icon: FileText,
            color: 'text-gray-400'
          }
          const Icon = iconConfig.icon
          return (
            <BrainFileCard
              key={file.fileName}
              file={file}
              Icon={Icon}
              iconColor={iconConfig.color}
              compacting={compacting === file.fileName}
              onCompact={() => handleCompactFile(file.fileName)}
              onView={() => handleViewFile(file.filePath, file.fileName)}
              disabled={compacting !== null}
            />
          )
        })}
      </div>

      {/* View modal */}
      {viewingFile && viewContent !== null && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-8">
          <div className="bg-gray-800 rounded-xl border border-gray-700 w-full max-w-3xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
              <span className="text-sm font-semibold text-gray-200">{viewingFile}</span>
              <button
                onClick={() => {
                  setViewingFile(null)
                  setViewContent(null)
                }}
                className="p-1 rounded-md hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
              >
                <X size={14} />
              </button>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-xs text-gray-300 font-mono whitespace-pre-wrap">
              {viewContent}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

/** Individual brain file card */
function BrainFileCard({
  file,
  Icon,
  iconColor,
  compacting,
  onCompact,
  onView,
  disabled
}: {
  file: BrainFileInfo
  Icon: typeof BarChart3
  iconColor: string
  compacting: boolean
  onCompact: () => void
  onView: () => void
  disabled: boolean
}): React.JSX.Element {
  const isEmpty = file.lineCount === 0

  return (
    <div className="bg-gray-800/30 border border-gray-700/60 rounded-lg p-3.5 space-y-2.5">
      {/* File header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon size={14} className={iconColor} />
          <span className="text-xs font-semibold text-gray-200">{file.fileName}</span>
        </div>
        {file.isOverThreshold && (
          <span className="text-[10px] font-medium text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded-full border border-amber-400/20">
            Over threshold
          </span>
        )}
      </div>

      {/* Stats */}
      <div className="flex items-center gap-3 text-[11px] text-gray-500">
        <span>{file.lineCount} lines</span>
        <span>{formatBytes(file.sizeBytes)}</span>
        <span>~{formatTokens(file.estimatedTokens)} tokens</span>
        {file.lastModified && <span>Modified {timeAgo(file.lastModified)}</span>}
      </div>

      {/* Progress bar */}
      {!isEmpty && <LineProgressBar current={file.lineCount} max={MAX_LINES} />}

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={onView}
          disabled={isEmpty}
          className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium bg-gray-700/50 hover:bg-gray-600/50 text-gray-400 hover:text-gray-200 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <Eye size={10} />
          View
        </button>
        <button
          onClick={onCompact}
          disabled={disabled || isEmpty}
          className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium bg-gray-700/50 hover:bg-gray-600/50 text-gray-400 hover:text-gray-200 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {compacting ? (
            <RefreshCw size={10} className="animate-spin" />
          ) : (
            <Shrink size={10} />
          )}
          Compact
        </button>
      </div>
    </div>
  )
}
