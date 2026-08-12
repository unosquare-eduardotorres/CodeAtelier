/**
 * StartIndexingModal — confirmation dialog before starting the indexing pipeline.
 *
 * Shows estimated time breakdown based on symbol count, warns about duration,
 * and reassures that progress is checkpointed for resume-after-crash.
 *
 * Also runs the exclusion preflight so vendored trees (Pods, Carthage, bin,
 * obj, ...) are visible BEFORE indexing spends hours on them. Ambiguous
 * directories (lib, libs, Library) are never excluded without a checkbox.
 * If the preflight fails or times out the section simply renders nothing —
 * it must never block indexing.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  X,
  Clock,
  HardDrive,
  Cpu,
  Sparkles,
  Loader2,
  FolderMinus,
  ChevronDown,
  ChevronRight,
  AlertTriangle
} from 'lucide-react'
import type { ExclusionCandidate, ExclusionPreflightResult } from '../../../../../shared/types'

interface StartIndexingModalProps {
  /** Workspace whose exclusions are reviewed */
  workspaceId: string
  /** Estimated total symbols (from last scan or a quick count) */
  symbolCount: number
  /** Whether AI descriptions are enabled */
  aiDescriptionsEnabled: boolean
  /** Review exclusions only — no time estimates, no indexing start */
  reviewOnly?: boolean
  /** Callback when user confirms */
  onConfirm: () => void
  /** Callback when user cancels */
  onCancel: () => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/**
 * Estimate time for each indexing phase based on observed throughput.
 *
 * Throughput constants (from production logs):
 *   - Preprocessing: ~500 chunks/second (heuristic descriptions)
 *   - Embedding (WASM, single-threaded): ~5 chunks/second → 300 chunks/minute
 *   - AI Descriptions (Claude Haiku): ~100 chunks/minute (batched)
 */
function estimateTime(
  symbolCount: number,
  aiDescriptions: boolean
): {
  preprocessMinutes: number
  embeddingMinutes: number
  aiDescMinutes: number
  totalMinutes: number
  formatted: {
    preprocessing: string
    embedding: string
    aiDescriptions: string | null
    total: string
  }
} {
  const preprocessMinutes = Math.max(1, Math.ceil(symbolCount / 500 / 60))
  const embeddingMinutes = Math.max(1, Math.ceil(symbolCount / 300))
  const aiDescMinutes = aiDescriptions ? Math.max(1, Math.ceil(symbolCount / 100)) : 0
  const totalMinutes = preprocessMinutes + embeddingMinutes + aiDescMinutes

  return {
    preprocessMinutes,
    embeddingMinutes,
    aiDescMinutes,
    totalMinutes,
    formatted: {
      preprocessing: formatDuration(preprocessMinutes),
      embedding: formatDuration(embeddingMinutes),
      aiDescriptions: aiDescriptions ? formatDuration(aiDescMinutes) : null,
      total: formatDuration(totalMinutes)
    }
  }
}

function formatDuration(minutes: number): string {
  if (minutes < 2) return '~1 minute'
  if (minutes < 60) return `~${minutes} minutes`
  const hours = (minutes / 60).toFixed(1)
  return `~${hours} hours`
}

/** Renders one confirm-me row with its evidence. */
function CandidateRow({
  candidate,
  checked,
  onToggle
}: {
  candidate: ExclusionCandidate
  checked: boolean
  onToggle: () => void
}): React.JSX.Element {
  const looksFirstParty = candidate.gitTracked && candidate.vendorMarkers.length === 0
  return (
    <label className="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-surface-overlay cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-0.5 accent-primary"
      />
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2 flex-wrap">
          <code className="text-xs text-text-primary">{candidate.relPath}/</code>
          {looksFirstParty && (
            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30">
              <AlertTriangle size={9} />
              Contains source code committed to git
            </span>
          )}
        </span>
        <span className="block text-[11px] text-text-muted mt-0.5">
          {candidate.fileCount.toLocaleString()} files · {formatBytes(candidate.totalBytes)}
          {candidate.extensions.length > 0 &&
            ` · mostly ${candidate.extensions
              .slice(0, 3)
              .map((e) => e.ext)
              .join(', ')}`}{' '}
          — {candidate.reason}
        </span>
      </span>
    </label>
  )
}

export default function StartIndexingModal({
  workspaceId,
  symbolCount,
  aiDescriptionsEnabled,
  reviewOnly = false,
  onConfirm,
  onCancel
}: StartIndexingModalProps): React.JSX.Element {
  const est = estimateTime(symbolCount, aiDescriptionsEnabled)

  const [preflight, setPreflight] = useState<ExclusionPreflightResult | null>(null)
  const [preflightLoading, setPreflightLoading] = useState(true)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [showAuto, setShowAuto] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api
      .indexingPreflightExclusions({ workspaceId })
      .then((result) => {
        if (cancelled) return
        setPreflight(result)
        setChecked(
          new Set(
            result.candidates
              .filter((c) => c.verdict === 'needs-confirmation' && c.defaultChecked)
              .map((c) => c.suggestedRule)
          )
        )
      })
      .catch((err) => {
        // Never block indexing on a preflight failure.
        console.warn('[StartIndexingModal] Non-fatal: exclusion preflight failed:', err)
        if (!cancelled) setPreflight(null)
      })
      .finally(() => {
        if (!cancelled) setPreflightLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const autoCandidates = preflight?.candidates.filter((c) => c.verdict === 'auto-exclude') ?? []
  const confirmCandidates =
    preflight?.candidates.filter((c) => c.verdict === 'needs-confirmation') ?? []

  const skippedFiles =
    autoCandidates.reduce((sum, c) => sum + c.fileCount, 0) +
    confirmCandidates.reduce((sum, c) => sum + (checked.has(c.suggestedRule) ? c.fileCount : 0), 0)
  const skippedBytes =
    autoCandidates.reduce((sum, c) => sum + c.totalBytes, 0) +
    confirmCandidates.reduce((sum, c) => sum + (checked.has(c.suggestedRule) ? c.totalBytes : 0), 0)

  const toggle = useCallback((rule: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(rule)) next.delete(rule)
      else next.add(rule)
      return next
    })
  }, [])

  const handleConfirm = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      if (checked.size > 0) {
        await window.api.indexingApplyExclusions({ workspaceId, patterns: [...checked] })
      }
    } catch (err) {
      console.warn('[StartIndexingModal] Non-fatal: applying exclusions failed:', err)
    }
    setBusy(false)
    onConfirm()
  }, [checked, workspaceId, onConfirm])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        data-testid="start-indexing-modal"
        className="relative bg-surface-panel border border-border-subtle rounded-xl shadow-2xl w-[480px] max-w-[90vw] overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <h2 className="text-sm font-semibold text-text-primary">
            {reviewOnly ? 'Review Exclusions' : 'Start Indexing'}
          </h2>
          <button
            onClick={onCancel}
            className="p-1 rounded hover:bg-surface-overlay text-text-muted hover:text-text-secondary transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4 max-h-[65vh] overflow-y-auto">
          {/* ── Exclusion preflight ── */}
          {preflightLoading ? (
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <Loader2 size={12} className="animate-spin" />
              <span>Scanning for vendored and generated directories…</span>
            </div>
          ) : (
            preflight !== null &&
            (autoCandidates.length > 0 || confirmCandidates.length > 0) && (
              <div
                data-testid="exclusion-preflight"
                className="space-y-2 bg-surface-base rounded-lg p-3 border border-border-subtle"
              >
                {autoCandidates.length > 0 && (
                  <div>
                    <button
                      onClick={() => setShowAuto(!showAuto)}
                      className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
                    >
                      {showAuto ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      <FolderMinus size={11} className="text-cyan-400" />
                      <span>
                        Will be excluded:{' '}
                        {[...new Set(autoCandidates.map((c) => c.dirName))].slice(0, 4).join(', ')}
                        {new Set(autoCandidates.map((c) => c.dirName)).size > 4 ? ', …' : ''} —{' '}
                        {autoCandidates.reduce((s, c) => s + c.fileCount, 0).toLocaleString()} files
                        skipped
                      </span>
                    </button>
                    {showAuto && (
                      <ul className="mt-1.5 ml-5 space-y-0.5">
                        {autoCandidates.map((c) => (
                          <li key={c.relPath} className="text-[11px] text-text-muted">
                            <code className="text-text-secondary">{c.relPath}/</code> —{' '}
                            {c.fileCount.toLocaleString()} files, {formatBytes(c.totalBytes)} —{' '}
                            {c.reason}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {confirmCandidates.length > 0 && (
                  <div className="pt-1 border-t border-border-subtle">
                    <p className="text-xs font-medium text-text-primary mb-1">
                      Please confirm — these could be your own code
                    </p>
                    <div className="space-y-0.5">
                      {confirmCandidates.map((c) => (
                        <CandidateRow
                          key={c.relPath}
                          candidate={c}
                          checked={checked.has(c.suggestedRule)}
                          onToggle={() => toggle(c.suggestedRule)}
                        />
                      ))}
                    </div>
                    <p className="text-[11px] text-text-muted mt-1">
                      Checked directories are written to{' '}
                      <code className="text-text-secondary">.atelierignore</code> and apply to both
                      the code graph and semantic search.
                    </p>
                  </div>
                )}
              </div>
            )
          )}

          {!reviewOnly && (
            <p className="text-sm text-text-secondary">
              Indexing will run in the background based on{' '}
              <strong className="text-text-primary">{symbolCount.toLocaleString()} symbols</strong>:
            </p>
          )}

          {/* Phase estimates */}
          {!reviewOnly && (
            <div className="space-y-2 bg-surface-base rounded-lg p-3 border border-border-subtle">
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <Cpu size={12} className="text-cyan-400 shrink-0" />
                <span className="flex-1">Preprocessing + heuristic descriptions</span>
                <span className="text-text-muted font-mono">{est.formatted.preprocessing}</span>
              </div>

              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <HardDrive size={12} className="text-blue-400 shrink-0" />
                <span className="flex-1">Embedding (WASM, off main thread)</span>
                <span className="text-text-muted font-mono">{est.formatted.embedding}</span>
              </div>

              {aiDescriptionsEnabled && est.formatted.aiDescriptions && (
                <div className="flex items-center gap-2 text-xs text-text-secondary">
                  <Sparkles size={12} className="text-purple-400 shrink-0" />
                  <span className="flex-1">AI Descriptions (Claude Haiku)</span>
                  <span className="text-text-muted font-mono">{est.formatted.aiDescriptions}</span>
                </div>
              )}

              <div className="flex items-center gap-2 text-xs font-medium text-text-primary pt-1 border-t border-border-subtle">
                <Clock size={12} className="text-text-muted shrink-0" />
                <span className="flex-1">Estimated total</span>
                <span className="font-mono">{est.formatted.total}</span>
              </div>
            </div>
          )}

          {/* Reassurance */}
          {!reviewOnly && (
            <div className="text-xs text-text-muted space-y-1.5">
              <p>✓ You can keep using the app normally — embedding runs in a separate process.</p>
              <p>
                ✓ Progress is saved every ~5 minutes — if you close the app, indexing will resume
                where it left off.
              </p>
              <p>
                ✓ Search becomes available immediately with heuristic descriptions while embedding
                continues.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border-subtle bg-surface-base/50">
          {skippedFiles > 0 && (
            <span className="mr-auto text-[11px] text-text-muted">
              Skipping {skippedFiles.toLocaleString()} files (~{formatBytes(skippedBytes)})
            </span>
          )}
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary rounded-md hover:bg-surface-overlay transition-colors"
          >
            Cancel
          </button>
          <button
            data-testid="start-indexing-confirm"
            onClick={handleConfirm}
            disabled={busy}
            className="px-4 py-1.5 text-xs font-medium text-white bg-primary hover:bg-primary-hover rounded-md transition-colors disabled:opacity-50"
          >
            {reviewOnly ? 'Save Exclusions' : 'Start Indexing'}
          </button>
        </div>
      </div>
    </div>
  )
}
