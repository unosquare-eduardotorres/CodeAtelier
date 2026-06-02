import { MCP_TOOLS } from '../../shared/constants'

/**
 * Strips a workspace prefix to produce a relative display path.
 */
function toRelativePath(absolutePath: string, workspacePath?: string): string {
  if (!workspacePath || !absolutePath.startsWith(workspacePath)) return absolutePath
  const relative = absolutePath.slice(workspacePath.length)
  return relative.startsWith('/') ? relative.slice(1) : relative
}

// ── Strategy types for data-driven summarization ──

type Strategy =
  | { type: 'field'; field: string; transform?: 'path' }
  | { type: 'fields'; fields: string[]; transform?: 'path' }
  | { type: 'template'; fn: (input: Record<string, unknown>, wp?: string) => string }
  | { type: 'static'; value: string }

/** Resolve a single strategy to a string */
function resolveStrategy(
  strategy: Strategy,
  input: Record<string, unknown>,
  workspacePath?: string
): string {
  switch (strategy.type) {
    case 'field': {
      const val = (input[strategy.field] as string) || ''
      return strategy.transform === 'path' ? toRelativePath(val, workspacePath) : val
    }
    case 'fields': {
      for (const f of strategy.fields) {
        const val = input[f] as string
        if (val) return strategy.transform === 'path' ? toRelativePath(val, workspacePath) : val
      }
      return ''
    }
    case 'template':
      return strategy.fn(input, workspacePath)
    case 'static':
      return strategy.value
  }
}

// ── Strategy map: tool name → summarization strategy ──

const STRATEGIES: Record<string, Strategy> = {
  // Built-in SDK tools
  Bash: { type: 'field', field: 'command' },
  Read: {
    type: 'template',
    fn: (i, wp) => {
      const path = toRelativePath((i.file_path as string) || '', wp)
      const offset = i.offset as number | undefined
      const limit = i.limit as number | undefined
      if (offset && limit) return `${path} (lines ${offset}–${offset + limit - 1})`
      if (offset) return `${path} (from line ${offset})`
      return path
    }
  },
  Write: {
    type: 'template',
    fn: (i, wp) => {
      const path = toRelativePath((i.file_path as string) || '', wp)
      const content = i.content as string | undefined
      const lineCount = content?.split('\n').length ?? 0
      return lineCount > 0 ? `${path} (${lineCount} lines)` : path
    }
  },
  Edit: {
    type: 'template',
    fn: (i, wp) => {
      const path = toRelativePath((i.file_path as string) || '', wp)
      const edits = i.edits as Array<{ old_string?: string }> | undefined
      const editCount = edits?.length ?? 0
      if (editCount > 1) return `${path} (${editCount} edits)`
      const oldStr = edits?.[0]?.old_string
      if (oldStr) {
        const preview = oldStr.replace(/\n/g, '↵').slice(0, 30)
        return `${path} → "${preview}${oldStr.length > 30 ? '…' : ''}"`
      }
      return path
    }
  },
  Grep: {
    type: 'template',
    fn: (i, wp) =>
      `/${i.pattern as string}/` + (i.path ? ` in ${toRelativePath(i.path as string, wp)}` : '')
  },
  Glob: { type: 'field', field: 'pattern' },
  WebSearch: { type: 'field', field: 'query' },
  WebFetch: { type: 'field', field: 'url' },
  // Task management tools — all share one label
  TodoRead: { type: 'static', value: 'Task management' },
  TodoWrite: { type: 'static', value: 'Task management' },
  TaskCreate: { type: 'static', value: 'Task management' },
  TaskGet: { type: 'static', value: 'Task management' },
  TaskUpdate: { type: 'static', value: 'Task management' },
  TaskList: { type: 'static', value: 'Task management' },
  TaskOutput: {
    type: 'template',
    fn: (i) => `Reading output of task ${(i.id as string)?.slice(0, 7) ?? ''}…`
  },

  // MCP tools: Code Graph — Phase 1
  [MCP_TOOLS.CODE_GRAPH.GRAPH_MAP.name]: {
    type: 'template',
    fn: (i) =>
      `graph_map${i.focusFiles ? ` (focus: ${(i.focusFiles as string[]).length} files)` : ''}`
  },
  [MCP_TOOLS.CODE_GRAPH.SEARCH_IDENTIFIERS.name]: {
    type: 'template',
    fn: (i) => `search: ${(i.query as string) || ''}`
  },
  [MCP_TOOLS.CODE_GRAPH.FIND_DEAD_CODE.name]: {
    type: 'template',
    fn: (i) => `dead code${i.path ? ` in ${i.path}` : ''}`
  },

  // MCP tools: Code Graph — Phase 2 (Navigation)
  [MCP_TOOLS.CODE_GRAPH.FILE_OUTLINE.name]: {
    type: 'template',
    fn: (i, wp) => `outline: ${toRelativePath((i.filePath as string) || '', wp)}`
  },
  [MCP_TOOLS.CODE_GRAPH.FIND_CALLERS.name]: {
    type: 'template',
    fn: (i) => `callers of: ${(i.symbolName as string) || ''}`
  },
  [MCP_TOOLS.CODE_GRAPH.FIND_CALLEES.name]: {
    type: 'template',
    fn: (i) => `callees of: ${(i.symbolName as string) || ''}`
  },
  [MCP_TOOLS.CODE_GRAPH.FIND_REFERENCES.name]: {
    type: 'template',
    fn: (i) => `refs: ${(i.symbolName as string) || ''}`
  },
  [MCP_TOOLS.CODE_GRAPH.FILE_DEPENDENCIES.name]: {
    type: 'template',
    fn: (i, wp) => `deps: ${toRelativePath((i.filePath as string) || '', wp)}`
  },
  [MCP_TOOLS.CODE_GRAPH.FILE_DEPENDENTS.name]: {
    type: 'template',
    fn: (i, wp) => `dependents: ${toRelativePath((i.filePath as string) || '', wp)}`
  },

  // MCP tools: Code Graph — Phase 3 (Analysis)
  [MCP_TOOLS.CODE_GRAPH.SYMBOL_HOTSPOTS.name]: {
    type: 'template',
    fn: (i) => `hotspots${i.path ? ` in ${i.path}` : ''}`
  },
  [MCP_TOOLS.CODE_GRAPH.COUPLING_ANALYSIS.name]: {
    type: 'template',
    fn: (i) => `coupling${i.path ? ` in ${i.path}` : ''}`
  },
  [MCP_TOOLS.CODE_GRAPH.CIRCULAR_DEPENDENCIES.name]: {
    type: 'template',
    fn: (i) => `cycles${i.path ? ` in ${i.path}` : ''}`
  },
  [MCP_TOOLS.CODE_GRAPH.MODULE_BOUNDARY_HEALTH.name]: {
    type: 'template',
    fn: (i) => `boundaries (depth: ${i.depth ?? 2})`
  },

  // MCP tools: Code Analysis
  [MCP_TOOLS.CODE_ANALYSIS.TODO_SCANNER.name]: { type: 'static', value: 'scan TODOs' },
  [MCP_TOOLS.CODE_ANALYSIS.DEPENDENCY_HEALTH.name]: { type: 'static', value: 'dependency health' },
  [MCP_TOOLS.CODE_ANALYSIS.TEST_COVERAGE_MAP.name]: { type: 'static', value: 'test coverage map' },

  // MCP tools: Semantic Search
  [MCP_TOOLS.SEMANTIC_SEARCH.SEMANTIC_SEARCH.name]: {
    type: 'template',
    fn: (i) => `semantic: ${(i.query as string) || ''}`
  },

  // MCP tools: Git Context
  [MCP_TOOLS.GIT_CONTEXT.GIT_LOG.name]: {
    type: 'template',
    fn: (i, wp) => `git log${i.path ? ` ${toRelativePath(i.path as string, wp)}` : ''}`
  },
  [MCP_TOOLS.GIT_CONTEXT.GIT_DIFF.name]: {
    type: 'template',
    fn: (i, wp) => `git diff${i.path ? ` ${toRelativePath(i.path as string, wp)}` : ''}`
  },
  [MCP_TOOLS.GIT_CONTEXT.GIT_BLAME.name]: {
    type: 'template',
    fn: (i, wp) => `git blame ${toRelativePath((i.path as string) || '', wp)}`
  },

  // MCP tools: Checkpoint Context
  [MCP_TOOLS.CHECKPOINT_CONTEXT.LIST_CHECKPOINTS.name]: {
    type: 'static',
    value: 'list checkpoints'
  },
  [MCP_TOOLS.CHECKPOINT_CONTEXT.GET_CHECKPOINT.name]: {
    type: 'template',
    fn: (i) => `checkpoint ${(i.checkpointId as string)?.slice(0, 7) ?? ''}…`
  },

  // MCP tools: GitHub Context
  [MCP_TOOLS.GITHUB_CONTEXT.GET_PR_STATUS.name]: {
    type: 'template',
    fn: (i) => `PR #${(i.prNumber as string) || ''}`
  },
  [MCP_TOOLS.GITHUB_CONTEXT.LIST_PR_COMMENTS.name]: {
    type: 'template',
    fn: (i) => `PR #${(i.prNumber as string) || ''} comments`
  },
  [MCP_TOOLS.GITHUB_CONTEXT.LIST_ISSUES.name]: { type: 'static', value: 'list issues' }
}

/**
 * Extracts a human-readable summary from raw tool input for display in the UI.
 * Uses a data-driven strategy map instead of a switch statement.
 */
export function summarizeToolInput(
  toolName: string,
  input: Record<string, unknown>,
  workspacePath?: string
): string {
  const strategy = STRATEGIES[toolName]
  if (strategy) return resolveStrategy(strategy, input, workspacePath)

  // Generic MCP tool fallback — extract server + tool name for any unhandled MCP tools
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__')
    return parts.length >= 3 ? `${parts[1]}/${parts[2]}` : toolName
  }

  return ''
}
