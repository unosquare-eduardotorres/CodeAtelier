/**
 * ScenarioCatalog — Grouped list of E2E test scenarios with results, delta badges,
 * filter chips, and text search.
 *
 * Each category is a collapsible SectionCard with a lucide icon, mini pass-rate
 * bar, and per-category Run button. Clicking a scenario row with a result opens
 * the full-page ResultDetailView via onOpenDetail.
 */

import { useState, useMemo, useCallback } from 'react'
import {
  Play,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  CircleDashed,
  Ban,
  Search,
  ArrowUpCircle,
  ArrowDownCircle,
  CircleMinus,
  MessageSquare,
  Terminal,
  Wrench,
  Brain,
  ClipboardList,
  Flame,
  Users,
  Layers,
  Network,
  ShieldCheck,
  Code2,
  AlertTriangle,
  GitBranch,
  Lightbulb,
  UserCog,
  Lock,
  FolderGit2
} from 'lucide-react'
import type {
  E2EScenarioSummary,
  E2ECategory,
  E2EResultSummary,
  E2EResultStatus
} from '../../../../shared/types'
import type { ScenarioDelta } from '../TestingPage'
import SectionCard from './SectionCard'
import type { DetailTarget } from './ResultDetailView'

// ── Types ──

type FilterMode = 'all' | 'failed' | 'passed' | 'not_run' | 'planned' | 'flagged'

interface ScenarioCatalogProps {
  scenarios: E2EScenarioSummary[]
  results: Map<string, E2EResultSummary>
  baselineResults: Map<string, E2EResultSummary>
  deltaMap: Map<string, ScenarioDelta>
  isRunning: boolean
  preflightOk: boolean
  onRunAll: () => void
  onRunCategory: (category: E2ECategory) => void
  onRunOne: (scenarioId: string) => void
  onOpenDetail: (target: DetailTarget) => void
}

// ── Constants ──

const CATEGORY_LABELS: Record<E2ECategory, string> = {
  'chat-core': 'Chat Core',
  'chat-edge': 'Chat Edge Cases',
  commands: 'Commands',
  tools: 'Tools',
  memory: 'Memory',
  planning: 'Planning',
  grill: 'Grill',
  council: 'Council',
  blueprints: 'Blueprints',
  mpa: 'Multi-Project Agent',
  audit: 'Audit',
  'code-intel': 'Code Intelligence',
  checkpoints: 'Checkpoints',
  ideas: 'Ideas',
  specialists: 'Specialists',
  security: 'Security',
  'workspace-ops': 'Workspace Ops'
}

const CATEGORY_ICONS: Record<E2ECategory, React.ReactNode> = {
  'chat-core': <MessageSquare size={14} />,
  'chat-edge': <AlertTriangle size={14} />,
  commands: <Terminal size={14} />,
  tools: <Wrench size={14} />,
  memory: <Brain size={14} />,
  planning: <ClipboardList size={14} />,
  grill: <Flame size={14} />,
  council: <Users size={14} />,
  blueprints: <Layers size={14} />,
  mpa: <Network size={14} />,
  audit: <ShieldCheck size={14} />,
  'code-intel': <Code2 size={14} />,
  checkpoints: <GitBranch size={14} />,
  ideas: <Lightbulb size={14} />,
  specialists: <UserCog size={14} />,
  security: <Lock size={14} />,
  'workspace-ops': <FolderGit2 size={14} />
}

const FILTER_LABELS: { mode: FilterMode; label: string }[] = [
  { mode: 'all', label: 'All' },
  { mode: 'failed', label: 'Failed' },
  { mode: 'passed', label: 'Passed' },
  { mode: 'flagged', label: 'Flagged' },
  { mode: 'not_run', label: 'Not run' },
  { mode: 'planned', label: 'Planned' }
]

// ── Helpers ──

function matchesFilter(
  scenario: E2EScenarioSummary,
  result: E2EResultSummary | undefined,
  filter: FilterMode
): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'failed':
      return result?.status === 'failed' || result?.status === 'error'
    case 'passed':
      return result?.status === 'passed'
    case 'not_run':
      return scenario.status === 'implemented' && (!result || result.status === 'queued')
    case 'planned':
      return scenario.status === 'planned'
    case 'flagged':
      return !!(scenario.knownIssue || scenario.falsePositiveRisk)
  }
}

function matchesSearch(scenario: E2EScenarioSummary, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    scenario.title.toLowerCase().includes(q) ||
    scenario.description.toLowerCase().includes(q) ||
    scenario.id.toLowerCase().includes(q)
  )
}

function getFilterCounts(
  scenarios: E2EScenarioSummary[],
  results: Map<string, E2EResultSummary>
): Record<FilterMode, number> {
  const counts: Record<FilterMode, number> = {
    all: 0,
    failed: 0,
    passed: 0,
    not_run: 0,
    planned: 0,
    flagged: 0
  }
  for (const s of scenarios) {
    counts.all++
    const r = results.get(s.id)
    if (matchesFilter(s, r, 'failed')) counts.failed++
    if (matchesFilter(s, r, 'passed')) counts.passed++
    if (matchesFilter(s, r, 'not_run')) counts.not_run++
    if (matchesFilter(s, r, 'planned')) counts.planned++
    if (matchesFilter(s, r, 'flagged')) counts.flagged++
  }
  return counts
}

// ── Sub-components ──

function StatusChip({ status }: { status: E2EResultStatus | 'planned' | null }): React.JSX.Element {
  switch (status) {
    case 'passed':
      return (
        <span className="flex items-center gap-1 text-xs text-success">
          <CheckCircle2 size={12} /> Passed
        </span>
      )
    case 'failed':
      return (
        <span className="flex items-center gap-1 text-xs text-danger">
          <XCircle size={12} /> Failed
        </span>
      )
    case 'running':
      return (
        <span className="flex items-center gap-1 text-xs text-info">
          <Loader2 size={12} className="animate-spin" /> Running
        </span>
      )
    case 'queued':
      return (
        <span className="flex items-center gap-1 text-xs text-text-secondary">
          <CircleDashed size={12} /> Queued
        </span>
      )
    case 'error':
      return (
        <span className="flex items-center gap-1 text-xs text-warning">
          <XCircle size={12} /> Error
        </span>
      )
    case 'skipped':
      return (
        <span className="flex items-center gap-1 text-xs text-text-muted">
          <Ban size={12} /> Skipped
        </span>
      )
    case 'planned':
      return <span className="text-xs text-text-muted italic">Planned</span>
    default:
      return <span className="text-xs text-text-muted">&mdash;</span>
  }
}

function DeltaBadge({ delta }: { delta: ScenarioDelta }): React.JSX.Element | null {
  if (!delta) return null
  switch (delta) {
    case 'fixed':
      return (
        <span
          className="flex items-center gap-0.5 text-xs text-success"
          title="Fixed — was failing, now passes"
        >
          <ArrowUpCircle size={12} /> fixed
        </span>
      )
    case 'regressed':
      return (
        <span
          className="flex items-center gap-0.5 text-xs text-danger"
          title="Regressed — was passing, now fails"
        >
          <ArrowDownCircle size={12} /> regressed
        </span>
      )
    case 'still_failing':
      return (
        <span
          className="flex items-center gap-0.5 text-xs text-text-muted"
          title="Still failing across runs"
        >
          <CircleMinus size={12} /> still failing
        </span>
      )
  }
}

// ── Main ──

export default function ScenarioCatalog({
  scenarios,
  results,
  baselineResults,
  deltaMap,
  isRunning,
  preflightOk,
  onRunAll,
  onRunCategory,
  onRunOne,
  onOpenDetail
}: ScenarioCatalogProps): React.JSX.Element {
  const [filter, setFilter] = useState<FilterMode>('all')
  const [searchQuery, setSearchQuery] = useState('')

  const handleRowClick = useCallback(
    (result: E2EResultSummary, title: string) => {
      onOpenDetail({
        resultId: result.id,
        title,
        status: result.status,
        durationMs: result.durationMs,
        from: 'scenarios'
      })
    },
    [onOpenDetail]
  )

  // Filter counts (unaffected by text search — show total available per filter)
  const filterCounts = useMemo(() => getFilterCounts(scenarios, results), [scenarios, results])

  // Filtered + searched scenarios
  const filteredScenarios = useMemo(() => {
    return scenarios.filter((s) => {
      const r = results.get(s.id)
      return matchesFilter(s, r, filter) && matchesSearch(s, searchQuery)
    })
  }, [scenarios, results, filter, searchQuery])

  // Group filtered by category
  const grouped = useMemo(() => {
    const m = new Map<E2ECategory, E2EScenarioSummary[]>()
    for (const s of filteredScenarios) {
      const list = m.get(s.category) ?? []
      list.push(s)
      m.set(s.category, list)
    }
    return m
  }, [filteredScenarios])

  const canRun = preflightOk && !isRunning

  return (
    <>
      <div className="space-y-4">
        {/* Controls bar: Run All + filter chips + search */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <button
              onClick={onRunAll}
              disabled={!canRun}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-primary-muted text-primary-text hover:bg-primary-muted/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Play size={14} /> Run All Implemented
            </button>
            {/* Running banner is now rendered by TestingPage — removed inline spinner */}
          </div>

          {/* Filter chips + search */}
          <div className="flex flex-wrap items-center gap-2">
            {FILTER_LABELS.map(({ mode, label }) => {
              const count = filterCounts[mode]
              const isActive = filter === mode
              return (
                <button
                  key={mode}
                  onClick={() => setFilter(mode)}
                  className={`px-2.5 py-1 text-xs rounded-lg border transition-colors ${
                    isActive
                      ? 'border-primary-muted bg-primary-muted/20 text-primary-text'
                      : 'border-border-subtle text-text-muted hover:text-text-secondary hover:border-border-subtle/80'
                  }`}
                >
                  {label} <span className="tabular-nums ml-0.5 opacity-70">{count}</span>
                </button>
              )
            })}

            {/* Search input */}
            <div className="relative ml-auto">
              <Search
                size={12}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted"
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter scenarios..."
                className="pl-7 pr-3 py-1 text-xs rounded-lg border border-border-subtle bg-surface-base text-text-body placeholder:text-text-muted/60 focus:outline-none focus:ring-1 focus:ring-primary-muted w-44"
              />
            </div>
          </div>
        </div>

        {/* Empty state */}
        {grouped.size === 0 && (
          <div className="text-center py-8 text-sm text-text-muted">
            No scenarios match the current filter.
          </div>
        )}

        {/* Grouped categories — collapsible SectionCards */}
        {Array.from(grouped.entries()).map(([category, items]) => {
          const implementedCount = items.filter((s) => s.status === 'implemented').length

          // Category pass rate (only when results exist)
          const categoryResults = items
            .filter((s) => s.status === 'implemented')
            .map((s) => results.get(s.id))
            .filter((r): r is E2EResultSummary => r != null && r.status !== 'queued')
          const categoryPassed = categoryResults.filter((r) => r.status === 'passed').length
          const categoryRan = categoryResults.length

          const headerMeta = (
            <div className="flex items-center gap-3">
              <span className="text-xs text-text-muted">
                {implementedCount} implemented / {items.length} total
              </span>
              {categoryRan > 0 && (
                <>
                  <span
                    className={`text-xs font-medium tabular-nums ${
                      categoryPassed === categoryRan
                        ? 'text-success'
                        : categoryPassed >= categoryRan * 0.5
                          ? 'text-warning'
                          : 'text-danger'
                    }`}
                  >
                    {categoryPassed}/{categoryRan} passed
                  </span>
                  {/* Mini pass-rate bar */}
                  <div className="h-1 w-16 rounded-full bg-surface-base overflow-hidden flex">
                    {categoryPassed > 0 && (
                      <div
                        className="bg-success"
                        style={{ width: `${(categoryPassed / categoryRan) * 100}%` }}
                      />
                    )}
                    {categoryRan - categoryPassed > 0 && (
                      <div
                        className="bg-danger"
                        style={{
                          width: `${((categoryRan - categoryPassed) / categoryRan) * 100}%`
                        }}
                      />
                    )}
                  </div>
                </>
              )}
              {implementedCount > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onRunCategory(category)
                  }}
                  disabled={!canRun}
                  className="flex items-center gap-1 px-2 py-0.5 text-xs rounded-lg border border-border-subtle hover:bg-surface-overlay transition-colors disabled:opacity-50"
                >
                  <Play size={10} /> Run
                </button>
              )}
            </div>
          )

          return (
            <SectionCard
              key={category}
              title={CATEGORY_LABELS[category] ?? category}
              icon={CATEGORY_ICONS[category]}
              collapsible
              flush
              action={headerMeta}
            >
              <div className="divide-y divide-border-subtle">
                {items.map((scenario) => {
                  const result = results.get(scenario.id)
                  const isPlanned = scenario.status === 'planned'
                  const resultStatus: E2EResultStatus | 'planned' | null = isPlanned
                    ? 'planned'
                    : (result?.status ?? null)
                  const delta = deltaMap.get(scenario.id) ?? null
                  const hasResult = result && !isPlanned

                  return (
                    <div
                      key={scenario.id}
                      role={isPlanned ? undefined : 'button'}
                      tabIndex={isPlanned ? undefined : 0}
                      aria-label={`${scenario.title} — ${resultStatus ?? 'not run'}`}
                      className={`flex items-center justify-between px-4 py-2 ${
                        isPlanned
                          ? 'opacity-50'
                          : resultStatus === 'running'
                            ? 'bg-info/5 border-l-2 border-info animate-pulse-subtle cursor-pointer focus:outline-none focus:ring-1 focus:ring-info'
                            : 'hover:bg-surface-raised/50 cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary-muted focus:bg-surface-raised/30'
                      }`}
                      onClick={() => {
                        if (hasResult) handleRowClick(result, scenario.title)
                      }}
                      onKeyDown={(e) => {
                        if (isPlanned) return
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          if (hasResult) handleRowClick(result, scenario.title)
                        }
                      }}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-sm ${isPlanned ? 'text-text-muted' : 'text-text-body'}`}
                            >
                              {scenario.title}
                            </span>
                            <span className="text-xs text-text-muted px-1.5 py-0.5 rounded-lg bg-surface-base">
                              {scenario.mode}
                            </span>
                            {scenario.knownIssue && (
                              <span
                                title={scenario.knownIssue}
                                className="text-xs px-1.5 py-0.5 rounded-lg bg-warning-muted/20 text-warning-text border border-warning-muted/40"
                              >
                                Known Issue
                              </span>
                            )}
                            {scenario.falsePositiveRisk && (
                              <span
                                title={scenario.falsePositiveRisk}
                                className="text-xs px-1.5 py-0.5 rounded-lg bg-primary-muted/20 text-primary-text border border-primary-muted/40"
                              >
                                False-Positive Risk
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-text-muted truncate mt-0.5">
                            {scenario.description}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 ml-4 shrink-0">
                        {result?.durationMs != null &&
                          result.durationMs > 0 &&
                          (() => {
                            const dur = (result.durationMs / 1000).toFixed(1)
                            const baseline = baselineResults.get(scenario.id)
                            const baselineDur = baseline?.durationMs
                            let deltaStr: string | null = null
                            let deltaClass = ''
                            if (baselineDur != null && baselineDur > 0) {
                              const diffS = (result.durationMs - baselineDur) / 1000
                              if (Math.abs(diffS) >= 0.1) {
                                deltaStr =
                                  diffS > 0 ? `+${diffS.toFixed(1)}s` : `${diffS.toFixed(1)}s`
                                deltaClass = diffS > 0 ? 'text-danger/70' : 'text-success/70'
                              }
                            }
                            return (
                              <span className="flex items-center gap-1 text-xs text-text-muted">
                                <Clock size={10} /> {dur}s
                                {deltaStr && (
                                  <span className={`text-[10px] ${deltaClass}`}>({deltaStr})</span>
                                )}
                              </span>
                            )
                          })()}
                        <DeltaBadge delta={delta} />
                        <StatusChip status={resultStatus} />
                        {!isPlanned && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              onRunOne(scenario.id)
                            }}
                            disabled={!canRun}
                            className="p-1 rounded-lg hover:bg-surface-overlay transition-colors disabled:opacity-30"
                            title="Run this scenario"
                          >
                            <Play size={12} className="text-text-secondary" />
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </SectionCard>
          )
        })}
      </div>
    </>
  )
}
