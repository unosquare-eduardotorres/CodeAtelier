/**
 * Council store — manages state for the LLM Council feature.
 *
 * Tracks:
 *   - Current phase (framing → deliberating → peer-review → synthesizing → complete)
 *   - Per-advisor streaming content and status
 *   - Peer reviews and final verdict
 *
 * Uses the shared StreamSegmentAccumulator for per-advisor stream segmentation.
 */

import { create } from 'zustand'
import {
  StreamSegmentAccumulator,
  type StreamSegment,
  type SegmentState
} from '@renderer/utils/stream-segment-accumulator'
import type { ToolActivity } from '../../../shared/types'
import type {
  CouncilAdvisorRole,
  CouncilReview,
  CouncilPeerReview,
  CouncilVerdict,
  CouncilPhase,
  CouncilMemberStatus
} from '../../../shared/types'
import { COUNCIL_ADVISOR_ROLES } from '../../../shared/constants'

// ── Per-advisor stream state ────────────────────────────────────────────

export interface AdvisorStreamState {
  segments: StreamSegment[]
  currentContent: string
  currentToolActivities: ToolActivity[]
  status: CouncilMemberStatus
  review: CouncilReview | null
}

// ── Store interface ─────────────────────────────────────────────────────

interface CouncilState {
  /** Whether the council view is active */
  isActive: boolean
  /** Current phase of the council process */
  phase: CouncilPhase
  /** Per-advisor streaming state */
  advisors: Record<CouncilAdvisorRole, AdvisorStreamState>
  /** Peer reviews (populated after peer-review phase) */
  peerReviews: CouncilPeerReview[]
  /** Final chairman verdict */
  verdict: CouncilVerdict | null
  /** DB session ID — needed for resume */
  currentSessionId: string | null
  /** Workspace ID for the active council session */
  currentWorkspaceId: string | null
  /** Title of the content being reviewed (extracted from input) */
  inputTitle: string | null
  /** The conversation that originated this council (null if standalone) */
  originConversationId: string | null
  /** Whether this session was loaded from history (no action buttons) */
  isHydrated: boolean

  // Actions
  startCouncil: () => void
  setInputTitle: (title: string) => void
  setSessionIdentity: (sessionId: string, workspaceId: string) => void
  handlePhaseChanged: (phase: CouncilPhase) => void
  handleMemberStream: (data: {
    advisorRole: string
    type: string
    content?: string
    toolActivity?: Partial<ToolActivity>
  }) => void
  handleMemberComplete: (advisorRole: string, review: CouncilReview | null) => void
  handlePeerReviewComplete: (peerReviews: CouncilPeerReview[]) => void
  handleVerdict: (verdict: CouncilVerdict) => void
  setOriginConversationId: (id: string) => void
  /** Hydrate store from a completed/failed/cancelled DB session record (for View) */
  hydrateFromRecord: (record: {
    sessionId: string
    workspaceId: string
    phase: CouncilPhase
    verdict: CouncilVerdict | null
    peerReviews: CouncilPeerReview[]
    advisorReviews: CouncilReview[]
    inputTitle?: string
    conversationId?: string
  }) => void
  reset: () => void
}

// ── Stream accumulators — one per advisor (outside reactive store) ───────

const accumulators = new Map<string, StreamSegmentAccumulator>()

function getOrCreateAccumulator(
  role: CouncilAdvisorRole,
  sync: (state: SegmentState) => void
): StreamSegmentAccumulator {
  let acc = accumulators.get(role)
  if (!acc) {
    acc = new StreamSegmentAccumulator(sync)
    accumulators.set(role, acc)
  }
  return acc
}

function resetAccumulators(): void {
  for (const acc of accumulators.values()) {
    acc.reset()
  }
  accumulators.clear()
}

// ── Initial advisor state ───────────────────────────────────────────────

function createInitialAdvisors(): Record<CouncilAdvisorRole, AdvisorStreamState> {
  const advisors = {} as Record<CouncilAdvisorRole, AdvisorStreamState>
  for (const role of COUNCIL_ADVISOR_ROLES) {
    advisors[role] = {
      segments: [],
      currentContent: '',
      currentToolActivities: [],
      status: 'pending',
      review: null
    }
  }
  return advisors
}

// ── Store ───────────────────────────────────────────────────────────────

export const useCouncilStore = create<CouncilState>((set, get) => ({
  isActive: false,
  phase: 'framing',
  advisors: createInitialAdvisors(),
  peerReviews: [],
  verdict: null,
  currentSessionId: null,
  currentWorkspaceId: null,
  inputTitle: null,
  originConversationId: null,
  isHydrated: false,

  startCouncil: () => {
    resetAccumulators()
    set({
      isActive: true,
      phase: 'framing',
      advisors: createInitialAdvisors(),
      peerReviews: [],
      verdict: null,
      currentSessionId: null,
      currentWorkspaceId: null,
      inputTitle: null,
      originConversationId: null,
      isHydrated: false
    })
  },

  setInputTitle: (title) => {
    set({ inputTitle: title })
  },

  setSessionIdentity: (sessionId, workspaceId) => {
    set({ currentSessionId: sessionId, currentWorkspaceId: workspaceId })
  },

  setOriginConversationId: (id) => {
    set({ originConversationId: id })
  },

  handlePhaseChanged: (phase) => {
    set({ phase })
    // When deliberating starts, set all advisors to running
    if (phase === 'deliberating') {
      const advisors = { ...get().advisors }
      for (const role of COUNCIL_ADVISOR_ROLES) {
        advisors[role] = { ...advisors[role], status: 'running' }
      }
      set({ advisors })
    }
  },

  handleMemberStream: (data) => {
    const role = data.advisorRole as CouncilAdvisorRole
    if (!COUNCIL_ADVISOR_ROLES.includes(role)) return

    const acc = getOrCreateAccumulator(role, (state: SegmentState) => {
      const advisors = { ...get().advisors }
      advisors[role] = {
        ...advisors[role],
        segments: state.segments,
        currentContent: state.currentContent,
        currentToolActivities: state.currentToolActivities
      }
      set({ advisors })
    })

    if (data.type === 'text' && data.content) {
      acc.appendText(data.content)
    } else if (data.type === 'tool_activity' && data.toolActivity) {
      acc.handleToolActivity(data.toolActivity as ToolActivity & { id: string; toolName: string })
    }
  },

  handleMemberComplete: (advisorRole, review) => {
    const role = advisorRole as CouncilAdvisorRole
    if (!COUNCIL_ADVISOR_ROLES.includes(role)) return

    const acc = accumulators.get(role)
    if (acc) acc.flush()

    const advisors = { ...get().advisors }
    advisors[role] = {
      ...advisors[role],
      status: review ? 'completed' : 'failed',
      review
    }
    set({ advisors })
  },

  handlePeerReviewComplete: (peerReviews) => {
    set({ peerReviews })
  },

  handleVerdict: (verdict) => {
    set({ verdict })
  },

  hydrateFromRecord: (record) => {
    resetAccumulators()
    const advisors = createInitialAdvisors()
    // Populate advisor states from stored reviews
    for (const review of record.advisorReviews) {
      const role = review.advisorRole as CouncilAdvisorRole
      if (COUNCIL_ADVISOR_ROLES.includes(role)) {
        advisors[role] = {
          ...advisors[role],
          status: 'completed',
          review
        }
      }
    }
    set({
      isActive: true,
      phase: record.phase,
      advisors,
      peerReviews: record.peerReviews,
      verdict: record.verdict,
      currentSessionId: record.sessionId,
      currentWorkspaceId: record.workspaceId,
      inputTitle: record.inputTitle ?? null,
      originConversationId: record.conversationId ?? null,
      isHydrated: true
    })
  },

  reset: () => {
    resetAccumulators()
    set({
      isActive: false,
      phase: 'framing',
      advisors: createInitialAdvisors(),
      peerReviews: [],
      verdict: null,
      currentSessionId: null,
      currentWorkspaceId: null,
      inputTitle: null,
      originConversationId: null,
      isHydrated: false
    })
  }
}))
