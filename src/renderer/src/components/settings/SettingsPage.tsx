import { useState, useEffect, useCallback } from 'react'
import {
  ArrowLeft,
  Settings,
  RefreshCw,
  Download,
  CheckCircle2,
  GripVertical,
  ChevronUp,
  ChevronDown,
  Loader2
} from 'lucide-react'
import type { SchedulingWeights } from '../../../../shared/types'
import {
  useUpdateStore,
  useSpecialistStore,
  useAppPreferenceActions,
  useSpecialistWarningPreferences,
  useAppPreferenceStatus
} from '@renderer/store'
import { Avatar, PixelSpriteAvatar } from '@renderer/components/common'
import { getDefaultAvatarForRole } from '@renderer/utils/agentIdentity'
import type { Specialist } from '../../../../shared/types'
import AISubscriptionsSection from './AISubscriptionsSection'

function UpdateButton(): React.JSX.Element {
  const { status, availableVersion, checkForUpdates, installUpdate } = useUpdateStore()

  if (status === 'ready') {
    return (
      <button
        onClick={installUpdate}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-success border border-success/30 hover:bg-success-muted transition-colors"
      >
        <CheckCircle2 size={12} />
        Install Update (v{availableVersion})
      </button>
    )
  }

  if (status === 'available') {
    return (
      <button
        onClick={() => useUpdateStore.getState().downloadUpdate()}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-primary-text border border-primary/30 hover:bg-primary-muted transition-colors"
      >
        <Download size={12} />
        Download v{availableVersion}
      </button>
    )
  }

  return (
    <button
      onClick={checkForUpdates}
      disabled={status === 'checking' || status === 'downloading'}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary border border-border-subtle hover:bg-surface-overlay hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <RefreshCw size={12} className={status === 'checking' ? 'animate-spin' : ''} />
      {status === 'checking'
        ? 'Checking...'
        : status === 'downloading'
          ? 'Downloading...'
          : 'Check for Updates'}
    </button>
  )
}

interface SettingsPageProps {
  onBack: () => void
}

function SpecialistWarningPreferencesSection(): React.JSX.Element {
  const { specialistWarningBuild, specialistWarningPlan, specialistWarningAlways } =
    useSpecialistWarningPreferences()
  const { loadPreferences, setPreference } = useAppPreferenceActions()
  const { isLoading, savingKeys, error } = useAppPreferenceStatus()

  useEffect(() => {
    void loadPreferences().catch((loadError) => {
      console.error('Failed to load specialist warning preferences:', loadError)
    })
  }, [loadPreferences])

  const rows: Array<{
    key: 'specialistWarningBuild' | 'specialistWarningPlan' | 'specialistWarningAlways'
    label: string
    description: string
    checked: boolean
  }> = [
    {
      key: 'specialistWarningBuild',
      label: 'Build mode warnings',
      description: 'Warn before build actions when specialist activation can increase token usage.',
      checked: specialistWarningBuild
    },
    {
      key: 'specialistWarningPlan',
      label: 'Plan mode warnings',
      description: 'Warn before plan actions when specialist activation can increase token usage.',
      checked: specialistWarningPlan
    },
    {
      key: 'specialistWarningAlways',
      label: 'Always show warning dialog',
      description:
        'Always show specialist warning dialog regardless of mode-specific warning toggles.',
      checked: specialistWarningAlways
    }
  ]

  return (
    <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-text-primary">Specialist Activation Warnings</h4>
          <p className="text-xs text-text-secondary mt-0.5">
            Control when confirmation dialogs appear before specialist-enhanced actions.
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {isLoading ? (
          <div className="text-xs text-text-muted flex items-center gap-1.5">
            <Loader2 size={12} className="animate-spin" />
            Loading preferences...
          </div>
        ) : (
          rows.map((row) => {
            const isSavingRow = savingKeys[row.key] ?? false
            return (
              <div
                key={row.key}
                className="flex items-center justify-between gap-4 rounded-lg border border-border-subtle bg-surface-base px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-sm text-text-body">{row.label}</p>
                  <p className="text-xs text-text-secondary">{row.description}</p>
                </div>

                <button
                  onClick={() => {
                    void setPreference(row.key, !row.checked).catch((setError) => {
                      console.error(`Failed to update preference "${row.key}":`, setError)
                    })
                  }}
                  disabled={isSavingRow}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                    row.checked ? 'bg-primary' : 'bg-surface-base border border-border-default'
                  }`}
                  role="switch"
                  aria-checked={row.checked}
                  aria-label={row.label}
                >
                  <span
                    className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                      row.checked ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            )
          })
        )}
      </div>

      {error && (
        <p className="text-xs text-danger mt-3">Failed to update warning preferences: {error}</p>
      )}
    </div>
  )
}

function SpecialistOrder(): React.JSX.Element {
  const { specialists, reorderSpecialists } = useSpecialistStore()
  const [orderedList, setOrderedList] = useState<Specialist[]>([])
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  // Initialize from active specialists sorted by priority (exclude user — always priority -1)
  useEffect(() => {
    const active = [...specialists]
      .filter((s) => s.isActive && s.agentId !== 'user')
      .sort((a, b) => a.priority - b.priority)
    setOrderedList(active)
  }, [specialists])

  const handleDragStart = (index: number): void => {
    setDraggedIndex(index)
  }

  const handleDragOver = (e: React.DragEvent, index: number): void => {
    e.preventDefault()
    if (draggedIndex === null || draggedIndex === index) return
    const updated = [...orderedList]
    const [moved] = updated.splice(draggedIndex, 1)
    updated.splice(index, 0, moved)
    setOrderedList(updated)
    setDraggedIndex(index)
  }

  const handleDragEnd = async (): Promise<void> => {
    setDraggedIndex(null)
    setIsSaving(true)
    try {
      await reorderSpecialists(orderedList.map((s) => s.id))
    } finally {
      setIsSaving(false)
    }
  }

  const moveItem = useCallback(
    async (from: number, to: number) => {
      const updated = [...orderedList]
      const [moved] = updated.splice(from, 1)
      updated.splice(to, 0, moved)
      setOrderedList(updated)
      setIsSaving(true)
      try {
        await reorderSpecialists(updated.map((s) => s.id))
      } finally {
        setIsSaving(false)
      }
    },
    [orderedList, reorderSpecialists]
  )

  if (orderedList.length === 0) return <></>

  return (
    <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
      <h4 className="text-sm font-medium text-text-primary">Specialist Priority Order</h4>
      <p className="text-xs text-text-secondary mt-0.5 mb-4">
        Drag to reorder. Specialists listed first are presented first to the generalist when
        decomposing tasks into sub-tasks.
      </p>
      <div className="space-y-1">
        {orderedList.map((specialist, index) => (
          <div
            key={specialist.id}
            draggable
            onDragStart={() => handleDragStart(index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDragEnd={handleDragEnd}
            className={`
              flex items-center gap-3 px-3 py-2 rounded-lg border transition-all cursor-grab active:cursor-grabbing
              ${
                draggedIndex === index
                  ? 'border-primary/50 bg-primary/5 scale-[1.02] shadow-md'
                  : 'border-border-subtle bg-surface-base hover:bg-surface-overlay'
              }
            `}
          >
            <GripVertical size={14} className="text-text-muted flex-shrink-0" />
            <span className="text-xs text-text-muted w-5 font-mono">{index + 1}</span>
            {specialist.usePixelForChat && specialist.pixelSpriteId ? (
              <PixelSpriteAvatar spriteId={specialist.pixelSpriteId} size={24} />
            ) : (
              <Avatar
                avatarKey={specialist.avatarUrl ?? getDefaultAvatarForRole(specialist.agentId)}
                size="sm"
                accentColor={specialist.color}
              />
            )}
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text-primary">
                {specialist.displayName}
              </span>
              {specialist.alias && (
                <span className="text-xs text-text-muted ml-1.5">({specialist.alias})</span>
              )}
            </div>
            {/* Up/Down buttons for accessibility */}
            <div className="flex flex-col gap-0.5">
              <button
                disabled={index === 0}
                onClick={() => moveItem(index, index - 1)}
                className="p-0.5 rounded hover:bg-surface-float disabled:opacity-20"
              >
                <ChevronUp size={12} />
              </button>
              <button
                disabled={index === orderedList.length - 1}
                onClick={() => moveItem(index, index + 1)}
                className="p-0.5 rounded hover:bg-surface-float disabled:opacity-20"
              >
                <ChevronDown size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {isSaving && (
        <p className="text-[11px] text-text-muted mt-2 flex items-center gap-1">
          <Loader2 size={10} className="animate-spin" /> Saving order...
        </p>
      )}
    </div>
  )
}

const WEIGHT_LABELS: Record<keyof SchedulingWeights, { label: string; description: string }> = {
  dependencyFirst: {
    label: 'Dependency First',
    description: 'Prioritize tasks whose dependencies are already complete.'
  },
  capabilityMatch: {
    label: 'Capability Match',
    description: 'Assign tasks to the best-suited specialist by skill match.'
  },
  leastBusy: {
    label: 'Least Busy',
    description: 'Distribute tasks to idle specialists for better parallelism.'
  }
}

function SchedulingStrategySection(): React.JSX.Element {
  const [weights, setWeights] = useState<SchedulingWeights>({
    dependencyFirst: 0.6,
    capabilityMatch: 0.3,
    leastBusy: 0.1
  })
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    window.api
      .getSchedulingWeights()
      .then((w) => {
        setWeights(w)
        setIsLoading(false)
      })
      .catch(() => setIsLoading(false))
  }, [])

  const handleChange = useCallback(
    (key: keyof SchedulingWeights, value: number) => {
      const updated = { ...weights, [key]: value }
      // Normalize: distribute remaining budget proportionally among other keys
      const others = (Object.keys(updated) as (keyof SchedulingWeights)[]).filter((k) => k !== key)
      const remaining = Math.max(0, 1.0 - value)
      const otherSum = others.reduce((s, k) => s + weights[k], 0)
      for (const k of others) {
        updated[k] = otherSum > 0 ? (weights[k] / otherSum) * remaining : remaining / others.length
      }
      // Round to 2 decimal places to avoid floating point drift
      for (const k of Object.keys(updated) as (keyof SchedulingWeights)[]) {
        updated[k] = Math.round(updated[k] * 100) / 100
      }
      setWeights(updated)
      window.api.setSchedulingWeights(updated).catch((err) => {
        console.error('Failed to save scheduling weights:', err)
      })
    },
    [weights]
  )

  return (
    <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
      <div>
        <h4 className="text-sm font-medium text-text-primary">Scheduling Strategy</h4>
        <p className="text-xs text-text-secondary mt-0.5">
          Adjust how tasks are prioritized and assigned to specialists. Weights auto-normalize to
          100%.
        </p>
      </div>

      <div className="mt-4 space-y-3">
        {isLoading ? (
          <div className="text-xs text-text-muted flex items-center gap-1.5">
            <Loader2 size={12} className="animate-spin" />
            Loading weights...
          </div>
        ) : (
          (Object.keys(WEIGHT_LABELS) as (keyof SchedulingWeights)[]).map((key) => (
            <div
              key={key}
              className="rounded-lg border border-border-subtle bg-surface-base px-3 py-2.5"
            >
              <div className="flex items-center justify-between mb-1">
                <div className="min-w-0">
                  <p className="text-sm text-text-body">{WEIGHT_LABELS[key].label}</p>
                  <p className="text-xs text-text-secondary">{WEIGHT_LABELS[key].description}</p>
                </div>
                <span className="text-xs font-mono text-text-muted ml-3 whitespace-nowrap">
                  {Math.round(weights[key] * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(weights[key] * 100)}
                onChange={(e) => handleChange(key, Number(e.target.value) / 100)}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-primary bg-surface-float"
              />
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default function SettingsPage({ onBack }: SettingsPageProps): React.JSX.Element {
  return (
    <div className="flex-1 flex flex-col bg-surface-raised min-w-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border-subtle bg-surface-raised">
        <button
          onClick={onBack}
          className="p-1.5 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
          aria-label="Back to chat"
          title="Back to chat"
        >
          <ArrowLeft size={16} />
        </button>
        <Settings size={16} className="text-primary-text" />
        <span className="text-sm font-semibold text-text-primary">App Settings</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-8">
          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-text-primary mb-2">Application</h3>
              <p className="text-xs text-text-secondary">
                App-level settings and updates. Agents and skills are managed per workspace in
                Workspace Settings.
              </p>
            </div>

            {/* AI Subscriptions section */}
            <AISubscriptionsSection />

            {/* Specialist warning preferences */}
            <SpecialistWarningPreferencesSection />

            {/* Scheduling Strategy Weights */}
            <SchedulingStrategySection />

            {/* Specialist Priority Order */}
            <SpecialistOrder />

            {/* Update section */}
            <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-medium text-text-primary">Updates</h4>
                  <p className="text-xs text-text-secondary mt-0.5">
                    Check for and install application updates
                  </p>
                </div>
                <UpdateButton />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
