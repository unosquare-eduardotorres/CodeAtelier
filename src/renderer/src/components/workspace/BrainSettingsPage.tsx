import { useState, useEffect, useCallback } from 'react'
import {
  Brain,
  BarChart3,
  FileText,
  Compass,
  Zap,
  RefreshCw,
  Eye,
  X,
  Shrink,
  Upload,
  FolderSearch,
  Loader2
} from 'lucide-react'
import { useDropzone } from 'react-dropzone'
import { useWorkspaceStore, useBrainFeedStore } from '@renderer/store'
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
      <div className="flex-1 h-2 bg-surface-base rounded-full overflow-hidden">
        <div
          className={`h-full ${color} rounded-full transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-text-muted whitespace-nowrap">
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
  const {
    status: brainFeedStatus,
    source: feedSource,
    startFeed,
    error: feedError,
    message: feedMessage
  } = useBrainFeedStore()
  const feeding = brainFeedStatus === 'running' ? feedSource : null

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

  // ── Feed Brain handlers ──

  // Reload brain info when feed completes
  useEffect(() => {
    if (brainFeedStatus === 'completed') {
      loadBrainInfo()
    }
  }, [brainFeedStatus, loadBrainInfo])

  const handleFeedClaudeMd = (): void => {
    if (!activeWorkspace?.repoPath || brainFeedStatus === 'running') return
    startFeed('claude-md')
    window.api
      .brainFeedClaudeMd({ workspacePath: activeWorkspace.repoPath })
      .then((result) => {
        if (!result.success && result.error) {
          console.error('Feed failed:', result.error)
        }
      })
      .catch((err) => console.error('Feed IPC error:', err))
  }

  const handleFeedCodebase = (): void => {
    if (!activeWorkspace?.repoPath || brainFeedStatus === 'running') return
    startFeed('codebase')
    window.api
      .brainFeedCodebase({ workspacePath: activeWorkspace.repoPath })
      .then((result) => {
        if (!result.success && result.error) {
          console.error('Feed failed:', result.error)
        }
      })
      .catch((err) => console.error('Feed IPC error:', err))
  }

  const handleFeedDocumentFromPath = (filePath: string): void => {
    if (!activeWorkspace?.repoPath || brainFeedStatus === 'running') return
    startFeed('document')
    window.api
      .brainFeedDocument({ workspacePath: activeWorkspace.repoPath, filePath })
      .then((result) => {
        if (!result.success && result.error) {
          console.error('Feed failed:', result.error)
        }
      })
      .catch((err) => console.error('Feed IPC error:', err))
  }

  const handleFeedDocument = async (): Promise<void> => {
    if (!activeWorkspace?.repoPath || brainFeedStatus === 'running') return
    const filePath = await window.api.brainSelectDocument()
    if (!filePath) return
    handleFeedDocumentFromPath(filePath)
  }

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (files) => {
      if (files.length > 0 && activeWorkspace?.repoPath && !feeding) {
        const file = files[0] as unknown as File & { path: string }
        if (file.path) {
          handleFeedDocumentFromPath(file.path)
        }
      }
    },
    accept: {
      'text/plain': ['.txt', '.md'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
      'application/rtf': ['.rtf']
    },
    multiple: false,
    disabled: feeding !== null
  })

  if (isLoading) {
    return (
      <div className="p-6 flex items-center justify-center">
        <RefreshCw size={16} className="animate-spin text-text-muted" />
        <span className="ml-2 text-sm text-text-secondary">Loading brain info...</span>
      </div>
    )
  }

  if (!brainStatus) {
    return (
      <div className="p-6">
        <p className="text-sm text-text-secondary">
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
            <h3 className="text-sm font-semibold text-text-primary">Project Brain</h3>
            <p className="text-xs text-text-secondary mt-0.5">
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

      {/* Feed Brain section */}
      <div className="bg-surface-overlay border border-border-subtle rounded-lg p-4 space-y-3 shadow-sm">
        <div className="flex items-center gap-2">
          <Upload size={14} className="text-purple-400" />
          <span className="text-xs font-semibold text-text-primary">Feed Brain</span>
        </div>

        <p className="text-xs text-text-secondary">
          AI analyzes your sources and writes structured summaries to the brain files.
        </p>

        {/* Action buttons row */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleFeedClaudeMd}
            disabled={feeding !== null}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-surface-float hover:bg-border-subtle text-text-body rounded-md transition-colors disabled:opacity-50"
          >
            {feeding === 'claude-md' ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <FileText size={12} />
            )}
            Ingest CLAUDE.md
          </button>

          <button
            onClick={handleFeedCodebase}
            disabled={feeding !== null}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-surface-float hover:bg-border-subtle text-text-body rounded-md transition-colors disabled:opacity-50"
          >
            {feeding === 'codebase' ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <FolderSearch size={12} />
            )}
            Scan Codebase
          </button>

          <button
            onClick={handleFeedDocument}
            disabled={feeding !== null}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-surface-float hover:bg-border-subtle text-text-body rounded-md transition-colors disabled:opacity-50"
          >
            {feeding === 'document' ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Upload size={12} />
            )}
            Browse File
          </button>
        </div>

        {/* Document drop zone */}
        <div
          {...getRootProps()}
          className={`border border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${
            isDragActive
              ? 'border-purple-400 bg-purple-400/5'
              : feeding
                ? 'border-border-subtle opacity-50 cursor-not-allowed'
                : 'border-border-default hover:border-text-muted hover:bg-surface-overlay/30'
          }`}
        >
          <input {...getInputProps()} />
          <Upload size={16} className="mx-auto mb-1.5 text-text-muted" />
          <p className="text-xs text-text-secondary">
            Drop a document or <span className="text-purple-400">click to browse</span>
          </p>
          <p className="text-xs text-text-muted mt-0.5">
            .md .txt .docx .xlsx .pdf .pptx .rtf (max 2MB)
          </p>
        </div>

        {/* Progress / status */}
        {(feedMessage || feedError) && brainFeedStatus !== 'idle' && (
          <div
            className={`text-xs px-3 py-2 rounded-md ${
              feedError
                ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                : feeding
                  ? 'bg-purple-500/10 text-purple-300 border border-purple-500/20'
                  : 'bg-green-500/10 text-green-400 border border-green-500/20'
            }`}
          >
            {feeding && <Loader2 size={11} className="inline animate-spin mr-1.5" />}
            {feedError || feedMessage}
          </div>
        )}
      </div>

      {/* Summary card */}
      <div className="bg-surface-overlay border border-border-subtle rounded-lg p-4 space-y-2 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 text-xs text-text-secondary">
            <span>
              <strong className="text-text-primary">
                {brainStatus.totalLines.toLocaleString()}
              </strong>{' '}
              lines
            </span>
            <span>{formatBytes(brainStatus.totalSizeBytes)}</span>
            <span>~{formatTokens(brainStatus.totalEstimatedTokens)} tokens</span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded-full ${
                brainStatus.enabled
                  ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                  : 'bg-surface-float text-text-muted border border-border-subtle'
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
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-surface-float hover:bg-border-subtle text-text-body rounded-md transition-colors disabled:opacity-50"
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
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-surface-float hover:bg-border-subtle text-text-body rounded-md transition-colors disabled:opacity-50"
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
            color: 'text-text-secondary'
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
          <div className="bg-surface-float rounded-xl border border-border-default w-full max-w-3xl max-h-[80vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
              <span className="text-sm font-semibold text-text-primary">{viewingFile}</span>
              <button
                onClick={() => {
                  setViewingFile(null)
                  setViewContent(null)
                }}
                className="p-1 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
              >
                <X size={14} />
              </button>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-xs text-text-body font-mono whitespace-pre-wrap">
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
    <div className="bg-surface-overlay/50 border border-border-subtle rounded-lg p-4 space-y-2.5 shadow-sm">
      {/* File header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon size={14} className={iconColor} />
          <span className="text-xs font-semibold text-text-primary">{file.fileName}</span>
        </div>
        {file.isOverThreshold && (
          <span className="text-xs font-medium text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded-full border border-amber-400/20">
            Over threshold
          </span>
        )}
      </div>

      {/* Stats */}
      <div className="flex items-center gap-3 text-xs text-text-muted">
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
          className="flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-surface-float hover:bg-border-subtle text-text-secondary hover:text-text-primary rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <Eye size={10} />
          View
        </button>
        <button
          onClick={onCompact}
          disabled={disabled || isEmpty}
          className="flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-surface-float hover:bg-border-subtle text-text-secondary hover:text-text-primary rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {compacting ? <RefreshCw size={10} className="animate-spin" /> : <Shrink size={10} />}
          Compact
        </button>
      </div>
    </div>
  )
}
