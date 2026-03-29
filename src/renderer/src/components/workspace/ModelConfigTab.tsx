import { useState, useEffect, useCallback } from 'react'
import { RotateCcw, Info, Zap, Coins, Scale, Rocket } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'
import { SettingsCard } from '@renderer/components/common'
import { DEFAULT_MODEL_CONFIG, MODEL_ACTIONS_META } from '../../../../shared/constants'
import type { ModelAction, ModelOverrides, CostPreference } from '../../../../shared/types'
import ModelSelector from './ModelSelector'

const COST_PREF_ICON: Record<CostPreference, React.ReactNode> = {
  economy: <Coins size={16} />,
  balanced: <Scale size={16} />,
  power: <Rocket size={16} />
}

/** All model actions grouped by section */
const SECTIONS: { key: string; label: string; description: string; actions: ModelAction[] }[] = [
  {
    key: 'agent',
    label: 'Agent Models',
    description: 'Configure which model powers each agent type',
    actions: ['generalist', 'orchestrator']
  },
  {
    key: 'specialist',
    label: 'Specialist Routing',
    description: 'Models assigned to tasks by complexity tier',
    actions: ['specialist:simple', 'specialist:moderate', 'specialist:complex']
  },
  {
    key: 'background',
    label: 'Background Tasks',
    description: 'Models for automated background processes',
    actions: ['dream', 'memoryFeed', 'activation']
  }
]

export default function ModelConfigTab(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const [overrides, setOverrides] = useState<ModelOverrides>({})
  const [isSaving, setIsSaving] = useState(false)
  const [costPreference, setCostPreference] = useState<CostPreference>('balanced')
  const [fastMode, setFastMode] = useState(false)
  const [dailyBudget, setDailyBudget] = useState<number>(0)
  const [sessionBudget, setSessionBudget] = useState<number>(0)

  // Load current overrides + workspace settings
  useEffect(() => {
    if (!activeWorkspace) return
    window.api
      .getWorkspaceSettings({ workspaceId: activeWorkspace.id })
      .then((settings) => {
        setOverrides((settings.modelOverrides as ModelOverrides) ?? {})
        setCostPreference((settings.costPreference as CostPreference) || 'balanced')
        setFastMode(settings.fastMode === true)
        setDailyBudget((settings.dailyBudgetUsd as number) ?? 0)
        setSessionBudget((settings.sessionBudgetUsd as number) ?? 0)
      })
      .catch(console.error)
  }, [activeWorkspace])

  /** Persist overrides to workspace settings_json */
  const saveOverrides = useCallback(
    async (newOverrides: ModelOverrides) => {
      if (!activeWorkspace) return
      setIsSaving(true)
      try {
        const settings = await window.api.getWorkspaceSettings({
          workspaceId: activeWorkspace.id
        })
        await window.api.updateWorkspaceSettings({
          workspaceId: activeWorkspace.id,
          settings: { ...settings, modelOverrides: newOverrides }
        })
      } catch (err) {
        console.error('Failed to save model overrides:', err)
      } finally {
        setIsSaving(false)
      }
    },
    [activeWorkspace]
  )

  const handleChange = useCallback(
    (action: ModelAction, modelId: string) => {
      const next = { ...overrides }
      if (modelId === DEFAULT_MODEL_CONFIG[action]) {
        delete next[action]
      } else {
        next[action] = modelId
      }
      setOverrides(next)
      saveOverrides(next)
    },
    [overrides, saveOverrides]
  )

  const handleReset = useCallback(
    (action: ModelAction) => {
      const next = { ...overrides }
      delete next[action]
      setOverrides(next)
      saveOverrides(next)
    },
    [overrides, saveOverrides]
  )

  const handleResetAll = useCallback(() => {
    setOverrides({})
    saveOverrides({})
  }, [saveOverrides])

  const handleCostPreferenceChange = async (pref: CostPreference): Promise<void> => {
    setCostPreference(pref)
    if (activeWorkspace) {
      const settings = await window.api.getWorkspaceSettings({ workspaceId: activeWorkspace.id })
      await window.api.updateWorkspaceSettings({
        workspaceId: activeWorkspace.id,
        settings: { ...settings, costPreference: pref }
      })
    }
  }

  const handleFastModeToggle = async (): Promise<void> => {
    const newValue = !fastMode
    setFastMode(newValue)
    if (activeWorkspace) {
      const settings = await window.api.getWorkspaceSettings({ workspaceId: activeWorkspace.id })
      await window.api.updateWorkspaceSettings({
        workspaceId: activeWorkspace.id,
        settings: { ...settings, fastMode: newValue }
      })
    }
  }

  const handleBudgetChange = async (
    field: 'dailyBudgetUsd' | 'sessionBudgetUsd',
    value: number
  ): Promise<void> => {
    const clamped = Math.max(0, value)
    if (field === 'dailyBudgetUsd') setDailyBudget(clamped)
    else setSessionBudget(clamped)

    if (activeWorkspace) {
      try {
        const settings = await window.api.getWorkspaceSettings({ workspaceId: activeWorkspace.id })
        await window.api.updateWorkspaceSettings({
          workspaceId: activeWorkspace.id,
          settings: { ...settings, [field]: clamped }
        })
      } catch (err) {
        console.error('Failed to save budget setting:', err)
      }
    }
  }

  /** Check if any action is overridden */
  const hasOverrides = Object.keys(overrides).length > 0

  /** Resolve selected model for an action */
  const getSelectedModel = (action: ModelAction): string =>
    overrides[action] ?? DEFAULT_MODEL_CONFIG[action]

  if (!activeWorkspace) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-text-secondary">Select a workspace to configure models.</p>
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      {/* Header — full width */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Model Configuration</h2>
          <p className="text-xs text-text-secondary mt-1">
            Configure which Claude model is used for each action in this workspace.
          </p>
        </div>
        <button
          onClick={handleResetAll}
          disabled={!hasOverrides || isSaving}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            hasOverrides
              ? 'text-mode-build-text border border-mode-build/30 hover:bg-mode-build-muted'
              : 'text-text-muted border border-border-subtle cursor-not-allowed opacity-50'
          }`}
          title="Reset all models to defaults"
        >
          <RotateCcw size={12} />
          Reset All Defaults
        </button>
      </div>

      {/* 2-column grid on wide screens, single column on narrow */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-8 gap-y-6">
        {/* Left column: Speed + Cost Preference + Info */}
        <div className="space-y-8">
          {/* Fast Mode toggle */}
          <div>
            <h3 className="text-sm text-text-secondary uppercase tracking-wider mb-3 font-medium">
              Speed
            </h3>
            <SettingsCard>
              <div className="flex items-center justify-between">
                <div className="flex-1 mr-4">
                  <div className="flex items-center gap-2">
                    <Zap size={14} className={fastMode ? 'text-mode-build-text' : 'text-text-muted'} />
                    <h4 className="text-sm font-medium text-text-primary">Fast Mode</h4>
                    {fastMode && (
                      <span className="text-xs px-1.5 py-0.5 rounded-full bg-mode-build-muted text-mode-build-text font-medium">
                        ON
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-text-secondary mt-1">
                    {fastMode
                      ? 'Responses ~2.5\u00d7 faster, billed as extra usage. Only affects the generalist chat \u2014 specialist agents run independently.'
                      : 'Uses included Claude Max usage at standard speed. Enable for faster responses (billed separately).'}
                  </p>
                </div>
                <button
                  onClick={handleFastModeToggle}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                    fastMode ? 'bg-mode-build' : 'bg-border-default'
                  }`}
                  role="switch"
                  aria-checked={fastMode}
                  aria-label="Toggle fast mode"
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      fastMode ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </SettingsCard>
          </div>

          {/* Cost Preference */}
          <div>
            <h3 className="text-sm text-text-secondary uppercase tracking-wider mb-3 font-medium">
              Cost Preference
            </h3>
            <SettingsCard>
              <div className="mb-3">
                <h4 className="text-sm font-medium text-text-primary">Default Routing</h4>
                <p className="text-xs text-text-secondary mt-0.5">
                  Controls which AI model is used for specialist tasks based on task complexity.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(['economy', 'balanced', 'power'] as const).map((pref) => (
                  <button
                    key={pref}
                    onClick={() => handleCostPreferenceChange(pref)}
                    className={`flex flex-col items-center gap-1.5 px-3 py-3 rounded-lg border text-xs font-medium transition-colors ${
                      costPreference === pref
                        ? 'border-primary bg-primary-muted text-primary-text'
                        : 'border-border-subtle hover:bg-surface-overlay text-text-secondary'
                    }`}
                  >
                    <span className="text-base">{COST_PREF_ICON[pref]}</span>
                    <span className="capitalize">{pref}</span>
                    <span className="text-xs text-text-muted">
                      {pref === 'economy'
                        ? 'Always Haiku'
                        : pref === 'balanced'
                          ? 'Auto-route'
                          : 'Always Opus'}
                    </span>
                  </button>
                ))}
              </div>
            </SettingsCard>
          </div>

          {/* Budget Limits */}
          <div>
            <h3 className="text-sm text-text-secondary uppercase tracking-wider mb-3 font-medium">
              Budget Limits
            </h3>
            <SettingsCard>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-text-secondary">Daily Budget (USD)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.50"
                    value={dailyBudget}
                    onChange={(e) =>
                      handleBudgetChange('dailyBudgetUsd', parseFloat(e.target.value) || 0)
                    }
                    className="w-full mt-1 bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <p className="text-[11px] text-text-muted mt-1">
                    0 = unlimited. Specialists stop when exceeded.
                  </p>
                </div>
                <div>
                  <label className="text-xs text-text-secondary">Session Budget (USD)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.50"
                    value={sessionBudget}
                    onChange={(e) =>
                      handleBudgetChange('sessionBudgetUsd', parseFloat(e.target.value) || 0)
                    }
                    className="w-full mt-1 bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <p className="text-[11px] text-text-muted mt-1">
                    Per-conversation limit. 0 = unlimited.
                  </p>
                </div>
              </div>
            </SettingsCard>
          </div>

          {/* Info box */}
          <SettingsCard>
            <div className="flex items-start gap-2.5">
              <Info size={14} className="text-text-muted flex-shrink-0 mt-0.5" />
              <p className="text-xs text-text-secondary leading-relaxed">
                Per-action overrides take highest priority. The{' '}
                <span className="text-text-primary font-medium">Cost Preference</span> above applies
                only to specialist tasks when no per-action override is set.
              </p>
            </div>
          </SettingsCard>
        </div>

        {/* Right column: Agent Models + Specialist Routing + Background Tasks */}
        <div className="space-y-8">
          {SECTIONS.map((section) => (
            <div key={section.key}>
              <h3 className="text-sm text-text-secondary uppercase tracking-wider mb-1.5 font-medium">
                {section.label}
              </h3>
              <p className="text-xs text-text-secondary mb-3">{section.description}</p>
              <div className="space-y-3">
                {section.actions.map((action) => {
                  const meta = MODEL_ACTIONS_META[action]
                  return (
                    <ModelSelector
                      key={action}
                      action={action}
                      label={meta.label}
                      description={meta.description}
                      icon={meta.icon}
                      selectedModel={getSelectedModel(action)}
                      onChange={handleChange}
                      onReset={handleReset}
                    />
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
