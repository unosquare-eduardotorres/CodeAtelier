import { useCallback, useEffect } from 'react'
import { SettingsCard } from '@renderer/components/common'
import { Button, PanelHeader } from '@renderer/components/common/ui'
import { useMemoryStore } from '@renderer/store/memory.store'
import type { MemoryCleanupBucket, MemoryCleanupPreview } from '../../../../../shared/types'

interface CleanupPanelProps {
  workspaceId: string
}

/**
 * One bucket of the preview: the count, what it means, and enough examples to
 * tell whether the rule is doing something sensible.
 *
 * `destructive` is not styling for its own sake. Three of these buckets are
 * reversible and one is not, and a user who cannot see which is which at a
 * glance has no way to weigh the Apply button.
 */
function Bucket({
  title,
  description,
  bucket,
  destructive = false
}: {
  title: string
  description: string
  bucket: MemoryCleanupBucket
  destructive?: boolean
}): React.JSX.Element {
  return (
    <div
      className={`rounded-lg border p-3 ${
        destructive
          ? 'border-danger/30 bg-danger-muted/30'
          : 'border-border-default bg-surface-float'
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-text-primary">{title}</span>
        <span
          className={`font-mono tabular-nums text-lg font-semibold ${
            destructive ? 'text-danger' : 'text-text-primary'
          }`}
        >
          {bucket.count}
        </span>
      </div>
      <p className="mt-1 text-xs text-text-muted">{description}</p>

      {bucket.samples.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-border-default pt-2">
          {bucket.samples.map((sample) => (
            <li key={sample.id} className="flex items-center gap-2 text-xs">
              <span className="shrink-0 font-mono text-[11px] text-text-muted">T{sample.tier}</span>
              <span className="truncate text-text-secondary" title={sample.title}>
                {sample.title}
              </span>
              <span className="ml-auto shrink-0 font-mono text-[11px] text-text-muted">
                {sample.reason}
              </span>
            </li>
          ))}
          {bucket.count > bucket.samples.length && (
            <li className="text-[11px] text-text-muted">
              …and {bucket.count - bucket.samples.length} more
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/** The whole dry-run readout. Rendered only once a preview exists. */
function PreviewReport({ preview }: { preview: MemoryCleanupPreview }): React.JSX.Element {
  const { thresholds } = preview
  const nothingToDo =
    preview.idleArchive.count === 0 &&
    preview.curatorCandidates.count === 0 &&
    preview.tombstoneDelete.count === 0 &&
    preview.confirmationsPruned === 0

  if (nothingToDo) {
    return (
      <p className="rounded-lg border border-border-default bg-surface-float p-3 text-sm text-text-muted">
        Nothing to clean up. No memory has been idle for {thresholds.idleArchiveDays} days and there
        are no expired tombstones.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <Bucket
        title="Idle → archive"
        description={`Active memories untouched for over ${thresholds.idleArchiveDays} days. Tier 2+, human-confirmed and pinned memories are never included. Reversible.`}
        bucket={preview.idleArchive}
      />
      <Bucket
        title="Near-duplicates → curator"
        description="Too similar to be distinct, too different to merge automatically. A cheap model decides; it can only archive, never delete. Reversible."
        bucket={preview.curatorCandidates}
      />
      <Bucket
        title="Tombstones → permanently deleted"
        description={`Already archived or superseded over ${thresholds.tombstoneTtlDays} days ago. This reclaims their embeddings and CANNOT be undone.`}
        bucket={preview.tombstoneDelete}
        destructive
      />
      <div className="rounded-lg border border-border-default bg-surface-float p-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium text-text-primary">
            Confirmation log → compacted
          </span>
          <span className="font-mono tabular-nums text-lg font-semibold text-text-primary">
            {preview.confirmationsPruned}
          </span>
        </div>
        <p className="mt-1 text-xs text-text-muted">
          Retrieval records older than {thresholds.retrievalTtlDays} days, keeping one marker per
          memory per month so promotion history stays honest.
        </p>
      </div>
    </div>
  )
}

/**
 * Cleanup sweep controls.
 *
 * Preview first, deliberately: the thresholds behind these numbers are a
 * proposal rather than a measurement, and the only honest way to judge them is
 * against a real corpus. Apply is never the first thing you can press.
 */
export default function CleanupPanel({ workspaceId }: CleanupPanelProps): React.JSX.Element {
  const cleanupPreview = useMemoryStore((s) => s.cleanupPreview)
  const cleanupPreviewing = useMemoryStore((s) => s.cleanupPreviewing)
  const cleanupApplying = useMemoryStore((s) => s.cleanupApplying)
  const cleanupProgress = useMemoryStore((s) => s.cleanupProgress)
  const cleanupUndoable = useMemoryStore((s) => s.cleanupUndoable)
  const cleanupError = useMemoryStore((s) => s.cleanupError)
  const previewCleanup = useMemoryStore((s) => s.previewCleanup)
  const applyCleanup = useMemoryStore((s) => s.applyCleanup)
  const undoCleanup = useMemoryStore((s) => s.undoCleanup)
  const loadCleanupRuns = useMemoryStore((s) => s.loadCleanupRuns)

  useEffect(() => {
    if (workspaceId) void loadCleanupRuns(workspaceId)
  }, [workspaceId, loadCleanupRuns])

  const handlePreview = useCallback(
    () => void previewCleanup(workspaceId),
    [workspaceId, previewCleanup]
  )
  const handleApply = useCallback(() => void applyCleanup(workspaceId), [workspaceId, applyCleanup])
  const handleUndo = useCallback(() => void undoCleanup(workspaceId), [workspaceId, undoCleanup])

  const busy = cleanupPreviewing || cleanupApplying

  return (
    <div className="space-y-4">
      <SettingsCard>
        <PanelHeader
          title="Cleanup"
          description="Archive memories nothing has used, permanently remove long-expired ones, and compact the retrieval log. Preview first — the numbers are the point."
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={handlePreview} disabled={busy}>
            {cleanupPreviewing ? 'Scanning…' : 'Preview cleanup'}
          </Button>
          <Button
            variant="danger"
            onClick={handleApply}
            disabled={busy || !cleanupPreview}
            title={cleanupPreview ? undefined : 'Run a preview first'}
          >
            {cleanupApplying ? 'Applying…' : 'Apply'}
          </Button>
          {cleanupUndoable && (
            <Button variant="secondary" onClick={handleUndo} disabled={busy}>
              Undo last sweep ({cleanupUndoable.undoableCount})
            </Button>
          )}
        </div>

        {cleanupProgress && (
          <p className="mt-3 text-xs text-text-muted">{cleanupProgress.message}</p>
        )}

        {cleanupError && (
          <p className="mt-3 rounded-md border border-danger/30 bg-danger-muted px-3 py-2 text-xs text-danger">
            {cleanupError}
          </p>
        )}
      </SettingsCard>

      {cleanupPreview && (
        <SettingsCard>
          <PanelHeader
            title="Preview"
            description="Nothing below has happened yet. Everything except the tombstone bucket can be undone for 7 days after applying."
          />
          <div className="mt-3">
            <PreviewReport preview={cleanupPreview} />
          </div>
        </SettingsCard>
      )}
    </div>
  )
}
