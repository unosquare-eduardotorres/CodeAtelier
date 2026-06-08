import { useState, useEffect, useCallback } from 'react'
import { useWorkspaceStore, useSpecialistStore } from '@renderer/store'
import { useProjectSpecialistStore } from '@renderer/store/project-specialist.store'

/**
 * Manages specialist loading, specialist store reload,
 * and the Generate-Specialist modal auto-open/dismiss lifecycle.
 */
export function useChatPanelEffects(): {
  projectSpecialist:
    | ReturnType<typeof useProjectSpecialistStore.getState>['byWorkspace'][string]
    | null
  generateModalOpen: boolean
  handleDismissGenerate: () => void
} {
  const { activeWorkspace } = useWorkspaceStore()

  // Load Project Specialist on workspace change
  const loadProjectSpecialist = useProjectSpecialistStore((s) => s.loadForWorkspace)
  const projectSpecialist = useProjectSpecialistStore((s) =>
    activeWorkspace?.id ? s.byWorkspace[activeWorkspace.id] : null
  )
  useEffect(() => {
    if (activeWorkspace?.id) void loadProjectSpecialist(activeWorkspace.id)
  }, [activeWorkspace?.id, loadProjectSpecialist])

  // Reload specialist store when project specialist becomes ready
  // so PersonaSelector can find it in the combobox
  const loadSpecialists = useSpecialistStore((s) => s.loadSpecialists)
  useEffect(() => {
    if (projectSpecialist?.buildStatus === 'ready') {
      void loadSpecialists()
    }
  }, [projectSpecialist?.buildStatus, loadSpecialists])

  // Generate-Specialist modal — auto-opens for pending/failed specialists,
  // session-dismissed Set prevents re-opening after "Maybe later".
  const [generateModalOpen, setGenerateModalOpen] = useState(false)
  const [dismissedWorkspaces] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    const wsId = activeWorkspace?.id
    if (!wsId || !projectSpecialist) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- close modal when workspace unloads
      setGenerateModalOpen(false)
      return
    }
    if (dismissedWorkspaces.has(wsId)) return
    if (projectSpecialist.buildStatus === 'pending' || projectSpecialist.buildStatus === 'failed') {
      setGenerateModalOpen(true)
    } else {
      setGenerateModalOpen(false)
    }
  }, [activeWorkspace?.id, projectSpecialist, dismissedWorkspaces])

  const handleDismissGenerate = useCallback(() => {
    const wsId = activeWorkspace?.id
    if (wsId) dismissedWorkspaces.add(wsId)
    setGenerateModalOpen(false)
  }, [activeWorkspace, dismissedWorkspaces])

  return { projectSpecialist, generateModalOpen, handleDismissGenerate }
}
