/**
 * SpecialistHeroBanner — Avatar, metadata, and rebuild button with gradient background.
 */

import { Loader2, CheckCircle, Hammer, XCircle, Brain, AlertTriangle } from 'lucide-react'
import { Avatar } from '@renderer/components/common'
import type {
  SpecialistBuildMethod,
  SpecialistIngestionState
} from '@renderer/store/project-specialist.store'

// ── Types ────────────────────────────────────────────────────────────────────

type RebuildState = 'idle' | 'building' | 'success' | 'failed'

interface SpecialistHeroBannerProps {
  displayName: string
  buildStatus: 'pending' | 'building' | 'ready' | 'failed'
  lastBuiltAt?: string | null
  buildMethod?: SpecialistBuildMethod | null
  ingestion?: SpecialistIngestionState | null
  color?: string | null
  mannequinKey: string
  rebuildState: RebuildState
  rebuildError: string | null
  progressMessage?: string | null
  storeError: string | null
  onRebuild: () => void
  onClearError: () => void
  /** Route the user to Brain → Bootstrap Project Knowledge. */
  onGoToIngestion: () => void
}

// ── Component ────────────────────────────────────────────────────────────────

export function SpecialistHeroBanner({
  displayName,
  buildStatus,
  lastBuiltAt,
  buildMethod,
  ingestion,
  color,
  mannequinKey,
  rebuildState,
  rebuildError,
  progressMessage,
  storeError,
  onRebuild,
  onClearError,
  onGoToIngestion
}: SpecialistHeroBannerProps): React.JSX.Element {
  // Absent ingestion state (read failure) must not lock the user out.
  const ingestionBlocked = ingestion != null && !ingestion.satisfied

  return (
    <>
      {/* ── Hero Banner ──────────────────────────────────────────────── */}
      <div className="relative rounded-2xl overflow-hidden bg-surface-overlay border border-border-subtle">
        {/* Radial gradient background — brand gold accent */}
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(ellipse at 30% 50%,
              var(--color-specialist-glow) 0%,
              var(--color-specialist-mid) 40%,
              transparent 70%)`
          }}
        />

        <div className="relative flex items-center gap-6 p-8">
          {/* Large avatar — rounded rectangle */}
          <div className="flex-shrink-0">
            <Avatar
              avatarKey={mannequinKey}
              size="xxl"
              className="!rounded-2xl"
              accentColor={color ?? '#B8976A'}
            />
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-text-primary mb-1">{displayName}</h2>
            <div className="flex items-center gap-2 mb-3">
              <StatusBadge status={buildStatus} />
              {buildStatus === 'ready' && <ProvenanceBadge method={buildMethod ?? null} />}
              {lastBuiltAt && (
                <span className="text-[11px] text-text-muted">
                  Built {new Date(lastBuiltAt).toLocaleDateString()}
                </span>
              )}
            </div>
            <p className="text-xs text-text-secondary">
              {ingestion?.satisfied && ingestion.finishedAt
                ? `Last ingestion: ${new Date(ingestion.finishedAt).toLocaleDateString()} · ${ingestion.factsCreated} facts`
                : 'Tailored specialist for this workspace'}
            </p>
          </div>

          {/* Rebuild button — top right area */}
          <div className="flex-shrink-0 self-start">
            <RebuildButton
              state={rebuildState}
              onClick={onRebuild}
              progressMessage={progressMessage}
              disabled={ingestionBlocked}
            />
          </div>
        </div>
      </div>

      {/* Ingestion gate — the build is refused in main, so say why here. */}
      {ingestionBlocked && (
        <div
          data-testid="specialist-ingestion-gate"
          className="flex items-start gap-2 p-3 rounded-lg bg-info-muted border border-info/20"
        >
          <Brain size={14} className="text-info flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-info font-medium">Deep Ingestion required</p>
            <p className="text-[11px] text-text-secondary mt-0.5">
              This specialist can only be tailored after the project knowledge bootstrap has run.
              Until then it falls back to a generic persona.
            </p>
          </div>
          <button
            onClick={onGoToIngestion}
            className="text-[11px] font-medium text-primary hover:text-primary-text px-2 py-1 rounded hover:bg-primary-muted transition-colors flex-shrink-0"
          >
            Bootstrap Knowledge
          </button>
        </div>
      )}

      {/* Error banner */}
      {rebuildState === 'failed' && rebuildError && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-danger-muted border border-danger/20">
          <XCircle size={14} className="text-danger flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-danger font-medium">Build failed</p>
            <p className="text-[11px] text-text-secondary mt-0.5 break-words">{rebuildError}</p>
          </div>
          <button
            onClick={onRebuild}
            className="text-[11px] font-medium text-primary hover:text-primary-text px-2 py-1 rounded hover:bg-primary-muted transition-colors flex-shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* Store-level error (from other operations) */}
      {storeError && rebuildState !== 'failed' && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-danger-muted border border-danger/20">
          <XCircle size={14} className="text-danger flex-shrink-0" />
          <p className="text-xs text-danger flex-1">{storeError}</p>
          <button onClick={onClearError} className="text-xs text-text-muted hover:text-text-body">
            Dismiss
          </button>
        </div>
      )}
    </>
  )
}

// ── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({
  status
}: {
  status: 'pending' | 'building' | 'ready' | 'failed'
}): React.JSX.Element {
  const config = {
    pending: { label: 'Pending', className: 'bg-surface-overlay text-text-muted' },
    building: { label: 'Building…', className: 'bg-info-muted text-info' },
    ready: { label: 'Ready', className: 'bg-success-muted text-success' },
    failed: { label: 'Failed', className: 'bg-danger-muted text-danger' }
  } as const

  const { label, className } = config[status]
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium ${className}`}
    >
      {status === 'building' && <Loader2 size={10} className="mr-1 animate-spin" />}
      {status === 'ready' && (
        <span className="mr-1 w-1.5 h-1.5 rounded-full bg-success inline-block" />
      )}
      {label}
    </span>
  )
}

/**
 * Makes a degraded build visible. A `skeleton` result previously rendered as a
 * plain green "Ready", indistinguishable from a genuinely tailored specialist.
 */
function ProvenanceBadge({
  method
}: {
  method: SpecialistBuildMethod | null
}): React.JSX.Element | null {
  if (method === null) return null

  const config = {
    agentic: {
      label: 'Tailored (agentic)',
      className: 'bg-success-muted text-success',
      warn: false
    },
    oneshot: { label: 'Tailored (one-shot)', className: 'bg-info-muted text-info', warn: false },
    skeleton: { label: 'Generic fallback', className: 'bg-danger-muted text-danger', warn: true }
  } as const

  const { label, className, warn } = config[method]
  return (
    <span
      data-testid="specialist-provenance-badge"
      title={
        warn
          ? 'Prompt tailoring failed — this specialist is the generic template, not project-specific.'
          : undefined
      }
      className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium ${className}`}
    >
      {warn && <AlertTriangle size={10} className="mr-1" />}
      {label}
    </span>
  )
}

function RebuildButton({
  state,
  onClick,
  progressMessage,
  disabled
}: {
  state: RebuildState
  onClick: () => void
  progressMessage?: string | null
  disabled?: boolean
}): React.JSX.Element {
  if (state === 'building') {
    return (
      <button
        disabled
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-surface-overlay text-text-secondary cursor-not-allowed"
      >
        <Loader2 size={14} className="animate-spin" />
        <span className="max-w-[160px] truncate">{progressMessage ?? 'Rebuilding…'}</span>
      </button>
    )
  }

  if (state === 'success') {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-success-muted text-success animate-in fade-in">
        <CheckCircle size={14} />
        Ready
      </div>
    )
  }

  return (
    <button
      data-testid="specialist-rebuild-btn"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? 'Run Brain → Bootstrap Project Knowledge first' : undefined}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
        disabled
          ? 'bg-surface-overlay text-text-muted cursor-not-allowed'
          : 'bg-primary text-white hover:bg-primary/90'
      }`}
    >
      <Hammer size={14} />
      Rebuild
    </button>
  )
}
