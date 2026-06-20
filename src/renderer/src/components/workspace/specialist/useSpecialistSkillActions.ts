/**
 * useSpecialistSkillActions — consolidates the 5 skill-related callbacks.
 * Extracted from SpecialistPage to reduce cyclomatic complexity.
 */
import { useState, useCallback } from 'react'
import { useToastStore } from '@renderer/store'

interface UseSpecialistSkillActionsParams {
  specialistId: string | undefined
  workspaceId: string | null
  importSkill: (filePath: string) => Promise<{ success: boolean; error?: string }>
  toggleSkill: (specialistId: string, skillId: string, enabled: boolean) => Promise<void>
  attachSkill: (specialistId: string, skillId: string) => Promise<void>
  detachSkill: (specialistId: string, skillId: string) => Promise<void>
  refreshRecommendations: (specialistId: string) => Promise<void>
  loadForWorkspace: (workspaceId: string) => Promise<void>
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function useSpecialistSkillActions({
  specialistId,
  workspaceId,
  importSkill,
  toggleSkill,
  attachSkill,
  detachSkill,
  refreshRecommendations,
  loadForWorkspace
}: UseSpecialistSkillActionsParams) {
  const addToast = useToastStore((s) => s.addToast)
  const [refreshingRecs, setRefreshingRecs] = useState(false)
  const [importingSkill, setImportingSkill] = useState(false)

  const handleImportSkill = useCallback(async () => {
    setImportingSkill(true)
    try {
      const filePath = await window.api.selectSkillFile()
      if (!filePath) {
        setImportingSkill(false)
        return
      }
      const result = await importSkill(filePath)
      if (result.success) {
        addToast({ message: 'Skill imported successfully', type: 'success' })
        if (workspaceId) await loadForWorkspace(workspaceId)
      } else {
        addToast({ message: result.error ?? 'Import failed', type: 'error' })
      }
    } catch (err) {
      addToast({ message: (err as Error).message, type: 'error' })
    } finally {
      setImportingSkill(false)
    }
  }, [importSkill, workspaceId, loadForWorkspace, addToast])

  const handleRefreshRecommendations = useCallback(async () => {
    if (!specialistId) return
    setRefreshingRecs(true)
    try {
      await refreshRecommendations(specialistId)
      addToast({ message: 'Recommendations refreshed', type: 'success' })
    } catch {
      addToast({ message: 'Failed to refresh recommendations', type: 'error' })
    } finally {
      setRefreshingRecs(false)
    }
  }, [specialistId, refreshRecommendations, addToast])

  const handleToggleSkill = useCallback(
    async (skillId: string, enabled: boolean) => {
      if (!specialistId) return
      try {
        await toggleSkill(specialistId, skillId, enabled)
        if (workspaceId) await loadForWorkspace(workspaceId)
      } catch {
        addToast({ message: 'Failed to toggle skill', type: 'error' })
      }
    },
    [specialistId, workspaceId, toggleSkill, loadForWorkspace, addToast]
  )

  const handleAttachSkill = useCallback(
    async (skillId: string) => {
      if (!specialistId) return
      try {
        await attachSkill(specialistId, skillId)
        if (workspaceId) await loadForWorkspace(workspaceId)
        addToast({ message: 'Skill attached', type: 'success' })
      } catch {
        addToast({ message: 'Failed to attach skill', type: 'error' })
      }
    },
    [specialistId, workspaceId, attachSkill, loadForWorkspace, addToast]
  )

  const handleDetachSkill = useCallback(
    async (skillId: string) => {
      if (!specialistId) return
      try {
        await detachSkill(specialistId, skillId)
        if (workspaceId) await loadForWorkspace(workspaceId)
        addToast({ message: 'Skill detached', type: 'success' })
      } catch {
        addToast({ message: 'Failed to detach skill', type: 'error' })
      }
    },
    [specialistId, workspaceId, detachSkill, loadForWorkspace, addToast]
  )

  return {
    refreshingRecs,
    importingSkill,
    handleImportSkill,
    handleRefreshRecommendations,
    handleToggleSkill,
    handleAttachSkill,
    handleDetachSkill
  }
}
