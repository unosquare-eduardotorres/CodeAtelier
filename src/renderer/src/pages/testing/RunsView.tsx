/**
 * RunsView — Runs tab content.
 *
 * Full-width vertical stack:
 *   1. Run History (horizontal timeline strip)
 *   2. RunSummaryBar
 *   3. Charts row (pass-rate trend + run composition)
 *   4. Category pass rates
 *   5. Results table
 *
 * Clicking a result row calls onOpenDetail to drill into the full-page detail view.
 */

import { useMemo, useCallback } from 'react'
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Ban,
  Clock,
  TrendingUp,
  BarChart3,
  ListChecks,
  ClipboardList
} from 'lucide-react'
import type {
  E2ERunSummary,
  E2EResultSummary,
  E2EScenarioSummary,
  E2EResultStatus
} from '../../../../shared/types'
import type { ScenarioDelta } from '../TestingPage'
import RunSummaryBar from './RunSummaryBar'
import RunHistory from './RunHistory'
import type { DetailTarget } from './ResultDetailView'
import PassRateTrendChart from './charts/PassRateTrendChart'
import RunCompositionChart from './charts/RunCompositionChart'
import CategoryPassRateChart from './charts/CategoryPassRateChart'
import SectionCard from './SectionCard'

interface RunsViewProps {
  runs: E2ERunSummary[]
  selectedRunId: string | null
  baselineRunId: string | null
  results: E2EResultSummary[]
  scenarios: E2EScenarioSummary[]
  isRunning: boolean
  preflightOk: boolean
  regressionSummary: { fixed: number; regressed: number } | null
  deltaMap: Map<string, ScenarioDelta>
  onSelectRun: (id: string) => void
  onBaselineChange: (runId: string | null) => void
  onRequeueFailed: (runId: string) => void
  onResumeRun: (runId: string) => void
  onCancel: () => void
  onOpenDetail: (target: DetailTarget) => void
}

// ── Helpers ──

function statusIcon(status: E2EResultStatus): React.JSX.Element {
  switch (status) {
    case 'passed':
      return <CheckCircle2 size={12} className="text-success" />
    case 'failed':
      return <XCircle size={12} className="text-danger" />
    case 'error':
      return <AlertTriangle size={12} className="text-warning" />
    case 'skipped':
      return <Ban size={12} className="text-text-muted" />
    default:
      return <Clock size={12} className="text-text-muted" />
  }
}

const STATUS_ORDER: Record<string, number> = {
  failed: 0,
  error: 1,
  skipped: 2,
  running: 3,
  queued: 4,
  passed: 5
}

export default function RunsView({
  runs,
  selectedRunId,
  baselineRunId,
  results,
  scenarios,
  isRunning,
  preflightOk,
  regressionSummary,
  deltaMap,
  onSelectRun,
  onBaselineChange,
  onRequeueFailed,
  onResumeRun,
  onCancel,
  onOpenDetail
}: RunsViewProps): React.JSX.Element {
  const handleRowClick = useCallback(
    (result: E2EResultSummary, title: string) => {
      onOpenDetail({
        resultId: result.id,
        title,
        status: result.status,
        durationMs: result.durationMs,
        from: 'runs'
      })
    },
    [onOpenDetail]
  )

  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null

  // Sort results: failures first, then by scenario ID
  const sortedResults = useMemo(() => {
    return [...results].sort((a, b) => {
      const orderA = STATUS_ORDER[a.status] ?? 3
      const orderB = STATUS_ORDER[b.status] ?? 3
      if (orderA !== orderB) return orderA - orderB
      return a.scenarioId.localeCompare(b.scenarioId)
    })
  }, [results])

  return (
    <>
      <div className="space-y-4">
        {/* Run History — horizontal strip */}
        <RunHistory
          runs={runs}
          selectedRunId={selectedRunId}
          isRunning={isRunning}
          preflightOk={preflightOk}
          onSelectRun={onSelectRun}
          onRequeueFailed={onRequeueFailed}
          onResumeRun={onResumeRun}
          onCancel={onCancel}
        />

        {!selectedRun ? (
          <div className="text-center py-12 text-sm text-text-muted">
            Select a run from the timeline to see details.
          </div>
        ) : (
          <>
            {/* Run summary bar */}
            <RunSummaryBar
              run={selectedRun}
              delta={regressionSummary}
              runs={runs}
              selectedRunId={selectedRunId}
              baselineRunId={baselineRunId}
              onBaselineChange={onBaselineChange}
            />

            {/* Charts row */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <SectionCard title="Pass-rate trend" icon={<TrendingUp size={14} />}>
                <PassRateTrendChart
                  runs={runs}
                  selectedRunId={selectedRunId}
                  onSelectRun={onSelectRun}
                />
              </SectionCard>
              <SectionCard title="Run composition" icon={<BarChart3 size={14} />}>
                <RunCompositionChart
                  runs={runs}
                  selectedRunId={selectedRunId}
                  onSelectRun={onSelectRun}
                />
              </SectionCard>
            </div>

            {/* Category pass rates */}
            <SectionCard title="Category pass rates" icon={<ListChecks size={14} />}>
              <CategoryPassRateChart results={results} scenarios={scenarios} />
            </SectionCard>

            {/* Results table */}
            <SectionCard
              title="Results"
              icon={<ClipboardList size={14} />}
              action={
                <span className="text-xs tabular-nums text-text-muted">
                  {sortedResults.length}
                </span>
              }
              flush
            >
              <div className="divide-y divide-border-subtle">
                {sortedResults.length === 0 && (
                  <div className="px-4 py-6 text-center text-sm text-text-muted">
                    No results yet for this run.
                  </div>
                )}

                {sortedResults.map((result) => {
                  const scenario = scenarios.find((s) => s.id === result.scenarioId)
                  const title = scenario?.title ?? result.scenarioId
                  const delta = deltaMap.get(result.scenarioId)

                  return (
                    <button
                      key={result.id}
                      type="button"
                      onClick={() => handleRowClick(result, title)}
                      className="w-full flex items-center justify-between px-4 py-2 text-left hover:bg-surface-raised/50 transition-colors focus:outline-none focus:ring-1 focus:ring-primary-muted"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {statusIcon(result.status)}
                        <span className="text-sm text-text-body truncate">
                          {title}
                        </span>
                      </div>

                      <div className="flex items-center gap-3 ml-4 shrink-0">
                        {delta && (
                          <span
                            className={`text-xs ${
                              delta === 'fixed'
                                ? 'text-success'
                                : delta === 'regressed'
                                  ? 'text-danger'
                                  : 'text-text-muted'
                            }`}
                          >
                            {delta}
                          </span>
                        )}
                        {result.durationMs != null && result.durationMs > 0 && (
                          <span className="flex items-center gap-1 text-xs text-text-muted tabular-nums">
                            <Clock size={10} />
                            {(result.durationMs / 1000).toFixed(1)}s
                          </span>
                        )}
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded-lg ${
                            result.status === 'passed'
                              ? 'bg-success/20 text-success'
                              : result.status === 'failed'
                                ? 'bg-danger/20 text-danger'
                                : result.status === 'error'
                                  ? 'bg-warning/20 text-warning'
                                  : 'bg-surface-base text-text-muted'
                          }`}
                        >
                          {result.status}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </SectionCard>
          </>
        )}
      </div>
    </>
  )
}
