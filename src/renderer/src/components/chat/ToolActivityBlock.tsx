import { useState } from 'react'
import {
  ChevronRight,
  Wrench,
  Loader2,
  Terminal,
  FileText,
  Search,
  GitBranch,
  Cpu,
  Bot,
  Puzzle
} from 'lucide-react'
import type { ToolActivity } from '../../../../shared/types'
import { MCP_DISPLAY_NAMES } from '../../../../shared/constants'

/**
 * Shortens long absolute paths to show `…/parentFolder/file.ext`.
 * Handles paths with spaces, command strings containing paths, and Grep summaries.
 */
export function shortenInput(input: string): string {
  // If already short enough, return as-is
  if (input.length <= 45) return input

  // For Grep-style inputs like `/pattern/ in /some/long/path`, shorten the path part
  const grepMatch = input.match(/^(\/.*?\/)\s+in\s+(.+)$/)
  if (grepMatch) {
    const pattern = grepMatch[1]
    const pathPart = shortenPath(grepMatch[2])
    return `${pattern} in ${pathPart}`
  }

  // For command strings, try to extract and shorten any embedded absolute path
  // e.g., "find /Users/foo/bar -name *.ts" or "ls -la /Users/foo/bar"
  const cmdPathMatch = input.match(/^(.+?\s)(\/\S.*?)(\s+.*)?$/)
  if (cmdPathMatch) {
    const prefix = cmdPathMatch[1] // e.g. "find " or "ls -la "
    const rawPath = cmdPathMatch[2] // e.g. "/Users/foo/bar"
    const suffix = cmdPathMatch[3] || '' // e.g. " -name *.ts"
    // For commands, show just the command + shortened path + suffix
    const shortened = shortenPath(rawPath)
    const result = prefix + shortened + suffix
    return result.length <= 60 ? result : prefix + shortened
  }

  // For pure paths (starts with /)
  if (input.startsWith('/')) {
    return shortenPath(input)
  }

  return input
}

/**
 * Shortens an absolute path to its last 2 meaningful segments.
 * e.g., "/Users/eduardo/Downloads/COE Operation Nexus/src/App.tsx" → "…/src/App.tsx"
 */
function shortenPath(fullPath: string): string {
  const segments = fullPath.split('/').filter(Boolean)
  if (segments.length <= 2) return fullPath
  return '…/' + segments.slice(-2).join('/')
}

/** Maps raw MCP tool names (mcp__server__tool) to human-readable display names. */
export function getToolDisplayName(toolName: string): string {
  if (MCP_DISPLAY_NAMES[toolName]) return MCP_DISPLAY_NAMES[toolName]
  // Generic MCP fallback — e.g. "mcp__server__tool" → "server · tool"
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__')
    return parts.length >= 3 ? `${parts[1]} · ${parts[2]}` : toolName
  }
  return toolName
}

// ── Tool category system ──

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

const CATEGORY_CONFIG: Record<
  ToolCategory,
  { icon: typeof Terminal; badgeBg: string; badgeText: string; dotColor: string }
> = {
  shell: {
    icon: Terminal,
    badgeBg: 'bg-emerald-500/15',
    badgeText: 'text-emerald-400',
    dotColor: 'bg-emerald-400'
  },
  file: {
    icon: FileText,
    badgeBg: 'bg-blue-500/15',
    badgeText: 'text-blue-400',
    dotColor: 'bg-blue-400'
  },
  search: {
    icon: Search,
    badgeBg: 'bg-amber-500/15',
    badgeText: 'text-amber-400',
    dotColor: 'bg-amber-400'
  },
  codegraph: {
    icon: Cpu,
    badgeBg: 'bg-purple-500/15',
    badgeText: 'text-purple-400',
    dotColor: 'bg-purple-400'
  },
  git: {
    icon: GitBranch,
    badgeBg: 'bg-orange-500/15',
    badgeText: 'text-orange-400',
    dotColor: 'bg-orange-400'
  },
  agent: {
    icon: Bot,
    badgeBg: 'bg-cyan-500/15',
    badgeText: 'text-cyan-400',
    dotColor: 'bg-cyan-400'
  },
  other: {
    icon: Puzzle,
    badgeBg: 'bg-slate-500/15',
    badgeText: 'text-slate-400',
    dotColor: 'bg-slate-400'
  }
}

// ── Component ──

interface ToolActivityBlockProps {
  activities: ToolActivity[]
  /** When true, the tool list starts expanded (e.g., during streaming). Default false. */
  defaultExpanded?: boolean
}

export default function ToolActivityBlock({
  activities,
  defaultExpanded = false
}: ToolActivityBlockProps): React.JSX.Element | null {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

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

  /** Determine if a tool row has content worth expanding */
  const hasExpandableContent = (activity: ToolActivity): boolean => {
    // Any tool with a long input, any result, or resultDetail can be expanded
    if (activity.resultDetail) return true
    if (activity.result && activity.result.length > 40) return true
    if (activity.input && activity.input.length > 60) return true
    return false
  }

  /** Render a single tool activity as a timeline node */
  const renderTimelineNode = (
    activity: ToolActivity,
    index: number,
    list: ToolActivity[]
  ): React.JSX.Element => {
    const isActivityExpanded = expandedIds.has(activity.id)
    const expandable = hasExpandableContent(activity)
    const isLast = index === list.length - 1
    const category = getToolCategory(activity.toolName)
    const config = CATEGORY_CONFIG[category]
    const CategoryIcon = config.icon
    const isRunning = activity.status === 'running'
    const isError = activity.status === 'error'

    return (
      <div key={activity.id} className="relative flex gap-3 min-w-0">
        {/* Timeline spine — vertical line + status dot */}
        <div className="flex flex-col items-center flex-shrink-0 w-4">
          {/* Dot */}
          <div className="relative flex-shrink-0">
            {isRunning ? (
              <>
                <div className="w-2.5 h-2.5 rounded-full bg-purple-400 animate-pulse" />
                <div className="absolute inset-0 w-2.5 h-2.5 rounded-full bg-purple-400/40 animate-ping" />
              </>
            ) : isError ? (
              <div className="w-2.5 h-2.5 rounded-full bg-danger" />
            ) : (
              <div className={`w-2.5 h-2.5 rounded-full ${config.dotColor}`} />
            )}
          </div>
          {/* Connecting line */}
          {!isLast && (
            <div className="w-px flex-1 min-h-[12px] bg-border-subtle" />
          )}
        </div>

        {/* Content */}
        <div className={`flex-1 min-w-0 ${isLast ? '' : 'pb-1.5'}`}>
          {/* Clickable row — entire row is the click target */}
          <button
            type="button"
            onClick={() => expandable && toggleActivityExpand(activity.id)}
            className={`w-full text-left flex items-center gap-2 min-w-0 rounded-md px-2 py-1 -ml-2 transition-colors group ${
              expandable ? 'cursor-pointer hover:bg-surface-overlay/50' : 'cursor-default'
            } ${isActivityExpanded ? 'bg-surface-overlay/40' : ''}`}
            aria-expanded={expandable ? isActivityExpanded : undefined}
          >
            {/* Tool badge — colored pill with category icon */}
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium flex-shrink-0 ${config.badgeBg} ${config.badgeText}`}
            >
              <CategoryIcon size={10} />
              {getToolDisplayName(activity.toolName)}
            </span>

            {/* Summary text — input or result, truncated */}
            <span className="text-xs text-text-muted min-w-0 flex-1 truncate">
              {activity.input && shortenInput(activity.input)}
              {activity.status === 'completed' && activity.result && (
                <span className="text-text-secondary"> — {activity.result}</span>
              )}
              {isError && activity.result && (
                <span className="text-danger"> — {activity.result}</span>
              )}
            </span>

            {/* Right side — elapsed time or expand chevron */}
            <span className="flex items-center gap-1.5 flex-shrink-0 ml-auto">
              {isRunning && activity.elapsedSeconds !== undefined && (
                <span className="text-[11px] text-purple-400 tabular-nums">
                  {activity.elapsedSeconds}s
                </span>
              )}
              {isRunning && (
                <Loader2 size={12} className="text-purple-400 animate-spin" />
              )}
              {expandable && !isRunning && (
                <span
                  className={`text-text-muted transition-transform duration-150 ${
                    isActivityExpanded ? 'rotate-90' : ''
                  } opacity-0 group-hover:opacity-100 ${isActivityExpanded ? '!opacity-100' : ''}`}
                >
                  <ChevronRight size={12} />
                </span>
              )}
            </span>
          </button>

          {/* Expand panel — shows input AND output with clear labels */}
          {isActivityExpanded && (
            <div className="mt-1 ml-0 rounded-md bg-surface-base border border-border-subtle overflow-hidden">
              {/* Input section */}
              {activity.input && activity.input.length > 30 && (
                <div className="px-3 py-2 border-b border-border-subtle/50">
                  <span className="text-[10px] uppercase tracking-wider text-text-secondary font-medium">
                    Input
                  </span>
                  <pre className="mt-0.5 text-[11px] text-text-muted font-mono whitespace-pre-wrap break-all leading-relaxed">
                    {activity.input}
                  </pre>
                </div>
              )}
              {/* Output section */}
              {(activity.resultDetail || activity.result) && (
                <div className="px-3 py-2 max-h-64 overflow-y-auto">
                  <span className="text-[10px] uppercase tracking-wider text-text-secondary font-medium">
                    {isError ? 'Error' : 'Output'}
                  </span>
                  <pre
                    className={`mt-0.5 text-[11px] font-mono whitespace-pre-wrap break-all leading-relaxed ${
                      isError ? 'text-danger' : 'text-text-muted'
                    }`}
                  >
                    {activity.resultDetail || activity.result}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Header summary ──
  const summaryParts: string[] = []
  if (completedCount > 0) summaryParts.push(`${completedCount} done`)
  if (runningCount > 0) summaryParts.push(`${runningCount} running`)
  if (errorCount > 0) summaryParts.push(`${errorCount} failed`)

  return (
    <div className="my-2">
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
          <span className="text-text-muted">
            ({summaryParts.join(' · ')})
          </span>
        )}
        <ChevronRight
          size={12}
          className={`transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
        />
      </button>

      {/* Collapsed — show running tools only as mini timeline */}
      {!isExpanded && runningActivities.length > 0 && (
        <div className="mt-2 ml-3">
          {runningActivities.map((a, i) => renderTimelineNode(a, i, runningActivities))}
        </div>
      )}

      {/* Expanded — full timeline of all activities */}
      {isExpanded && (
        <div className="mt-2 ml-3">
          {activities.map((a, i) => renderTimelineNode(a, i, activities))}
        </div>
      )}
    </div>
  )
}
