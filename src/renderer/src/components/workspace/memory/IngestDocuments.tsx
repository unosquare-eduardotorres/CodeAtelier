/**
 * IngestDocuments — the single entry point for getting documents into memory.
 *
 * Features:
 * - One drop zone with "Select Files… / Select Folder…" and the single-document
 *   extractor that used to live in a separate card several hundred pixels away
 * - Folder discovery with file count confirmation
 * - Per-doc progress (queued → extracting chunk i/M → done — N facts)
 * - Overall progress bar + Cancel button
 */

import { useState, useCallback, useRef, type DragEvent } from 'react'
import {
  FolderOpen,
  FileUp,
  Upload,
  X,
  Loader2,
  CheckCircle,
  AlertTriangle,
  SkipForward
} from 'lucide-react'
import { useWorkspaceStore, useMemoryStore } from '@renderer/store'
import { Button, PanelHeader } from '@renderer/components/common/ui'
import type { IngestionProgress } from '../../../../../shared/types'

// ── Status icon mapping ──

function DocStatusIcon({ status }: { status: IngestionProgress['docStatus'] }): React.JSX.Element {
  switch (status) {
    case 'done':
      return <CheckCircle className="w-3.5 h-3.5 text-success" />
    case 'error':
      return <AlertTriangle className="w-3.5 h-3.5 text-danger" />
    case 'skipped':
      return <SkipForward className="w-3.5 h-3.5 text-text-muted" />
    case 'reading':
    case 'chunking':
    case 'extracting':
      return <Loader2 className="w-3.5 h-3.5 text-teal animate-spin" />
    default:
      return <div className="w-3.5 h-3.5 rounded-full border border-border-default" />
  }
}

interface IngestDocumentsProps {
  /** Single-document extractor — a different pipeline to the batch ingester. */
  onFeedDocument?: () => void
  feedStatus?: 'idle' | 'running' | 'completed' | 'error'
  feedMessage?: string | null
  feedError?: string | null
}

export default function IngestDocuments({
  onFeedDocument,
  feedStatus = 'idle',
  feedMessage,
  feedError
}: IngestDocumentsProps): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const { ingestion, startIngestion, cancelIngestion, dismissIngestion } = useMemoryStore()
  const [pendingFiles, setPendingFiles] = useState<string[]>([])
  const [folderDiscovery, setFolderDiscovery] = useState<{
    counts: Record<string, number>
    truncated: boolean
    files: string[]
  } | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const dropRef = useRef<HTMLDivElement>(null)

  const workspaceId = activeWorkspace?.id
  const workspacePath = activeWorkspace?.repoPath

  // ── File selection ──

  const handleSelectFiles = useCallback(async () => {
    const files = await window.api.memoryIngestSelectFiles()
    if (files && files.length > 0) {
      setPendingFiles(files)
      setFolderDiscovery(null)
    }
  }, [])

  const handleSelectFolder = useCallback(async () => {
    const folder = await window.api.memoryIngestSelectFolder()
    if (!folder) return
    const discovery = await window.api.memoryIngestDiscover({ folderPath: folder })
    setFolderDiscovery(discovery)
    setPendingFiles(discovery.files)
  }, [])

  const handleStartIngestion = useCallback(async () => {
    if (!workspaceId || !workspacePath || pendingFiles.length === 0) return
    const files = [...pendingFiles]
    setPendingFiles([])
    setFolderDiscovery(null)
    await startIngestion(workspaceId, workspacePath, files)
  }, [workspaceId, workspacePath, pendingFiles, startIngestion])

  const handleCancel = useCallback(() => {
    cancelIngestion()
  }, [cancelIngestion])

  const handleDismiss = useCallback(() => {
    dismissIngestion()
    setPendingFiles([])
    setFolderDiscovery(null)
  }, [dismissIngestion])

  const handleClearPending = useCallback(() => {
    setPendingFiles([])
    setFolderDiscovery(null)
  }, [])

  // ── Drag & Drop ──

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const files = Array.from(e.dataTransfer.files)
      .map((f) => (f as File & { path?: string }).path)
      .filter(Boolean) as string[]

    if (files.length > 0) {
      setPendingFiles((prev) => [...new Set([...prev, ...files])])
      setFolderDiscovery(null)
    }
  }, [])

  const isRunning = ingestion?.jobStatus === 'running'
  const isDone =
    ingestion?.jobStatus === 'done' ||
    ingestion?.jobStatus === 'cancelled' ||
    ingestion?.jobStatus === 'error'

  return (
    <div className="space-y-3">
      <PanelHeader
        title="Ingest Documents"
        description="Extract memories from files — markdown, code, PDF, DOCX. Unchanged files are skipped on re-ingest."
      />

      {/* ── Active Ingestion Progress ── */}
      {ingestion && (
        <div className="rounded-lg border border-border-default bg-surface-float p-3 space-y-2">
          {/* Overall progress bar */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-secondary">
              {isRunning
                ? `Processing ${ingestion.docIndex}/${ingestion.docCount}…`
                : ingestion.jobStatus === 'done'
                  ? `Done — ${ingestion.factsCreated} memories created`
                  : ingestion.jobStatus === 'cancelled'
                    ? 'Cancelled'
                    : `Error: ${ingestion.message}`}
            </span>
            <span className="text-text-muted">{ingestion.factsCreated} memories</span>
          </div>

          <div className="h-1.5 bg-surface-overlay rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                ingestion.jobStatus === 'error'
                  ? 'bg-danger'
                  : ingestion.jobStatus === 'done'
                    ? 'bg-success'
                    : 'bg-teal'
              }`}
              style={{
                width: `${ingestion.docCount > 0 ? (ingestion.docIndex / ingestion.docCount) * 100 : 0}%`
              }}
            />
          </div>

          {/* Current doc status */}
          {isRunning && ingestion.docName && (
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <DocStatusIcon status={ingestion.docStatus} />
              <span className="truncate">{ingestion.docName}</span>
              {ingestion.chunkCount > 0 && (
                <span className="ml-auto shrink-0">
                  chunk {ingestion.chunkIndex}/{ingestion.chunkCount}
                </span>
              )}
            </div>
          )}

          {/* Message */}
          {ingestion.message && (
            <div className="text-xs text-text-muted truncate">{ingestion.message}</div>
          )}

          {/* Action buttons */}
          <div className="flex justify-end gap-2 pt-1">
            {isRunning && (
              <Button variant="danger" onClick={handleCancel}>
                <X className="w-3 h-3" />
                Cancel
              </Button>
            )}
            {isDone && (
              <Button variant="ghost" onClick={handleDismiss}>
                Dismiss
              </Button>
            )}
          </div>
        </div>
      )}

      {/* ── Pending files / Selection ── */}
      {!isRunning && (
        <>
          {/* Drop zone / selection buttons */}
          <div
            ref={dropRef}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`rounded-lg border-2 border-dashed p-4 text-center transition-colors ${
              isDragOver
                ? 'border-teal bg-teal/5'
                : 'border-border-default hover:border-border-strong'
            }`}
          >
            <div className="flex items-center justify-center gap-2 mb-2">
              <Button variant="primary" size="md" onClick={handleSelectFiles}>
                <FileUp className="w-4 h-4" />
                Select Files…
              </Button>
              <Button variant="secondary" size="md" onClick={handleSelectFolder}>
                <FolderOpen className="w-4 h-4" />
                Select Folder…
              </Button>
            </div>
            <p className="text-xs text-text-muted">or drag and drop files here</p>

            {/* Single-document extractor — same concern, so it lives in the
                same card instead of a second "Feed Document" button elsewhere */}
            {onFeedDocument && (
              <div className="mt-3 pt-3 border-t border-border-subtle flex items-center justify-center gap-2">
                <Button
                  variant="ghost"
                  onClick={onFeedDocument}
                  disabled={feedStatus === 'running'}
                  title="Extract memories from one document without queueing a batch"
                >
                  <Upload className="w-3.5 h-3.5" />
                  Feed a single document
                </Button>
                {feedStatus === 'running' && (
                  <span className="text-xs text-info">{feedMessage}</span>
                )}
                {feedStatus === 'error' && <span className="text-xs text-danger">{feedError}</span>}
                {feedStatus === 'completed' && (
                  <span className="text-xs text-success">{feedMessage}</span>
                )}
              </div>
            )}
          </div>

          {/* Folder discovery summary */}
          {folderDiscovery && (
            <div className="rounded-lg border border-border-default bg-surface-float p-3 space-y-2">
              <div className="text-xs text-text-secondary">
                Found <strong>{pendingFiles.length}</strong> files
                {folderDiscovery.truncated && (
                  <span className="text-warning ml-1">(capped at 200)</span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(folderDiscovery.counts)
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 10)
                  .map(([ext, count]) => (
                    <span
                      key={ext}
                      className="px-1.5 py-0.5 text-xs bg-surface-overlay rounded text-text-muted"
                    >
                      {ext} ({count})
                    </span>
                  ))}
              </div>
            </div>
          )}

          {/* Pending files list (when manually selected) */}
          {pendingFiles.length > 0 && !folderDiscovery && (
            <div className="rounded-lg border border-border-default bg-surface-float p-3 space-y-1">
              <div className="text-xs text-text-secondary mb-1">
                {pendingFiles.length} file{pendingFiles.length !== 1 ? 's' : ''} selected
              </div>
              {pendingFiles.slice(0, 10).map((f) => (
                <div key={f} className="text-xs text-text-muted truncate">
                  {f.split('/').pop()}
                </div>
              ))}
              {pendingFiles.length > 10 && (
                <div className="text-xs text-text-muted">…and {pendingFiles.length - 10} more</div>
              )}
            </div>
          )}

          {/* Start / Clear buttons */}
          {pendingFiles.length > 0 && (
            <div className="flex gap-2">
              <Button
                variant="primary"
                size="md"
                onClick={handleStartIngestion}
                disabled={!workspaceId || !workspacePath}
              >
                <Loader2 className="w-4 h-4" />
                Ingest {pendingFiles.length} file{pendingFiles.length !== 1 ? 's' : ''}
              </Button>
              <Button variant="ghost" size="md" onClick={handleClearPending}>
                Clear
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
