/**
 * useWorkspaceSettingActions — workspace setting handlers (cost preference, fast mode, budget cap, tone).
 * Extracted from useModelConfig to reduce cyclomatic complexity.
 */
import { useState, useCallback } from 'react'
import { useToastStore } from '@renderer/store'
import { COMMUNICATION_TONES } from '../../../../../shared/constants'
import type {
  CommunicationTone,
  CostPreference,
  Workspace
} from '../../../../../shared/types'

async function updateSetting(
  workspaceId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const settings = await window.api.getWorkspaceSettings({ workspaceId })
  await window.api.updateWorkspaceSettings({
    workspaceId,
    settings: { ...settings, ...patch }
  })
}

interface UseWorkspaceSettingActionsParams {
  activeWorkspace: Workspace | null
  initialCostPreference: CostPreference
  initialFastMode: boolean
  initialBudgetCap: number | undefined
  initialTone: CommunicationTone
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function useWorkspaceSettingActions({
  activeWorkspace,
  initialCostPreference,
  initialFastMode,
  initialBudgetCap,
  initialTone
}: UseWorkspaceSettingActionsParams) {
  const addToast = useToastStore((s) => s.addToast)
  const [costPreference, setCostPreference] = useState<CostPreference>(initialCostPreference)
  const [fastMode, setFastMode] = useState(initialFastMode)
  const [budgetCapUsd, setBudgetCapUsd] = useState<number | undefined>(initialBudgetCap)
  const [communicationTone, setCommunicationTone] = useState<CommunicationTone>(initialTone)

  const handleCostPreferenceChange = useCallback(async (pref: CostPreference) => {
    setCostPreference(pref)
    if (activeWorkspace) await updateSetting(activeWorkspace.id, { costPreference: pref })
  }, [activeWorkspace])

  const handleFastModeToggle = useCallback(async () => {
    const newValue = !fastMode
    setFastMode(newValue)
    if (activeWorkspace) await updateSetting(activeWorkspace.id, { fastMode: newValue })
  }, [fastMode, activeWorkspace])

  const handleBudgetCapChange = useCallback(async (value: string) => {
    const parsed = value ? Number(value) : undefined
    setBudgetCapUsd(parsed && parsed > 0 ? parsed : undefined)
    if (activeWorkspace) {
      await updateSetting(activeWorkspace.id, { budgetCapUsd: parsed && parsed > 0 ? parsed : null })
    }
  }, [activeWorkspace])

  const handleToneChange = useCallback(async (tone: CommunicationTone) => {
    setCommunicationTone(tone)
    if (activeWorkspace) {
      await updateSetting(activeWorkspace.id, { communicationTone: tone })
      addToast({
        message: `Communication tone set to ${COMMUNICATION_TONES.find((t) => t.id === tone)?.label ?? tone}`,
        type: 'info'
      })
    }
  }, [activeWorkspace, addToast])

  return {
    costPreference,
    setCostPreference,
    fastMode,
    setFastMode,
    budgetCapUsd,
    setBudgetCapUsd,
    communicationTone,
    setCommunicationTone,
    handleCostPreferenceChange,
    handleFastModeToggle,
    handleBudgetCapChange,
    handleToneChange
  }
}
