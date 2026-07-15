/**
 * TestingPage — E2E model testing dashboard.
 *
 * Tab layout:
 *   Scenarios — preflight, run controls, progress, scenario catalog with inline expansion
 *   Runs — run history, charts, selected-run dashboard with results table
 *
 * Auto-switches to Runs tab when a run completes.
 */

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { FlaskConical } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'
import type {
  E2EScenarioSummary,
  E2EPreflightResult,
  E2ERunSummary,
  E2EResultSummary,
  E2ECategory,
  E2EProgressEvent,
  E2EResultStatus
} from '../../../shared/types'
import PreflightBanner from './testing/PreflightBanner'
import ScenarioCatalog from './testing/ScenarioCatalog'
import RunningBanner from './testing/RunningBanner'
import RunsView from './testing/RunsView'
import ResultDetailView from './testing/ResultDetailView'
import type { DetailTarget } from './testing/ResultDetailView'

// ── Regression delta types ──

export type ScenarioDelta = 'fixed' | 'regressed' | 'still_failing' | null

// ── Tab type ──

type Tab = 'scenarios' | 'runs'

export default function TestingPage(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()

  // ── State ──
  const [scenarios, setScenarios] = useState<E2EScenarioSummary[]>([])
  const [preflight, setPreflight] = useState<E2EPreflightResult | null>(null)
  const [isCheckingPreflight, setIsCheckingPreflight] = useState(false)
  const [runs, setRuns] = useState<E2ERunSummary[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [results, setResults] = useState<E2EResultSummary[]>([])
  const [previousResults, setPreviousResults] = useState<E2EResultSummary[]>([])
  const [baselineRunId, setBaselineRunId] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [progressCounts, setProgressCounts] = useState<E2EProgressEvent['counts'] | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('scenarios')
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null)
  const [forceTools, setForceTools] = useState(false)
  const [currentScenarioId, setCurrentScenarioId] = useState<string | null>(null)
  const [runStartedAt, setRunStartedAt] = useState<number>(Date.now())

  // Track active run for progress
  const activeRunId = useRef<string | null>(null)

  // ── Load scenarios on mount ──
  useEffect(() => {
    window.api.testingListScenarios().then(setScenarios)
  }, [])

  // ── Preflight check ──
  const checkPreflight = useCallback(async () => {
    setIsCheckingPreflight(true)
    try {
      const result = await window.api.testingPreflight(
        activeWorkspace ? { workspaceId: activeWorkspace.id } : undefined
      )
      setPreflight(result)
    } catch {
      setPreflight({ ok: false, error: 'Failed to check connection' })
    }
    setIsCheckingPreflight(false)
  }, [activeWorkspace])

  useEffect(() => {
    checkPreflight()
  }, [checkPreflight])

  // ── Load runs ──
  const loadRuns = useCallback(async () => {
    const r = await window.api.testingGetRuns()
    setRuns(r)
    if (r.length > 0 && !selectedRunId) {
      setSelectedRunId(r[0].id)
    }
  }, [selectedRunId])

  useEffect(() => {
    loadRuns()
  }, [loadRuns])

  // ── Load results when run selected + load baseline run for diffs ──
  useEffect(() => {
    if (!selectedRunId) {
      setResults([])
      setPreviousResults([])
      return
    }
    window.api.testingGetRunResults({ runId: selectedRunId }).then(setResults)

    const comparisonId = baselineRunId ?? (() => {
      const runIndex = runs.findIndex((r) => r.id === selectedRunId)
      const prevRun = runIndex >= 0 && runIndex < runs.length - 1 ? runs[runIndex + 1] : null
      return prevRun?.id ?? null
    })()

    if (comparisonId) {
      window.api.testingGetRunResults({ runId: comparisonId }).then(setPreviousResults)
    } else {
      setPreviousResults([])
    }
  }, [selectedRunId, runs, baselineRunId])

  // ── Subscribe to progress events ──
  useEffect(() => {
    const unsub = window.api.onTestingProgress((event: E2EProgressEvent) => {
      setProgressCounts(event.counts)

      if (event.scenarioId === '__run_complete__') {
        setIsRunning(false)
        setCurrentScenarioId(null)
        loadRuns()
        // Auto-switch to Runs tab when run completes
        setActiveTab('runs')
        setDetailTarget(null)
        return
      }

      // Track actively running scenario for RunningBanner
      if (event.status === 'running') {
        setCurrentScenarioId(event.scenarioId)
      }

      setResults((prev) => {
        const idx = prev.findIndex((r) => r.scenarioId === event.scenarioId)
        if (idx >= 0) {
          const updated = [...prev]
          updated[idx] = { ...updated[idx], status: event.status }
          return updated
        }
        return prev
      })
    })
    return unsub
  }, [loadRuns])

  // ── Build maps ──
  const resultMap = new Map<string, E2EResultSummary>()
  for (const r of results) {
    resultMap.set(r.scenarioId, r)
  }

  const baselineResultMap = useMemo(() => {
    const m = new Map<string, E2EResultSummary>()
    for (const r of previousResults) {
      m.set(r.scenarioId, r)
    }
    return m
  }, [previousResults])

  const prevResultMap = useMemo(() => {
    const m = new Map<string, E2EResultStatus>()
    for (const r of previousResults) {
      m.set(r.scenarioId, r.status)
    }
    return m
  }, [previousResults])

  const deltaMap = useMemo(() => {
    if (prevResultMap.size === 0) return new Map<string, ScenarioDelta>()
    const m = new Map<string, ScenarioDelta>()
    for (const r of results) {
      const prevStatus = prevResultMap.get(r.scenarioId)
      if (!prevStatus) continue
      const wasPassing = prevStatus === 'passed'
      const isPassing = r.status === 'passed'
      const wasFailing = prevStatus === 'failed' || prevStatus === 'error'
      const isFailing = r.status === 'failed' || r.status === 'error'

      if (wasFailing && isPassing) m.set(r.scenarioId, 'fixed')
      else if (wasPassing && isFailing) m.set(r.scenarioId, 'regressed')
      else if (wasFailing && isFailing) m.set(r.scenarioId, 'still_failing')
    }
    return m
  }, [results, prevResultMap])

  const regressionSummary = useMemo(() => {
    if (deltaMap.size === 0) return null
    let fixed = 0
    let regressed = 0
    for (const d of deltaMap.values()) {
      if (d === 'fixed') fixed++
      if (d === 'regressed') regressed++
    }
    return { fixed, regressed }
  }, [deltaMap])

  // ── Handlers ──

  const handleRun = useCallback(
    async (opts?: { scenarioIds?: string[]; category?: string }) => {
      try {
        setIsRunning(true)
        setProgressCounts(null)
        setCurrentScenarioId(null)
        setRunStartedAt(Date.now())
        const runArgs = {
          ...opts,
          workspaceId: activeWorkspace?.id,
          ...(forceTools ? { forceTools: true } : {})
        }
        const { runId } = await window.api.testingRun(
          Object.keys(runArgs).length > 0 ? runArgs : undefined
        )
        activeRunId.current = runId
        setSelectedRunId(runId)
        const r = await window.api.testingGetRunResults({ runId })
        setResults(r)
        await loadRuns()
      } catch (err) {
        setIsRunning(false)
        console.error('Failed to start test run:', err)
      }
    },
    [loadRuns, activeWorkspace, forceTools]
  )

  const handleRunAll = useCallback(() => handleRun(), [handleRun])

  const handleRunCategory = useCallback(
    (category: E2ECategory) => handleRun({ category }),
    [handleRun]
  )

  const handleRunOne = useCallback(
    (scenarioId: string) => handleRun({ scenarioIds: [scenarioId] }),
    [handleRun]
  )

  const handleRequeueFailed = useCallback(
    async (runId: string) => {
      try {
        setIsRunning(true)
        setProgressCounts(null)
        const { runId: newRunId } = await window.api.testingRequeueFailed({ runId, workspaceId: activeWorkspace?.id })
        activeRunId.current = newRunId
        setSelectedRunId(newRunId)
        await loadRuns()
      } catch (err) {
        setIsRunning(false)
        console.error('Failed to requeue:', err)
      }
    },
    [loadRuns, activeWorkspace]
  )

  const handleResumeRun = useCallback(
    async (runId: string) => {
      try {
        setIsRunning(true)
        setProgressCounts(null)
        const { runId: newRunId } = await window.api.testingResumeRun({ runId, workspaceId: activeWorkspace?.id })
        activeRunId.current = newRunId
        setSelectedRunId(newRunId)
        await loadRuns()
      } catch (err) {
        setIsRunning(false)
        console.error('Failed to resume run:', err)
      }
    },
    [loadRuns, activeWorkspace]
  )

  const handleCancel = useCallback(async () => {
    await window.api.testingCancel()
    setIsRunning(false)
  }, [])

  // ── Tab items ──
  const TABS: { id: Tab; label: string }[] = [
    { id: 'scenarios', label: 'Scenarios' },
    { id: 'runs', label: 'Runs' }
  ]

  const handleOpenDetail = useCallback((target: DetailTarget) => {
    setDetailTarget(target)
  }, [])

  const handleBackFromDetail = useCallback(() => {
    setDetailTarget(null)
  }, [])

  const handleTabChange = useCallback((tab: Tab) => {
    setActiveTab(tab)
    setDetailTarget(null)
  }, [])

  return (
    <div data-testid="testing-page" className="w-full px-8 py-6 space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <FlaskConical size={20} className="text-purple-400" />
        <div>
          <h2 className="text-lg font-semibold text-text-body">E2E Model Testing</h2>
          <p className="text-xs text-text-muted mt-0.5">
            Real end-to-end tests against a local oMLX model. Tests use the full production pipeline.
          </p>
        </div>
      </div>

      {/* Preflight */}
      <PreflightBanner
        preflight={preflight}
        isChecking={isCheckingPreflight}
        onCheck={checkPreflight}
        forceTools={forceTools}
        onForceToolsChange={setForceTools}
      />

      {detailTarget ? (
        /* ─── Drill-in detail view (replaces tabs) ─── */
        <ResultDetailView target={detailTarget} onBack={handleBackFromDetail} />
      ) : (
        <>
          {/* Tab bar (segmented control) */}
          <div className="flex items-center gap-1 p-0.5 rounded-lg bg-surface-base/60 border border-border-subtle w-fit">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  activeTab === tab.id
                    ? 'bg-surface-overlay text-text-body shadow-sm'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* ─── Scenarios tab ─── */}
          {activeTab === 'scenarios' && (
            <>
              {/* Running banner (visible during runs) */}
              {isRunning && (
                <RunningBanner
                  scenarioTitle={
                    currentScenarioId
                      ? (scenarios.find((s) => s.id === currentScenarioId)?.title ?? currentScenarioId)
                      : null
                  }
                  counts={progressCounts}
                  startedAt={runStartedAt}
                  onCancel={handleCancel}
                />
              )}

              {/* Scenario catalog with inline expansion */}
              <ScenarioCatalog
                scenarios={scenarios}
                results={resultMap}
                baselineResults={baselineResultMap}
                deltaMap={deltaMap}
                isRunning={isRunning}
                preflightOk={preflight?.ok ?? false}
                onRunAll={handleRunAll}
                onRunCategory={handleRunCategory}
                onRunOne={handleRunOne}
                onOpenDetail={handleOpenDetail}
              />
            </>
          )}

          {/* ─── Runs tab ─── */}
          {activeTab === 'runs' && (
            <RunsView
              runs={runs}
              selectedRunId={selectedRunId}
              baselineRunId={baselineRunId}
              results={results}
              scenarios={scenarios}
              isRunning={isRunning}
              preflightOk={preflight?.ok ?? false}
              regressionSummary={regressionSummary}
              deltaMap={deltaMap}
              onSelectRun={setSelectedRunId}
              onBaselineChange={setBaselineRunId}
              onRequeueFailed={handleRequeueFailed}
              onResumeRun={handleResumeRun}
              onCancel={handleCancel}
              onOpenDetail={handleOpenDetail}
            />
          )}
        </>
      )}
    </div>
  )
}
