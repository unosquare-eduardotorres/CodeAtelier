import { useState, useCallback } from 'react'
import { useWorkspaceStore } from '@renderer/store'
import { useGrillStreamStore } from '@renderer/store/grill-stream.store'
import type { GrillTrackId, GrillTrackScore, LLMProvider } from '../../../../../shared/types'
import { GRILL_TRACKS } from '../../../../../shared/constants'
import type { GrillChatMessage, GrillPhase } from '../GrillChatView'

interface TrackManagementResult {
  selectedTrack: GrillTrackId | null
  trackScores: GrillTrackScore[]
  suggestedNextTrack: { trackId: GrillTrackId; reason: string } | null
  setSelectedTrack: (t: GrillTrackId | null) => void
  setTrackScores: React.Dispatch<React.SetStateAction<GrillTrackScore[]>>
  setSuggestedNextTrack: React.Dispatch<
    React.SetStateAction<{ trackId: GrillTrackId; reason: string } | null>
  >
  startTrackGrill: (trackId: GrillTrackId) => Promise<void>
}

export function useGrillTrackManagement(opts: {
  ideaId: string
  ideaTitle: string
  description: string
  grillProvider: LLMProvider
  setPhase: (phase: GrillPhase) => void
  setChatMessages: React.Dispatch<React.SetStateAction<GrillChatMessage[]>>
}): TrackManagementResult {
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)

  const [selectedTrack, setSelectedTrack] = useState<GrillTrackId | null>(null)
  const [trackScores, setTrackScores] = useState<GrillTrackScore[]>([])
  const [suggestedNextTrack, setSuggestedNextTrack] = useState<{
    trackId: GrillTrackId
    reason: string
  } | null>(null)

  const startTrackGrill = useCallback(
    async (trackId: GrillTrackId) => {
      if (!activeWorkspace) return
      setSelectedTrack(trackId)
      opts.setPhase('evaluating')
      setSuggestedNextTrack(null)
      useGrillStreamStore.getState().reset()
      opts.setChatMessages((prev) => [
        ...prev,
        { type: 'system', content: `Starting ${GRILL_TRACKS[trackId].name} track…` }
      ])
      const existingTrackScore = trackScores.find((ts) => ts.trackId === trackId)
      try {
        await window.api.grillEvaluate({
          workspaceId: activeWorkspace.id,
          trackId,
          ideaTitle: opts.ideaTitle,
          ideaDescription: opts.description,
          previousScore: existingTrackScore?.score,
          ideaId: opts.ideaId,
          llmProvider: opts.grillProvider
        })
      } catch (error) {
        console.error('Failed to start grill evaluation:', error)
        opts.setChatMessages((prev) => [
          ...prev,
          {
            type: 'system',
            content: `❌ Failed to start evaluation: ${error instanceof Error ? error.message : String(error)}`
          }
        ])
        opts.setPhase('paused')
      }
    },
    [activeWorkspace, opts, trackScores]
  )

  return {
    selectedTrack,
    trackScores,
    suggestedNextTrack,
    setSelectedTrack,
    setTrackScores,
    setSuggestedNextTrack,
    startTrackGrill
  }
}
