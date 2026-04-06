import { useState } from 'react'
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react'
import type { ToolActivity } from '../../../../shared/types'

/**
 * Shortens long absolute paths to show `…/parentFolder/file.ext`.
 * Handles paths with spaces, command strings containing paths, and Grep summaries.
 */
function shortenInput(input: string): string {
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
function getToolDisplayName(toolName: string): string {
  const MCP_DISPLAY_NAMES: Record<string, string> = {
    'mcp__code-graph__repo_map': 'Code Graph · repo_map',
    'mcp__code-graph__search_identifiers': 'Code Graph · search_identifiers',
    'mcp__semantic-search__semantic_search': 'Semantic Search',
    'mcp__git-context__git_log': 'Git · log',
    'mcp__git-context__git_diff': 'Git · diff',
    'mcp__git-context__git_blame': 'Git · blame',
    'mcp__task-context__list_tasks': 'Tasks · list',
    'mcp__task-context__get_task_output': 'Tasks · output',
    'mcp__checkpoint-context__list_checkpoints': 'Checkpoints · list',
    'mcp__checkpoint-context__get_checkpoint': 'Checkpoints · get',
    'mcp__github-context__get_pr_status': 'GitHub · PR status',
    'mcp__github-context__list_pr_comments': 'GitHub · PR comments',
    'mcp__github-context__list_issues': 'GitHub · issues'
  }
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
}

export default function ToolActivityBlock({
  activities
}: ToolActivityBlockProps): React.JSX.Element | null {
  const [isExpanded, setIsExpanded] = useState(false)

  if (activities.length === 0) return null

  const completedCount = activities.filter((a) => a.status === 'completed').length
  const runningCount = activities.filter((a) => a.status === 'running').length
  const runningActivities = activities.filter((a) => a.status === 'running')

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
          {runningActivities.map((activity) => (
            <div key={activity.id} className="flex items-center gap-2 text-xs">
              <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
              <span className="font-mono text-text-body">{getToolDisplayName(activity.toolName)}</span>
              {activity.input && (
                <span className="text-text-muted truncate max-w-[300px]" title={activity.input}>
                  {shortenInput(activity.input)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Expanded: show all activities including completed */}
      {isExpanded && (
        <div className="mt-1.5 ml-4 space-y-1 border-l-2 border-border-subtle pl-3">
          {activities.map((activity) => (
            <div key={activity.id} className="flex items-center gap-2 text-xs">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  activity.status === 'running'
                    ? 'bg-warning animate-pulse'
                    : activity.status === 'completed'
                      ? 'bg-success'
                      : 'bg-danger'
                }`}
              />
              <span className="font-mono text-text-body">{getToolDisplayName(activity.toolName)}</span>
              {activity.input && (
                <span className="text-text-muted truncate max-w-[300px]" title={activity.input}>
                  {shortenInput(activity.input)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
