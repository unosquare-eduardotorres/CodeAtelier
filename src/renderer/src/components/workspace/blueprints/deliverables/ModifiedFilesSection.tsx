/**
 * ModifiedFilesSection — VERIFY deliverable's "what actually changed" list.
 *
 * Sources files from git (baseline commit recorded at BUILD start) with a
 * tool-activity fallback, renders them with language icons + +/- counts, and
 * opens the selected file in the shared file-viewer drawer mounted by
 * BlueprintDeliverablesView (single owner — no duplicate side-by-side panel).
 */
import { useEffect, useMemo, useState, type JSX } from 'react'
import { FileDiff, Loader2 } from 'lucide-react'
import FileLanguageIcon from '../../../common/FileLanguageIcon'
import { useFileViewerStore } from '@renderer/store/file-viewer.store'
import { useBlueprintStore } from '@renderer/store/blueprint.store'
import { aggregateModifiedFilesFromActivities } from '@renderer/utils/modified-files-fallback'

interface ModifiedFile {
  path: string
  status: 'M' | 'A' | 'D'
  additions: number
  deletions: number
}

const STATUS_LABELS: Record<ModifiedFile['status'], { label: string; className: string }> = {
  M: { label: 'Modified', className: 'text-amber-400' },
  A: { label: 'Added', className: 'text-emerald-400' },
  D: { label: 'Deleted', className: 'text-danger' }
}

export function ModifiedFilesSection({ blueprintId }: { blueprintId: string }): JSX.Element | null {
  const [files, setFiles] = useState<ModifiedFile[]>([])
  const [source, setSource] = useState<'git' | 'none'>('git')
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const openFile = useFileViewerStore((s) => s.openFile)
  const viewerActiveFile = useFileViewerStore((s) => s.activeFile)

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      window.api
        .getBlueprintModifiedFiles({ blueprintId })
        .then((result) => {
          if (!cancelled) {
            setFiles(result.files)
            setSource(result.source)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setFiles([])
            setSource('git')
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }
    // Defer the sync setLoading(true) out of the effect body — the lint rule
    // flags synchronous setState in effects; a microtask keeps it cascade-free.
    Promise.resolve().then(() => {
      if (!cancelled) setLoading(true)
    })
    load()
    return () => {
      cancelled = true
    }
  }, [blueprintId])

  // Fallback (source === 'none'): no git baseline — aggregate the list from the
  // blueprint's streamed tool activity. Gated to the current blueprint id,
  // same pattern as TranscriptSection.
  const chatMessages = useBlueprintStore((s) => s.chatMessages)
  const currentBpId = useBlueprintStore((s) => s.currentBlueprint?.id)
  const fallbackFiles = useMemo(() => {
    if (source !== 'none') return []
    if (currentBpId !== blueprintId) return []
    const activities = chatMessages.flatMap((m) => (m.type === 'agent' ? m.toolActivities : []))
    return aggregateModifiedFilesFromActivities(activities)
  }, [source, currentBpId, blueprintId, chatMessages])

  const effectiveFiles = source === 'none' ? fallbackFiles : files

  if (loading) {
    return (
      <div className="mb-6 flex items-center gap-2 text-xs text-text-muted">
        <Loader2 size={12} className="animate-spin" />
        Loading modified files…
      </div>
    )
  }

  if (effectiveFiles.length === 0) return null

  const handleOpen = (path: string): void => {
    setSelected(path)
    // blueprintId ctx → the viewer reads from the blueprint's execution track,
    // not the primary checkout (which may not contain the changes yet).
    void openFile(path, { blueprintId })
  }

  // Keep the highlight in sync when the shared viewer moves elsewhere.
  const effectiveSelected = viewerActiveFile ?? selected

  return (
    <div className="mb-6" data-testid="verify-modified-files">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
        <FileDiff size={12} className="inline mr-1" />
        Modified Files ({effectiveFiles.length})
      </h3>

      {source === 'none' && (
        <p className="text-[10px] text-text-muted mb-2" data-testid="verify-modified-files-source">
          from tool activity (no git baseline)
        </p>
      )}

      {/* File list — rendering is owned by the shared viewer drawer in
          BlueprintDeliverablesView; clicking a row opens the file there. */}
      <div className="rounded-xl border border-border-subtle overflow-hidden max-h-[420px] overflow-y-auto">
        {effectiveFiles.map((f) => {
          const status = STATUS_LABELS[f.status]
          const isSelected = effectiveSelected === f.path
          return (
            <button
              key={f.path}
              type="button"
              onClick={() => f.status !== 'D' && handleOpen(f.path)}
              disabled={f.status === 'D'}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left border-b border-border-subtle last:border-b-0 transition-colors ${
                isSelected
                  ? 'bg-surface-overlay'
                  : f.status === 'D'
                    ? 'opacity-50 cursor-not-allowed'
                    : 'hover:bg-surface-overlay/50'
              }`}
              title={f.path}
            >
              <FileLanguageIcon filePath={f.path} size={14} />
              <span className="font-mono text-[11px] truncate min-w-0 flex-1">{f.path}</span>
              <span className={`text-[10px] font-medium flex-shrink-0 ${status.className}`}>
                {status.label}
              </span>
              <span className="text-[10px] tabular-nums flex-shrink-0">
                <span className="text-emerald-400">+{f.additions}</span>{' '}
                <span className="text-danger">−{f.deletions}</span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
