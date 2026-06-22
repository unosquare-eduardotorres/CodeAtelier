/**
 * useSpecialistBuildState — tracks rebuild state from build progress events.
 * Extracted from SpecialistPage to reduce cyclomatic complexity.
 */
import { useState, useEffect, useCallback } from 'react'

type RebuildState = 'idle' | 'building' | 'success' | 'failed'

interface BuildProgress {
  phase: string
  message: string
}

interface UseSpecialistBuildStateParams {
  workspaceId: string | null
  specialistId: string | undefined
  buildProgress: BuildProgress | null
  build: (workspaceId: string) => Promise<void>
  rebuildPrompt: (specialistId: string) => Promise<void>
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function useSpecialistBuildState({
  workspaceId,
  specialistId,
  buildProgress,
  build,
  rebuildPrompt
}: UseSpecialistBuildStateParams) {
  const [rebuildState, setRebuildState] = useState<RebuildState>('idle')
  const [rebuildError, setRebuildError] = useState<string | null>(null)

  // Track rebuild state from build progress events
  useEffect(() => {
    if (!buildProgress) return undefined
    if (buildProgress.phase === 'started') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync from event stream
      setRebuildState('building')
      setRebuildError(null)
    } else if (buildProgress.phase === 'ready') {
      setRebuildState('success')
      const timer = setTimeout(() => setRebuildState('idle'), 2500)
      return () => clearTimeout(timer)
    } else if (buildProgress.phase === 'failed') {
      setRebuildState('failed')
      setRebuildError(buildProgress.message)
    }
    return undefined
  }, [buildProgress])

  const handleRebuild = useCallback(async () => {
    if (!workspaceId) return
    setRebuildState('building')
    setRebuildError(null)
    try {
      await build(workspaceId)
    } catch (err) {
      setRebuildState('failed')
      setRebuildError((err as Error).message)
    }
  }, [workspaceId, build])

  const handleRebuildPrompt = useCallback(async () => {
    if (!specialistId) return
    setRebuildState('building')
    setRebuildError(null)
    try {
      await rebuildPrompt(specialistId)
    } catch (err) {
      setRebuildState('failed')
      setRebuildError((err as Error).message)
    }
  }, [specialistId, rebuildPrompt])

  return { rebuildState, rebuildError, handleRebuild, handleRebuildPrompt }
}
