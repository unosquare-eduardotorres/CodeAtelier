import { useState } from 'react'
import { ChevronDown, ChevronRight, Wrench, Loader2, CheckCircle2, XCircle } from 'lucide-react'
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

  /** Render a single tool activity row with optional per-row expand. */
  const renderActivity = (activity: ToolActivity): React.JSX.Element => {
    const isActivityExpanded = expandedIds.has(activity.id)
    const isLongInput = !!activity.input && activity.input.length > 50
    const isLongResult = !!activity.result && activity.result.length > 80
    const hasExpandableContent = isLongInput || isLongResult

    return (
      <div key={activity.id} className="flex flex-col gap-0.5 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          {/* Status icon — SVG with appropriate color and animation */}
          {activity.status === 'running' ? (
            <Loader2 size={12} className="text-purple-400 animate-spin flex-shrink-0" />
          ) : activity.status === 'completed' ? (
            <CheckCircle2 size={12} className="text-success flex-shrink-0" />
          ) : (
            <XCircle size={12} className="text-danger flex-shrink-0" />
          )}

          {/* Tool name */}
          <span className="font-mono text-text-body flex-shrink-0">
            {getToolDisplayName(activity.toolName)}
          </span>

          {/* Input — full or truncated */}
          {activity.input && (
            <span
              className={`text-text-muted min-w-0 ${isActivityExpanded ? 'break-all whitespace-normal' : 'truncate max-w-[300px]'}`}
              title={!isActivityExpanded ? activity.input : undefined}
            >
              {isActivityExpanded ? activity.input : shortenInput(activity.input)}
            </span>
          )}

          {/* Result — full or truncated (non-error) */}
          {activity.status === 'completed' && activity.result && (
            <span
              className={`text-text-muted text-[11px] ml-1 min-w-0 ${isActivityExpanded ? 'break-all whitespace-normal' : 'truncate max-w-[300px]'}`}
            >
              — {activity.result}
            </span>
          )}

          {/* Error result — shown in red */}
          {activity.status === 'error' && activity.result && (
            <span className="text-danger text-[11px] ml-1 min-w-0 truncate max-w-[300px]">
              — {activity.result}
            </span>
          )}

          {/* Elapsed time for running tools */}
          {activity.status === 'running' && activity.elapsedSeconds !== undefined && (
            <span className="text-xs text-text-muted ml-1 flex-shrink-0">
              {activity.elapsedSeconds}s
            </span>
          )}

          {/* Expand chevron — shown when input or result is long enough to be cropped */}
          {hasExpandableContent && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                toggleActivityExpand(activity.id)
              }}
              className="text-text-muted hover:text-text-primary flex-shrink-0 ml-auto p-0.5 rounded hover:bg-surface-hover transition-colors"
              aria-label={isActivityExpanded ? 'Collapse tool details' : 'Expand tool details'}
            >
              {isActivityExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            </button>
          )}
        </div>

        {/* Expand panel — monospace text block below tool row */}
        {isActivityExpanded && (activity.resultDetail || activity.result) && (
          <div className="ml-6 mt-1 rounded-md bg-surface-base border border-border-subtle p-2 max-h-80 overflow-y-auto">
            <pre className="text-[11px] text-text-muted font-mono whitespace-pre-wrap break-all leading-relaxed">
              {activity.resultDetail || activity.result}
            </pre>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="my-2">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
      >
        <Wrench size={12} />
        <span>
          {runningCount > 0
            ? `${activities.length} tool${activities.length > 1 ? 's' : ''} (${runningCount} running...)`
            : `${completedCount} tool${completedCount > 1 ? 's' : ''} used`}
        </span>
        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>

      {/* Always show running tools even when collapsed */}
      {!isExpanded && runningActivities.length > 0 && (
        <div className="mt-1.5 ml-4 space-y-1 border-l-2 border-border-subtle pl-3">
          {runningActivities.map(renderActivity)}
        </div>
      )}

      {/* Expanded: show all activities including completed */}
      {isExpanded && (
        <div className="mt-1.5 ml-4 space-y-1 border-l-2 border-border-subtle pl-3">
          {activities.map(renderActivity)}
        </div>
      )}
    </div>
  )
}
