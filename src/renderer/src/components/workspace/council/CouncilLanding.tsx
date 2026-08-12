/**
 * CouncilLanding — top-level Council page with three states:
 *
 *   1. Active council running  → render existing CouncilView
 *   2. No history              → empty state with explanation + "New Council" CTA
 *   3. History exists           → filter bar + session card list
 *
 * Follows the same pattern as IdeasList.
 */

import { useEffect, useMemo, useState, useCallback } from 'react'
import {
  Landmark,
  Plus,
  FileText,
  Users,
  Award,
  ShieldAlert,
  Compass,
  TrendingUp,
  Eye,
  Wrench
} from 'lucide-react'
import { useCouncilStore } from '@renderer/store/council.store'
import { useWorkspaceStore } from '@renderer/store/workspace.store'
import { ConfirmDialog, Skeleton } from '@renderer/components/common'
import CouncilView from './CouncilView'
import CouncilFilterBar, { type CouncilFilter } from './CouncilFilterBar'
import CouncilSessionCard, { type CouncilSessionSummary } from './CouncilSessionCard'
import StartCouncilModal from './StartCouncilModal'
import type { CouncilInputType, CouncilVerdict } from '../../../../../shared/types'

// ── Props ──────────────────────────────────────────────────────────────────

interface CouncilLandingProps {
  onUpdatePlan?: (sessionId: string, verdict: CouncilVerdict, originConversationId: string, workspaceId: string) => void
  onAcceptAndBuild?: (sessionId: string, workspaceId: string) => void
  onDismiss?: () => void
  isProcessing?: boolean
  onNavigateToPlans?: () => void
}

/** Batch-fetch plan titles for completed council sessions (concurrent Promise.all). */
async function loadPlanTitles(sessions: CouncilSessionSummary[]): Promise<Map<string, string>> {
  const completedIds = sessions
    .filter((s) => s.status === 'completed')
    .map((s) => s.id)
  if (completedIds.length === 0) return new Map()

  const results = await Promise.all(
    completedIds.map((id) =>
      window.api
        .planFindBySource({ source: 'council', sourceId: id })
        .then((plan) => (plan?.title ? { sessionId: id, title: plan.title } : null))
        .catch(() => null)
    )
  )
  return new Map(
    results
      .filter((r): r is { sessionId: string; title: string } => r !== null)
      .map((r) => [r.sessionId, r.title])
  )
}

// ── Component ──────────────────────────────────────────────────────────────

/** Extract a display title from raw input content (may be JSON plan or plain text). */
function extractInputTitle(inputContent: string): string {
  try {
    const parsed = JSON.parse(inputContent)
    if (typeof parsed.title === 'string' && parsed.title.trim()) {
      return parsed.title.trim()
    }
  } catch {
    /* not JSON — use as plain text */
  }
  const firstLine =
    inputContent
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? inputContent
  return firstLine.length > 100 ? firstLine.slice(0, 100) + '…' : firstLine
}

// ── Pure helpers ──────────────────────────────────────────────────────────

/** Map a session status string to a council phase for store hydration. */
function getPhaseFromStatus(status: string): 'complete' | 'failed' | 'cancelled' {
  if (status === 'completed') return 'complete'
  if (status === 'failed') return 'failed'
  return 'cancelled'
}

const EMPTY_MESSAGES: Record<string, string> = {
  completed: 'No completed sessions yet',
  active: 'No active sessions',
  failed: 'No failed sessions',
  all: 'No council sessions yet'
}

function getEmptyMessage(filter: CouncilFilter, searchQuery: string): string {
  if (searchQuery.trim()) return 'No sessions match your search'
  return EMPTY_MESSAGES[filter] ?? EMPTY_MESSAGES.all
}

// ── Hooks ─────────────────────────────────────────────────────────────────

function useFilteredCouncilSessions(history: CouncilSessionSummary[]): {
  filteredHistory: CouncilSessionSummary[]
  filter: CouncilFilter
  setFilter: (f: CouncilFilter) => void
  searchQuery: string
  setSearchQuery: (q: string) => void
} {
  const [filter, setFilter] = useState<CouncilFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')

  const filteredHistory = useMemo(() => {
    let result = history
    if (filter === 'active') {
      result = result.filter((s) => s.status === 'running')
    } else if (filter === 'completed') {
      result = result.filter((s) => s.status === 'completed')
    } else if (filter === 'failed') {
      result = result.filter((s) => s.status === 'failed' || s.status === 'cancelled')
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter((s) => s.inputContent.toLowerCase().includes(q))
    }
    return result
  }, [history, filter, searchQuery])

  return { filteredHistory, filter, setFilter, searchQuery, setSearchQuery }
}

function useCouncilLandingHandlers(opts: {
  workspaceId: string
  history: CouncilSessionSummary[]
  setHistory: (fn: (prev: CouncilSessionSummary[]) => CouncilSessionSummary[]) => void
  setShowStartModal: (show: boolean) => void
  setDeleteTarget: (id: string | null) => void
}): {
  handleStartCouncil: (inputType: CouncilInputType, content: string) => Promise<void>
  handleView: (sessionId: string) => void
  handleDelete: (sessionId: string) => Promise<void>
  handleResume: (sessionId: string) => Promise<void>
  isStarting: boolean
} {
  const { workspaceId, history, setHistory, setShowStartModal, setDeleteTarget } = opts
  const [isStarting, setIsStarting] = useState(false)

  const handleStartCouncil = useCallback(
    async (inputType: CouncilInputType, content: string) => {
      if (!workspaceId || isStarting) return
      setIsStarting(true)
      try {
        const councilState = useCouncilStore.getState()
        councilState.startCouncil()

        const { sessionId } = await window.api.councilStart({
          workspaceId,
          inputType,
          planContent: content,
          originalUserRequest: content.split('\n')[0].slice(0, 100)
        })
        councilState.setSessionIdentity(sessionId, workspaceId)
        councilState.setInputTitle(extractInputTitle(content))
        setShowStartModal(false)
      } catch (err) {
        console.error('Failed to start council:', err)
        useCouncilStore.getState().reset()
      } finally {
        setIsStarting(false)
      }
    },
    [workspaceId, isStarting, setShowStartModal]
  )

  const handleView = useCallback(
    (sessionId: string) => {
      const session = history.find((s) => s.id === sessionId)
      if (!session) return

      const councilState = useCouncilStore.getState()

      if (session.status === 'running') {
        councilState.startCouncil()
        councilState.setSessionIdentity(sessionId, workspaceId)
      } else {
        councilState.hydrateFromRecord({
          sessionId,
          workspaceId,
          phase: getPhaseFromStatus(session.status),
          verdict: session.verdict,
          peerReviews: session.peerReviews ?? [],
          advisorReviews: session.advisorReviews ?? [],
          inputTitle: extractInputTitle(session.inputContent),
          conversationId: session.conversationId ?? undefined
        })
      }
    },
    [history, workspaceId]
  )

  const handleDelete = useCallback(
    async (sessionId: string) => {
      try {
        await window.api.councilDeleteSession({ sessionId })
        setHistory((prev) => prev.filter((s) => s.id !== sessionId))
      } catch (err) {
        console.error('Failed to delete council session:', err)
      }
      setDeleteTarget(null)
    },
    [setHistory, setDeleteTarget]
  )

  const handleResume = useCallback(
    async (sessionId: string) => {
      if (!workspaceId) return
      const councilState = useCouncilStore.getState()
      councilState.startCouncil()
      councilState.setSessionIdentity(sessionId, workspaceId)
      try {
        await window.api.councilResume({ sessionId, workspaceId })
      } catch (err) {
        console.error('Failed to resume council:', err)
        councilState.reset()
      }
    },
    [workspaceId]
  )

  return { handleStartCouncil, handleView, handleDelete, handleResume, isStarting }
}

// ── Component ─────────────────────────────────────────────────────────────

export default function CouncilLanding({
  onUpdatePlan,
  onAcceptAndBuild,
  onDismiss,
  isProcessing,
  onNavigateToPlans
}: CouncilLandingProps): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const workspaceId = activeWorkspace?.id ?? ''

  const councilIsActive = useCouncilStore((s) => s.isActive)

  const [history, setHistory] = useState<CouncilSessionSummary[]>([])
  const [planTitleMap, setPlanTitleMap] = useState<Map<string, string>>(new Map())
  const [isLoading, setIsLoading] = useState(true)
  const [showStartModal, setShowStartModal] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const { filteredHistory, filter, setFilter, searchQuery, setSearchQuery } =
    useFilteredCouncilSessions(history)
  const { handleStartCouncil, handleView, handleDelete, handleResume, isStarting } =
    useCouncilLandingHandlers({
      workspaceId,
      history,
      setHistory,
      setShowStartModal,
      setDeleteTarget
    })

  // Load history + batch plan titles on mount + workspace change
  useEffect(() => {
    if (!workspaceId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional loading state before async fetch
    setIsLoading(true)
    window.api
      .councilGetHistory({ workspaceId, limit: 50 })
      .then(async (records) => {
        const sessions = records as CouncilSessionSummary[]
        setHistory(sessions)
        const planMap = await loadPlanTitles(sessions)
        setPlanTitleMap(planMap)
      })
      .finally(() => setIsLoading(false))
  }, [workspaceId])

  // Reset council store when workspace changes to prevent stale session display
  useEffect(() => {
    const { currentWorkspaceId, isActive } = useCouncilStore.getState()
    if (isActive && currentWorkspaceId && currentWorkspaceId !== workspaceId) {
      useCouncilStore.getState().reset()
    }
  }, [workspaceId])

  // Refresh history when a council reaches a terminal phase
  useEffect(() => {
    if (!workspaceId) return
    const cleanup = window.api.onCouncilPhaseChanged((data) => {
      if (data.phase === 'complete' || data.phase === 'failed' || data.phase === 'cancelled') {
        window.api
          .councilGetHistory({ workspaceId, limit: 50 })
          .then(async (records) => {
            const sessions = records as CouncilSessionSummary[]
            setHistory(sessions)
            const planMap = await loadPlanTitles(sessions)
            setPlanTitleMap(planMap)
          })
      }
    })
    return cleanup
  }, [workspaceId])

  // ── Active council → delegate to CouncilView ──────────────────────────

  if (councilIsActive) {
    return (
      <CouncilView
        onUpdatePlan={onUpdatePlan}
        onAcceptAndBuild={onAcceptAndBuild}
        onDismiss={onDismiss}
        isProcessing={isProcessing}
        onNavigateToPlans={onNavigateToPlans}
      />
    )
  }

  // ── Loading skeleton ──────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="space-y-3 py-4">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="bg-surface-overlay border border-border-subtle rounded p-4 flex items-start gap-3"
          >
            <Skeleton className="h-8 w-8 rounded-lg flex-shrink-0" />
            <div className="flex-1">
              <Skeleton className="h-4 w-40 mb-2" />
              <Skeleton className="h-3 w-64 mb-1.5" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  // ── Empty state ───────────────────────────────────────────────────────

  if (history.length === 0) {
    return (
      <>
        <div
          data-testid="council-landing"
          className="flex flex-col items-center justify-center py-10 px-4"
        >
          <div className="max-w-2xl w-full space-y-6">
            {/* Header */}
            <div className="text-center space-y-2">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-indigo-500/15 mb-2">
                <Landmark size={28} className="text-indigo-400" />
              </div>
              <h2 className="text-lg font-semibold text-text-primary">Your Council</h2>
              <p className="text-sm text-text-secondary max-w-md mx-auto">
                Submit your work for
                <span className="text-text-primary font-medium"> adversarial review </span>
                by 5 independent AI advisors who cross-examine each other before delivering a scored
                verdict.
              </p>
            </div>

            {/* 3-column workflow cards */}
            <div className="grid grid-cols-3 gap-3">
              {/* Step 1: Submit */}
              <div className="rounded-xl border border-border-subtle bg-surface-overlay p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-indigo-500/15 flex items-center justify-center">
                    <FileText size={14} className="text-indigo-400" />
                  </div>
                  <span className="text-sm font-semibold text-text-primary">Submit</span>
                </div>
                <p className="text-xs text-text-secondary leading-relaxed">
                  Paste a plan, requirement, or question. Pick the input type so advisors tailor
                  their analysis.
                </p>
              </div>

              {/* Step 2: Review */}
              <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-indigo-500/15 flex items-center justify-center">
                    <Users size={14} className="text-indigo-400" />
                  </div>
                  <span className="text-sm font-semibold text-text-primary">Review</span>
                </div>
                <p className="text-xs text-text-secondary leading-relaxed">
                  5 advisors analyze independently, then cross-examine each other&apos;s findings to
                  surface blind spots.
                </p>
              </div>

              {/* Step 3: Verdict */}
              <div className="rounded-xl border border-border-subtle bg-surface-overlay p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-primary/15 flex items-center justify-center">
                    <Award size={14} className="text-primary-text" />
                  </div>
                  <span className="text-sm font-semibold text-text-primary">Verdict</span>
                </div>
                <p className="text-xs text-text-secondary leading-relaxed">
                  A Chairman synthesizes everything into a scored verdict with actionable
                  recommendations.
                </p>
              </div>
            </div>

            {/* Advisor perspectives panel */}
            <div className="rounded-lg border border-border-subtle bg-surface-overlay p-4">
              <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
                5 Advisor Perspectives
              </p>
              <div className="grid grid-cols-3 gap-2">
                {[
                  {
                    icon: ShieldAlert,
                    label: 'Contrarian',
                    desc: 'Finds flaws',
                    color: 'text-red-400'
                  },
                  {
                    icon: Compass,
                    label: 'First Principles',
                    desc: 'Questions assumptions',
                    color: 'text-blue-400'
                  },
                  {
                    icon: TrendingUp,
                    label: 'Expansionist',
                    desc: 'Spots opportunities',
                    color: 'text-green-400'
                  },
                  {
                    icon: Eye,
                    label: 'Outsider',
                    desc: 'Catches blind spots',
                    color: 'text-amber-400'
                  },
                  {
                    icon: Wrench,
                    label: 'Executor',
                    desc: 'Validates feasibility',
                    color: 'text-cyan-400'
                  }
                ].map(({ icon: Icon, label, desc, color }) => (
                  <div key={label} className="flex items-center gap-2 text-xs">
                    <Icon size={12} className={`${color} flex-shrink-0`} />
                    <span>
                      <strong className="text-text-primary">{label}</strong>
                      <span className="text-text-muted"> — {desc}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* CTA */}
            <div className="flex justify-center">
              <button
                onClick={() => setShowStartModal(true)}
                data-testid="council-start-btn"
                className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-400 rounded-xl transition-colors"
              >
                <Plus size={16} />
                New Council Review
              </button>
            </div>
          </div>
        </div>
        {showStartModal && (
          <StartCouncilModal
            isStarting={isStarting}
            onStart={handleStartCouncil}
            onClose={() => setShowStartModal(false)}
          />
        )}
      </>
    )
  }

  // ── List view ─────────────────────────────────────────────────────────

  return (
    <>
      <CouncilFilterBar
        filter={filter}
        searchQuery={searchQuery}
        onFilterChange={setFilter}
        onSearchChange={setSearchQuery}
        onNewCouncil={() => setShowStartModal(true)}
      />

      {filteredHistory.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Landmark size={32} className="text-indigo-400/30 mb-3" />
          <p className="text-sm text-text-secondary">
            {getEmptyMessage(filter, searchQuery)}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredHistory.map((session) => (
            <CouncilSessionCard
              key={session.id}
              session={session}
              planTitle={planTitleMap.get(session.id) ?? null}
              onView={handleView}
              onResume={handleResume}
              onDelete={(id) => setDeleteTarget(id)}
              onNavigateToPlans={onNavigateToPlans}
            />
          ))}
        </div>
      )}

      {showStartModal && (
        <StartCouncilModal
          isStarting={isStarting}
          onStart={handleStartCouncil}
          onClose={() => setShowStartModal(false)}
        />
      )}

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="Delete Council Session"
        message="Are you sure you want to delete this council session? This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => deleteTarget && handleDelete(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  )
}
