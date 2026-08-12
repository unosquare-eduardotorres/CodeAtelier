/**
 * useAuditViewNavigation — view transition callbacks for HealthPage.
 * Extracted from useHealthPageState to reduce cyclomatic complexity.
 */
import { useCallback, type MutableRefObject } from 'react'
import type {
  AuditMode,
  AuditTrackId,
  AuditRun,
  AuditSelectedSkills,
  LLMProvider
} from '../../../../../shared/types'
import type { HealthView } from './useHealthPageState'

interface UseAuditViewNavigationParams {
  workspaceId: string | undefined
  setView: (v: HealthView) => void
  setMode: (m: AuditMode) => void
  setSelectedTracks: (s: Set<AuditTrackId>) => void
  setActiveTrackId: (id: AuditTrackId | null) => void
  followLiveRef: MutableRefObject<boolean>
  allTrackIds: AuditTrackId[]
  startAudit: (
    workspaceId: string,
    mode: AuditMode,
    tracks: AuditTrackId[],
    provider?: LLMProvider,
    selectedSkills?: AuditSelectedSkills
  ) => Promise<void>
  openRun: (run: AuditRun) => void
  reset: () => void
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function useAuditViewNavigation({
  workspaceId,
  setView,
  setMode,
  setSelectedTracks,
  setActiveTrackId,
  followLiveRef,
  allTrackIds,
  startAudit,
  openRun,
  reset
}: UseAuditViewNavigationParams) {
  const handleStart = useCallback(() => setView('configure'), [setView])

  const handleConfigureRun = useCallback(
    async (config: {
      mode: AuditMode
      tracks: AuditTrackId[]
      provider: LLMProvider
      selectedSkills: AuditSelectedSkills
    }) => {
      if (!workspaceId) return
      followLiveRef.current = true
      setMode(config.mode)
      setSelectedTracks(new Set(config.tracks))
      setActiveTrackId(null)
      setView('active')
      await startAudit(
        workspaceId,
        config.mode,
        config.tracks,
        config.provider,
        config.selectedSkills
      )
    },
    [workspaceId, startAudit, followLiveRef, setMode, setSelectedTracks, setActiveTrackId, setView]
  )

  const handleNewAudit = useCallback(() => {
    reset()
    followLiveRef.current = true
    setActiveTrackId(null)
    setSelectedTracks(new Set(allTrackIds))
    setMode('light')
    setView('configure')
  }, [reset, followLiveRef, setActiveTrackId, setSelectedTracks, allTrackIds, setMode, setView])

  const handleOpenRun = useCallback(
    (run: AuditRun) => {
      openRun(run)
      setMode(run.mode)
      setSelectedTracks(new Set(run.selectedTracks))
      setActiveTrackId(null)
      setView('active')
    },
    [openRun, setMode, setSelectedTracks, setActiveTrackId, setView]
  )

  const handleRerunRun = useCallback(
    async (run: AuditRun) => {
      if (!workspaceId) return
      followLiveRef.current = true
      setMode(run.mode)
      setSelectedTracks(new Set(run.selectedTracks))
      setActiveTrackId(null)
      setView('active')
      await startAudit(workspaceId, run.mode, run.selectedTracks, undefined)
    },
    [workspaceId, startAudit, followLiveRef, setMode, setSelectedTracks, setActiveTrackId, setView]
  )

  const handleBackToHistory = useCallback(() => {
    setActiveTrackId(null)
    setView('landing')
  }, [setActiveTrackId, setView])

  return {
    handleStart,
    handleConfigureRun,
    handleNewAudit,
    handleOpenRun,
    handleRerunRun,
    handleBackToHistory
  }
}
