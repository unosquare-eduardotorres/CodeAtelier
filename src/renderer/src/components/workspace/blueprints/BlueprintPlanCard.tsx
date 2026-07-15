/**
 * BlueprintPlanCard — redesigned, professional implementation-plan table.
 *
 * Improvements over the inline version:
 *  - No truncation: descriptions wrap fully as secondary lines
 *  - Priority column with P1/P2/P3 colored chips
 *  - Scope icons with semantic color chips (backend, frontend, db, shared, tests)
 *  - Proper typography: readable sizes, zebra striping, hover states
 *  - Extra columns: user story, depends-on, tests included, parallel badge
 *  - Files: wrapped mono chips, 3 visible + expandable "+N more" toggle
 *  - Tech stack: labeled chips instead of tiny inline text
 *  - Header: item count + total files count
 */

import { useState, useMemo } from 'react'
import {
  ClipboardList,
  Server,
  LayoutPanelLeft,
  Database,
  Share2,
  FlaskConical,
  GitBranch,
  CheckCircle2,
  Zap,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileType,
  Palette
} from 'lucide-react'

// ── Scope config ────────────────────────────────────────────────────────────

const SCOPE_CONFIG: Record<string, { icon: typeof Server; label: string; colorClass: string }> = {
  backend: { icon: Server, label: 'Backend', colorClass: 'text-accent bg-accent/10' },
  frontend: { icon: LayoutPanelLeft, label: 'Frontend', colorClass: 'text-info bg-info/10' },
  database: { icon: Database, label: 'Database', colorClass: 'text-success bg-success/10' },
  shared: { icon: Share2, label: 'Shared', colorClass: 'text-warning bg-warning/10' },
  tests: { icon: FlaskConical, label: 'Tests', colorClass: 'text-danger bg-danger/10' }
}

const PRIORITY_CONFIG: Record<string, { label: string; colorClass: string }> = {
  P1: { label: 'P1', colorClass: 'text-danger bg-danger/15 border-danger/30' },
  P2: { label: 'P2', colorClass: 'text-warning bg-warning/15 border-warning/30' },
  P3: { label: 'P3', colorClass: 'text-info bg-info/15 border-info/30' }
}

// ── File type icon helper ───────────────────────────────────────────────────

export function getFileIcon(filePath: string): React.JSX.Element {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  if (['tsx', 'jsx'].includes(ext)) return <FileCode2 size={12} className="text-info" />
  if (['ts', 'js', 'mjs', 'cjs'].includes(ext)) return <FileCode2 size={12} className="text-accent" />
  if (['css', 'scss', 'less'].includes(ext)) return <Palette size={12} className="text-success" />
  return <FileType size={12} className="text-text-muted" />
}

// ── File chips with expand toggle ───────────────────────────────────────────

export function FileChips({ files }: { files: string[] }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? files : files.slice(0, 3)
  const hiddenCount = files.length - 3

  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((f) => (
        <span
          key={f}
          className="inline-flex items-center gap-1 font-mono text-xs bg-surface-inset px-1.5 py-0.5 rounded text-text-muted leading-tight"
        >
          {getFileIcon(f)}
          {f}
        </span>
      ))}
      {hiddenCount > 0 && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="inline-flex items-center text-xs text-accent hover:text-accent/80 font-medium cursor-pointer border border-accent/30 rounded px-1.5 py-0.5"
        >
          +{hiddenCount} more
        </button>
      )}
      {expanded && hiddenCount > 0 && (
        <button
          onClick={() => setExpanded(false)}
          className="text-xs text-text-muted hover:text-text-secondary font-medium cursor-pointer"
        >
          show less
        </button>
      )}
    </div>
  )
}

// ── Scope chip ──────────────────────────────────────────────────────────────

function ScopeChip({ scope }: { scope: string }): React.JSX.Element {
  const config = SCOPE_CONFIG[scope.toLowerCase()]
  if (!config) {
    return <span className="text-xs text-text-muted">{scope}</span>
  }
  const Icon = config.icon
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded ${config.colorClass}`}>
      <Icon size={12} />
      {config.label}
    </span>
  )
}

// ── Priority chip ───────────────────────────────────────────────────────────

function PriorityChip({ priority }: { priority: string | undefined }): React.JSX.Element {
  if (!priority) {
    return <span className="text-xs text-text-muted">—</span>
  }
  const key = priority.toUpperCase()
  const config = PRIORITY_CONFIG[key]
  if (!config) {
    return <span className="text-xs text-text-muted">{priority}</span>
  }
  return (
    <span className={`inline-flex items-center text-[11px] font-semibold px-1.5 py-0.5 rounded border ${config.colorClass}`}>
      {config.label}
    </span>
  )
}

// ── Tech stack chips ────────────────────────────────────────────────────────

function TechStackFooter({ techStack }: { techStack: Record<string, unknown> }): React.JSX.Element {
  return (
    <div className="px-4 py-3 border-t border-border/20">
      <div className="grid grid-cols-2 gap-2">
        {Object.entries(techStack).map(([key, value]) => (
          <div
            key={key}
            className="border border-border-subtle/50 rounded-lg px-2.5 py-1.5"
          >
            <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider block">
              {key}
            </span>
            <span className="text-xs text-text-secondary">
              {String(value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────────────

export function BlueprintPlanCard({ plan, taskStatuses }: {
  plan: Record<string, unknown>
  taskStatuses?: Record<string, import('../../../../../shared/blueprint-types').BlueprintTaskStatus>
}): React.JSX.Element {
  const items = (plan.items ?? plan.phases ?? plan.steps ?? []) as Array<Record<string, unknown>>
  const techStack = plan.techStack as Record<string, unknown> | undefined

  // Count total files across all items
  const totalFiles = items.reduce((sum, item) => {
    const files = (item.files as string[]) ?? []
    return sum + files.length
  }, 0)

  // Progress metrics (when taskStatuses overlay is provided)
  const progressMetrics = useMemo(() => {
    if (!taskStatuses || Object.keys(taskStatuses).length === 0) return null
    const total = items.length
    const done = items.filter((item) => {
      const id = String(item.id ?? '')
      return taskStatuses[id] === 'complete'
    }).length
    const pct = total > 0 ? Math.round((done / total) * 100) : 0
    return { done, total, pct }
  }, [items, taskStatuses])

  return (
    <div className="bg-surface-raised rounded-xl border border-border/50 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/30 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ClipboardList size={18} className="text-accent" />
            <h3 className="text-base font-semibold text-text-primary">Implementation Plan</h3>
          </div>
          <div className="flex items-center gap-3">
            {progressMetrics && (
              <span className="text-xs font-medium text-text-secondary">
                {progressMetrics.done} of {progressMetrics.total} complete
              </span>
            )}
            <span className="text-xs text-text-muted">{items.length} items</span>
            {totalFiles > 0 && (
              <span className="text-xs text-text-muted">{totalFiles} files</span>
            )}
          </div>
        </div>
        {/* Progress bar */}
        {progressMetrics && (
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-surface-inset rounded-full overflow-hidden">
              <div
                className="h-full bg-success rounded-full transition-all duration-500"
                style={{ width: `${progressMetrics.pct}%` }}
              />
            </div>
            <span className="text-[11px] font-mono text-text-muted">{progressMetrics.pct}%</span>
          </div>
        )}
      </div>

      {/* Item rows */}
      {items.length > 0 && (
        <div className="divide-y divide-border/10">
          {items.map((item, i) => {
            const files = (item.files as string[]) ?? []
            const dependsOn = (item.dependsOn as string[]) ?? []
            const scope = item.scope as string | undefined
            const priority = item.priority as string | undefined
            const userStory = item.userStory as string | undefined
            const includesTests = item.includesTests as boolean | undefined
            const isParallel = item.isParallel as boolean | undefined

            return (
              <div
                key={String(item.id ?? i)}
                className={`px-4 py-3 hover:bg-surface-hover/50 transition-colors ${i % 2 === 1 ? 'bg-surface-inset/30' : ''}`}
              >
                {/* Top row: ID + Title + badges */}
                <div className="flex items-start gap-3">
                  {/* ID in bordered square */}
                  <span className="w-8 h-6 rounded bg-surface-inset border border-border-subtle flex items-center justify-center font-mono text-xs text-text-muted shrink-0">
                    {String(item.id ?? `P${i + 1}`)}
                  </span>

                  {/* Title + description */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-text-primary">
                        {String(item.title ?? item.name ?? '')}
                      </span>
                      {/* Inline badges */}
                      {scope && <ScopeChip scope={scope} />}
                      {priority && <PriorityChip priority={priority} />}
                      {isParallel && (
                        <span className="inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded text-accent bg-accent/10">
                          <Zap size={12} />
                          Parallel
                        </span>
                      )}
                      {includesTests && (
                        <span className="inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded text-success bg-success/10">
                          <CheckCircle2 size={12} />
                          Tests
                        </span>
                      )}
                    </div>

                    {/* Description — full wrap, no truncation */}
                    {item.description ? (
                      <p className="text-sm text-text-secondary mt-1 leading-relaxed">
                        {String(item.description)}
                      </p>
                    ) : null}

                    {/* Meta row: user story + depends-on */}
                    {(userStory || dependsOn.length > 0) && (
                      <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                        {userStory && (
                          <span className="text-xs text-text-muted font-medium bg-surface-inset px-1.5 py-0.5 rounded">
                            {userStory}
                          </span>
                        )}
                        {dependsOn.length > 0 && (
                          <span className="inline-flex items-center gap-1 text-xs text-text-muted">
                            <GitBranch size={12} />
                            {dependsOn.join(', ')}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Files */}
                    {files.length > 0 && (
                      <div className="mt-2">
                        <FileChips files={files} />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Tech stack footer */}
      {techStack && <TechStackFooter techStack={techStack} />}
    </div>
  )
}

// ── Tasks Card (typography-bumped for consistency) ──────────────────────────

export function BlueprintTasksCard({ tasks }: { tasks: Record<string, unknown> }): React.JSX.Element {
  const waves = (tasks.waves ?? []) as Array<Record<string, unknown>>
  const flatItems = (tasks.tasks ?? tasks.items ?? []) as Array<Record<string, unknown>>
  const allTasks = waves.length > 0
    ? waves.flatMap((w) => (w.tasks as Array<Record<string, unknown>>) ?? [])
    : flatItems

  const [expandedWaves, setExpandedWaves] = useState<Set<number>>(() => new Set(waves.map((_, i) => i)))

  const toggleWave = (idx: number): void => {
    setExpandedWaves((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  return (
    <div className="bg-surface-raised rounded-xl border border-border/50 overflow-hidden">
      <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={14} className="text-success" />
          <h3 className="text-sm font-semibold text-text-primary">Tasks</h3>
        </div>
        <span className="text-xs text-text-muted">{allTasks.length} tasks</span>
      </div>

      {waves.length > 0 ? (
        /* Wave-grouped layout */
        <div className="divide-y divide-border/20">
          {waves.map((wave, wi) => {
            const waveTasks = (wave.tasks as Array<Record<string, unknown>>) ?? []
            const isExpanded = expandedWaves.has(wi)
            return (
              <div key={wi}>
                <button
                  onClick={() => toggleWave(wi)}
                  className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-surface-hover/50 transition-colors"
                >
                  {isExpanded ? <ChevronDown size={12} className="text-text-muted" /> : <ChevronRight size={12} className="text-text-muted" />}
                  <span className="text-xs font-semibold text-text-secondary">
                    Wave {wave.wave != null ? String(wave.wave) : wi + 1}
                  </span>
                  {wave.name ? (
                    <span className="text-xs text-text-muted">— {String(wave.name)}</span>
                  ) : null}
                  <span className="text-[11px] text-text-muted ml-auto">{waveTasks.length} tasks</span>
                </button>
                {isExpanded && (
                  <div className="divide-y divide-border/10">
                    {waveTasks.map((task, ti) => (
                      <TaskRow key={String(task.taskId ?? task.id ?? ti)} task={task} index={ti} />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        /* Flat layout */
        <div className="divide-y divide-border/10">
          {allTasks.map((task, i) => (
            <TaskRow key={String(task.taskId ?? task.id ?? i)} task={task} index={i} />
          ))}
        </div>
      )}
    </div>
  )
}

function TaskRow({ task, index }: { task: Record<string, unknown>; index: number }): React.JSX.Element {
  const files = (task.files ?? task.filePaths ?? []) as string[]
  const isParallel = task.isParallel as boolean | undefined
  const includesTests = task.includesTests as boolean | undefined
  const dependsOn = (task.dependsOn as string[]) ?? []
  const userStory = task.userStory as string | undefined

  return (
    <div className={`px-4 py-3 hover:bg-surface-hover/50 transition-colors ${index % 2 === 1 ? 'bg-surface-inset/30' : ''}`}>
      <div className="flex items-start gap-3">
        <span className="w-10 h-6 rounded bg-surface-inset border border-border-subtle flex items-center justify-center font-mono text-xs text-text-muted shrink-0">
          {String(task.taskId ?? task.id ?? `T${String(index + 1).padStart(3, '0')}`)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-text-primary">
              {String(task.description ?? task.title ?? '')}
            </span>
            {isParallel && (
              <span className="inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded text-accent bg-accent/10">
                <Zap size={12} />
                [P]
              </span>
            )}
            {includesTests && (
              <span className="inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded text-success bg-success/10">
                <CheckCircle2 size={12} />
              </span>
            )}
          </div>

          {(userStory || dependsOn.length > 0) && (
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              {userStory && (
                <span className="text-xs text-text-muted font-medium bg-surface-inset px-1.5 py-0.5 rounded">
                  {userStory}
                </span>
              )}
              {dependsOn.length > 0 && (
                <span className="inline-flex items-center gap-1 text-xs text-text-muted">
                  <GitBranch size={12} />
                  {dependsOn.join(', ')}
                </span>
              )}
            </div>
          )}

          {files.length > 0 && (
            <div className="mt-1.5">
              <FileChips files={files} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
