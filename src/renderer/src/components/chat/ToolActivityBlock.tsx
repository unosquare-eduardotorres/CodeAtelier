import { useState } from 'react'
import {
  ChevronRight,
  Wrench,
  Loader2,
  Terminal,
  FileText,
  Search,
  Cpu,
  Puzzle,
  PenLine,
  FileOutput,
  Copy,
  Check
} from 'lucide-react'
import type { ToolActivity, ToolOperationType } from '../../../../shared/types'
import { copyTextToClipboard } from '../../utils/clipboard'
import { shortenInput, getToolDisplayName } from './tool-activity-utils'
import InlineEditDiff from './InlineEditDiff'

// ── Copy button helper ──

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const handleCopy = async (): Promise<void> => {
    if (await copyTextToClipboard(text)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="ml-auto p-0.5 rounded text-text-muted hover:text-text-primary transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
    </button>
  )
}

// ── Operation type styling ──

interface OpConfig {
  icon: typeof Terminal
  label: string
}

const OP_TYPE_CONFIG: Record<ToolOperationType, OpConfig> = {
  read: { icon: FileText, label: 'Read' },
  write: { icon: FileOutput, label: 'Write' },
  edit: { icon: PenLine, label: 'Edit' },
  search: { icon: Search, label: 'Search' },
  shell: { icon: Terminal, label: 'Shell' },
  codegraph: { icon: Cpu, label: 'CodeGraph' },
  other: { icon: Puzzle, label: 'Tool' }
}

// ── Legacy category system (fallback when operationType not set) ──

type ToolCategory = 'shell' | 'file' | 'search' | 'codegraph' | 'git' | 'agent' | 'other'

function getToolCategory(toolName: string): ToolCategory {
  const name = toolName.toLowerCase()
  if (name === 'bash' || name === 'execute') return 'shell'
  if (
    name === 'read' ||
    name === 'write' ||
    name === 'edit' ||
    name === 'multiedit' ||
    name === 'notebook_edit' ||
    name === 'notebook_read'
  )
    return 'file'
  if (name === 'grep' || name === 'glob' || name === 'search') return 'search'
  if (name === 'agent' || name === 'todoread' || name === 'todowrite') return 'agent'
  if (name.includes('git') || name.startsWith('mcp__github')) return 'git'
  if (
    name.startsWith('mcp__code') ||
    name.startsWith('mcp__semantic') ||
    name.startsWith('mcp__checkpoint')
  )
    return 'codegraph'
  return 'other'
}

const CATEGORY_TO_OP: Record<ToolCategory, ToolOperationType> = {
  shell: 'shell',
  file: 'read',
  search: 'search',
  codegraph: 'codegraph',
  git: 'other',
  agent: 'other',
  other: 'other'
}

/** Resolve the op config, preferring structured operationType but falling back to category-based. */
function resolveOpConfig(activity: ToolActivity): OpConfig {
  if (activity.operationType) {
    return OP_TYPE_CONFIG[activity.operationType]
  }
  const category = getToolCategory(activity.toolName)
  return OP_TYPE_CONFIG[CATEGORY_TO_OP[category]]
}

// ── Status styling ──

const STATUS_STYLES: Record<
  string,
  { iconColor: string; outputColor: string; outputLabel: string }
> = {
  running: {
    iconColor: 'text-purple-400 animate-pulse',
    outputColor: 'text-text-muted',
    outputLabel: 'Output'
  },
  error: { iconColor: 'text-danger', outputColor: 'text-danger', outputLabel: 'Error' },
  completed: {
    iconColor: 'text-emerald-400',
    outputColor: 'text-text-muted',
    outputLabel: 'Output'
  }
}

// ── ToolRow sub-components ──

function ToolRowSummary({ activity }: { activity: ToolActivity }): React.JSX.Element {
  const isError = activity.status === 'error'
  return (
    <span className="flex-1 min-w-0">
      <span className="flex items-center gap-1.5 min-w-0 flex-wrap">
        <span className="text-[13px] font-medium flex-shrink-0 text-text-secondary">
          {getToolDisplayName(activity.toolName)}
        </span>
        {activity.filePath && (
          <span className="font-mono text-[12px] truncate max-w-[240px] text-text-muted">
            {activity.filePath}
          </span>
        )}
        {activity.lineRange && (
          <span className="text-[10px] text-text-muted bg-surface-overlay px-1 py-px rounded flex-shrink-0">
            L{activity.lineRange}
          </span>
        )}
      </span>
      {!activity.filePath && activity.input && (
        <span className="block text-[12px] text-text-secondary min-w-0 break-words mt-0.5">
          {shortenInput(activity.input)}
        </span>
      )}
      {activity.status !== 'running' && activity.result && (
        <span
          className={`block text-[11px] mt-0.5 break-words ${
            isError ? 'text-danger/80' : 'text-text-muted italic'
          }`}
        >
          → {activity.result}
        </span>
      )}
    </span>
  )
}

function ToolRowExpandedPanel({ activity }: { activity: ToolActivity }): React.JSX.Element {
  const statusStyle = STATUS_STYLES[activity.status] ?? STATUS_STYLES.completed
  return (
    <div className="mt-1 ml-5 rounded-md bg-surface-base border border-border-subtle overflow-hidden">
      {activity.editDiffs && activity.editDiffs.length > 0 && (
        <InlineEditDiff edits={activity.editDiffs} omitted={activity.editDiffsOmitted} />
      )}
      {activity.input && (activity.operationType === 'shell' || activity.input.length > 30) && (
        <div className="px-3 py-2 border-b border-border-subtle/50">
          <span className="flex items-center text-[10px] uppercase tracking-wider text-text-secondary font-medium">
            {activity.operationType === 'shell' ? 'Command' : 'Input'}
            <CopyButton text={activity.input} />
          </span>
          <pre className="mt-0.5 text-[11px] text-text-muted font-mono whitespace-pre-wrap break-all leading-relaxed">
            {activity.input}
          </pre>
        </div>
      )}
      {(activity.resultDetail || activity.result) && (
        <div className="px-3 py-2 max-h-[45vh] overflow-y-auto">
          <span className="flex items-center text-[10px] uppercase tracking-wider text-text-secondary font-medium">
            {statusStyle.outputLabel}
            <CopyButton text={activity.resultDetail || activity.result || ''} />
          </span>
          <pre
            className={`mt-0.5 text-[11px] font-mono whitespace-pre-wrap break-all leading-relaxed ${statusStyle.outputColor}`}
          >
            {activity.resultDetail || activity.result}
          </pre>
        </div>
      )}
    </div>
  )
}

// ── ToolRow component ──

function hasExpandableContent(activity: ToolActivity): boolean {
  // Edit rows would otherwise be unexpandable — their result is just "Done" —
  // which would make the inline diff unreachable.
  if (activity.editDiffs?.length) return true
  if (activity.resultDetail) return true
  if (activity.result && activity.result.length > 40) return true
  if (activity.input && activity.input.length > 60) return true
  return false
}

interface ToolRowProps {
  activity: ToolActivity
  isExpanded: boolean
  onToggleExpand: (id: string) => void
}

function ToolRow({ activity, isExpanded, onToggleExpand }: ToolRowProps): React.JSX.Element {
  const expandable = hasExpandableContent(activity)
  const opConfig = resolveOpConfig(activity)
  const CategoryIcon = opConfig.icon
  const statusStyle = STATUS_STYLES[activity.status] ?? STATUS_STYLES.completed
  const isRunning = activity.status === 'running'

  return (
    <div key={activity.id} data-testid="tool-activity-row" className="min-w-0">
      {/* Clickable row with subtle left-border */}
      <button
        type="button"
        onClick={() => expandable && onToggleExpand(activity.id)}
        className={`w-full text-left flex items-start gap-2 min-w-0 rounded-sm pl-2.5 pr-2 py-1 transition-colors group border-l-2 border-l-border-subtle ${
          expandable ? 'cursor-pointer hover:bg-surface-overlay/50' : 'cursor-default'
        } ${isExpanded ? 'bg-surface-overlay/40' : ''}`}
        data-testid="tool-activity-expand"
        aria-expanded={expandable ? isExpanded : undefined}
      >
        {/* Category icon — color = status */}
        <span className={`flex items-center flex-shrink-0 mt-0.5 ${statusStyle.iconColor}`}>
          <CategoryIcon size={13} />
        </span>

        {/* Main content */}
        <ToolRowSummary activity={activity} />

        {/* Right side — elapsed time + expand chevron */}
        <span className="flex items-center gap-1.5 flex-shrink-0 ml-auto mt-0.5">
          {isRunning && activity.elapsedSeconds !== undefined && (
            <span className="text-[11px] text-purple-400 tabular-nums">
              {activity.elapsedSeconds}s
            </span>
          )}
          {expandable && !isRunning && (
            <span
              className={`text-text-muted transition-transform duration-150 ${
                isExpanded ? 'rotate-90' : ''
              } opacity-0 group-hover:opacity-100 ${isExpanded ? '!opacity-100' : ''}`}
            >
              <ChevronRight size={12} />
            </span>
          )}
        </span>
      </button>

      {/* Expand panel */}
      {isExpanded && <ToolRowExpandedPanel activity={activity} />}
    </div>
  )
}

// ── Component ──

interface ToolActivityBlockProps {
  activities: ToolActivity[]
  /** When true, the tool list starts expanded (e.g., during streaming). Default false. */
  defaultExpanded?: boolean
}

/**
 * During streaming, only render the most recent N tool activity rows to prevent
 * DOM bloat when agents invoke 50+ tools. Older activities are collapsed behind
 * a "Show N earlier" button. Once the user clicks it, all activities render.
 */
const VISIBLE_ACTIVITY_LIMIT = 20

export default function ToolActivityBlock({
  activities,
  defaultExpanded = false
}: ToolActivityBlockProps): React.JSX.Element | null {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [showAllActivities, setShowAllActivities] = useState(false)

  if (activities.length === 0) return null

  const completedCount = activities.filter((a) => a.status === 'completed').length
  const errorCount = activities.filter((a) => a.status === 'error').length
  const runningCount = activities.filter((a) => a.status === 'running').length
  const runningActivities = activities.filter((a) => a.status === 'running')

  const toggleActivityExpand = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  // ── Header summary ──
  const summaryParts: string[] = []
  if (completedCount > 0) summaryParts.push(`${completedCount} done`)
  if (runningCount > 0) summaryParts.push(`${runningCount} running`)
  if (errorCount > 0) summaryParts.push(`${errorCount} failed`)

  return (
    <div data-testid="tool-activity-block" className="my-2 overflow-hidden">
      {/* Header toggle */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors group"
      >
        <Wrench size={12} className="flex-shrink-0" />
        <span>
          {activities.length} tool{activities.length !== 1 ? 's' : ''}
        </span>
        {runningCount > 0 && (
          <span className="inline-flex items-center gap-1 text-purple-400">
            <Loader2 size={10} className="animate-spin" />
            <span>{runningCount} running</span>
          </span>
        )}
        {runningCount === 0 && (
          <span className="text-text-muted">({summaryParts.join(' · ')})</span>
        )}
        <ChevronRight
          size={12}
          className={`transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
        />
      </button>

      {/* Collapsed — show running tools only as compact rows */}
      {!isExpanded && runningActivities.length > 0 && (
        <div className="mt-1.5 ml-1 space-y-0.5">
          {runningActivities.map((a) => (
            <ToolRow
              key={a.id}
              activity={a}
              isExpanded={expandedIds.has(a.id)}
              onToggleExpand={toggleActivityExpand}
            />
          ))}
        </div>
      )}

      {/* Expanded — render activities with optional truncation for long lists */}
      {isExpanded &&
        (() => {
          const shouldTruncate = !showAllActivities && activities.length > VISIBLE_ACTIVITY_LIMIT
          const hiddenCount = shouldTruncate ? activities.length - VISIBLE_ACTIVITY_LIMIT : 0
          const visibleActivities = shouldTruncate
            ? activities.slice(-VISIBLE_ACTIVITY_LIMIT)
            : activities

          return (
            <div className="mt-1.5 ml-1 space-y-0.5">
              {shouldTruncate && (
                <button
                  type="button"
                  onClick={() => setShowAllActivities(true)}
                  className="text-[11px] text-text-muted hover:text-text-secondary transition-colors pl-2.5 py-1"
                >
                  ▸ Show {hiddenCount} earlier tool{hiddenCount !== 1 ? 's' : ''}
                </button>
              )}
              {visibleActivities.map((a) => (
                <ToolRow
                  key={a.id}
                  activity={a}
                  isExpanded={expandedIds.has(a.id)}
                  onToggleExpand={toggleActivityExpand}
                />
              ))}
            </div>
          )
        })()}
    </div>
  )
}
