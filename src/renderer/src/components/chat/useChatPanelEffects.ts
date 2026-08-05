import { useState, useEffect } from 'react'
import { useWorkspaceStore, useSpecialistStore } from '@renderer/store'
import { useProjectSpecialistStore } from '@renderer/store/project-specialist.store'

/**
 * Manages specialist loading, specialist store reload,
 * and auto-triggering specialist builds for pending workspaces.
 */
export function useChatPanelEffects(): {
  projectSpecialist:
    | ReturnType<typeof useProjectSpecialistStore.getState>['byWorkspace'][string]
    | null
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
  // so the model picker can find it in the combobox
  const loadSpecialists = useSpecialistStore((s) => s.loadSpecialists)
  useEffect(() => {
    if (projectSpecialist?.buildStatus === 'ready') {
      void loadSpecialists()
    }
  }, [projectSpecialist?.buildStatus, loadSpecialists])

  // Auto-trigger specialist build for pending workspaces (no modal)
  const build = useProjectSpecialistStore((s) => s.build)
  const [autoTriggered] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    const wsId = activeWorkspace?.id
    if (!wsId || !projectSpecialist) return
    if (projectSpecialist.buildStatus === 'pending' && !autoTriggered.has(wsId)) {
      autoTriggered.add(wsId)
      void build(wsId)
    }
  }, [activeWorkspace?.id, projectSpecialist, autoTriggered, build])

  return { projectSpecialist }
}
