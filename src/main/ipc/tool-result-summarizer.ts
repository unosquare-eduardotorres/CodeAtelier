/**
 * ToolResultSummarizer — registry-based tool result summarization.
 * Replaces the 257-line extractResultSummary function with focused per-tool handlers.
 */

import { MCP_TOOLS } from '../../shared/constants'

/** Return type — short summary + optional expanded detail */
export interface ToolResultSummary {
  result: string
  resultDetail?: string
}

/** Cap for resultDetail content — ~2K chars */
const DETAIL_CAP = 2048

type Summarizer = (content: string) => ToolResultSummary | undefined

// ── Helper: pluralize a count ──

function pluralize(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? singular + 's')}`
}

// ── Global pre-checks (run before tool-specific handlers) ──

function checkPersistedOutput(content: string): ToolResultSummary | undefined {
  if (content.includes('<persisted-output>') || content.includes('persisted-output')) {
    return {
      result: 'Result too large to display',
      resultDetail:
        'Output was persisted by the SDK. Check .claude/ directory for the full result.'
    }
  }
  return undefined
}

function checkToolUseError(content: string): ToolResultSummary | undefined {
  if (!content.includes('<tool_use_error>')) return undefined

  const match = content.match(/<tool_use_error>([\s\S]*?)(?:<\/tool_use_error>|$)/)
  const inner = (match?.[1] ?? content).trim()

  if (/modified since read/i.test(inner))
    return { result: 'Stale read — re-read needed', resultDetail: inner.slice(0, DETAIL_CAP) }
  if (/string to replace not found/i.test(inner))
    return { result: 'String not found — re-read needed', resultDetail: inner.slice(0, DETAIL_CAP) }
  if (/permission denied|EACCES|operation not permitted/i.test(inner))
    return { result: 'Permission denied', resultDetail: inner.slice(0, DETAIL_CAP) }

  const oneLine = inner.split('\n')[0]?.trim() ?? 'Tool error'
  const shortResult =
    oneLine.length > 80 ? `Error: ${oneLine.slice(0, 77)}…` : `Error: ${oneLine}`
  return { result: shortResult, resultDetail: inner.slice(0, DETAIL_CAP) }
}

// ── SDK builtin tool handlers ──

const summarizeWrite: Summarizer = () => ({ result: 'Done' })

const summarizeBash: Summarizer = (content) => {
  const lines = content.split('\n').filter((l) => l.trim())
  if (lines.length === 0) return { result: 'No output' }

  if (content.includes('exit code')) {
    const exitMatch = content.match(/exit code[:\s]*(\d+)/i)
    if (exitMatch) {
      const shortResult =
        exitMatch[1] === '0' ? 'Success (exit 0)' : `Failed (exit ${exitMatch[1]})`
      return {
        result: shortResult,
        resultDetail: lines.length > 1 ? content.slice(0, DETAIL_CAP) : undefined
      }
    }
  }

  const firstLine = lines[0].trim()
  const shortResult = firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine
  return {
    result: shortResult,
    resultDetail: lines.length > 1 ? content.slice(0, DETAIL_CAP) : undefined
  }
}

const summarizeRead: Summarizer = (content) => {
  const lineCount = content.split('\n').length
  return { result: `${lineCount} line${lineCount !== 1 ? 's' : ''} read` }
}

const summarizeGrep: Summarizer = (content) => {
  const matchLines = content.split('\n').filter((l) => l.trim())
  const detail = matchLines.slice(0, 30).join('\n')
  return {
    result: pluralize(matchLines.length, 'match', 'matches'),
    resultDetail: detail.length > 0 ? detail.slice(0, DETAIL_CAP) : undefined
  }
}

const summarizeGlob: Summarizer = (content) => {
  const fileLines = content.split('\n').filter((l) => l.trim())
  const detail = fileLines.slice(0, 50).join('\n')
  return {
    result: `${fileLines.length} file${fileLines.length !== 1 ? 's' : ''} found`,
    resultDetail: detail.length > 0 ? detail.slice(0, DETAIL_CAP) : undefined
  }
}

// ── Exact-name handler registry ──

const EXACT_HANDLERS: Record<string, Summarizer> = {
  Write: summarizeWrite,
  Edit: summarizeWrite,
  Bash: summarizeBash,
  Read: summarizeRead,
  Grep: summarizeGrep,
  Glob: summarizeGlob
}

// ── MCP prefix-based handlers ──

function summarizeCodeGraph(content: string): ToolResultSummary | undefined {
  try {
    const parsed = JSON.parse(content)
    const detail = content.slice(0, DETAIL_CAP)

    if (parsed.symbols?.length !== undefined) return { result: pluralize(parsed.symbols.length, 'symbol'), resultDetail: detail }
    if (parsed.callers?.length !== undefined) return { result: pluralize(parsed.callers.length, 'caller'), resultDetail: detail }
    if (parsed.references?.length !== undefined) return { result: pluralize(parsed.references.length, 'reference'), resultDetail: detail }
    if (parsed.callees?.length !== undefined) return { result: pluralize(parsed.callees.length, 'callee'), resultDetail: detail }
    if (parsed.outline?.length !== undefined) return { result: `${parsed.outline.length} symbol${parsed.outline.length !== 1 ? 's' : ''} in outline`, resultDetail: detail }
    if (parsed.coupledPairs?.length !== undefined) return { result: pluralize(parsed.coupledPairs.length, 'coupled pair'), resultDetail: detail }
    if (parsed.cycles?.length !== undefined) return { result: pluralize(parsed.cycles.length, 'cycle'), resultDetail: detail }
    if (parsed.boundaries?.length !== undefined) return { result: `${parsed.boundaries.length} module boundar${parsed.boundaries.length !== 1 ? 'ies' : 'y'}`, resultDetail: detail }
    if (parsed.count !== undefined) return { result: pluralize(parsed.count, 'result'), resultDetail: detail }
    if (parsed.definitions?.length !== undefined) return { result: pluralize(parsed.definitions.length, 'definition'), resultDetail: detail }
    if (parsed.report) return { result: `${parsed.report.filesIncluded ?? '?'} files mapped`, resultDetail: detail }

    // Generic fallback — find the first top-level array
    const firstArr = Object.entries(parsed).find(([, v]) => Array.isArray(v)) as [string, unknown[]] | undefined
    if (firstArr) return { result: `${firstArr[1].length} ${firstArr[0]}`, resultDetail: detail }
  } catch {
    /* fall through to default */
  }
  return undefined
}

function summarizeCodeAnalysis(content: string): ToolResultSummary | undefined {
  try {
    const parsed = JSON.parse(content)
    const detail = content.slice(0, DETAIL_CAP)

    if (parsed.totalCount !== undefined) {
      const mode = parsed.mode === 'overview' ? ' (overview)' : ''
      return { result: `${parsed.totalCount} marker${parsed.totalCount !== 1 ? 's' : ''} found${mode}`, resultDetail: detail }
    }
    if (parsed.summary?.totalSourceFiles !== undefined) {
      const s = parsed.summary
      const mode = parsed.mode === 'overview' ? ' (overview)' : ''
      return { result: `${s.filesWithTests}/${s.totalSourceFiles} covered (${Math.round(s.coverageRatio * 100)}%)${mode}`, resultDetail: detail }
    }
    if (parsed.counts?.total !== undefined) {
      const c = parsed.counts
      const outdated = c.outdated > 0 ? `, ${c.outdated} outdated` : ''
      return { result: `${c.total} deps (${c.production} prod, ${c.dev} dev${outdated})`, resultDetail: detail }
    }
    if (parsed.count !== undefined) {
      return { result: pluralize(parsed.count, 'result'), resultDetail: detail }
    }
  } catch {
    /* fall through */
  }
  return undefined
}

function summarizeGitContext(content: string): ToolResultSummary | undefined {
  try {
    const parsed = JSON.parse(content)
    const detail = content.slice(0, DETAIL_CAP)

    if (parsed.commits?.length !== undefined) return { result: pluralize(parsed.commits.length, 'commit'), resultDetail: detail }
    if (parsed.hunks?.length !== undefined) return { result: pluralize(parsed.hunks.length, 'diff hunk'), resultDetail: detail }
    if (parsed.lines?.length !== undefined) return { result: pluralize(parsed.lines.length, 'blame line'), resultDetail: detail }
  } catch {
    /* fall through */
  }
  return undefined
}

function summarizeSemanticSearch(content: string): ToolResultSummary | undefined {
  try {
    const parsed = JSON.parse(content)
    const detail = content.slice(0, DETAIL_CAP)

    if (parsed.results?.length !== undefined) return { result: pluralize(parsed.results.length, 'result'), resultDetail: detail }
    if (parsed.concepts?.length !== undefined) return { result: pluralize(parsed.concepts.length, 'concept'), resultDetail: detail }
  } catch {
    /* fall through */
  }
  return undefined
}

// ── Prefix-handler pairs (checked in order) ──

const PREFIX_HANDLERS: Array<{ prefix: string; handler: Summarizer }> = [
  { prefix: MCP_TOOLS.CODE_GRAPH._PREFIX, handler: summarizeCodeGraph },
  { prefix: MCP_TOOLS.CODE_ANALYSIS._PREFIX, handler: summarizeCodeAnalysis },
  { prefix: MCP_TOOLS.GIT_CONTEXT._PREFIX, handler: summarizeGitContext },
  { prefix: MCP_TOOLS.SEMANTIC_SEARCH._PREFIX, handler: summarizeSemanticSearch }
]

// ── Default fallback ──

function defaultSummary(content: string): ToolResultSummary | undefined {
  const firstLine = content.split('\n')[0]?.trim()
  if (!firstLine) return undefined
  const shortResult = firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine
  const hasMore = content.length > firstLine.length + 1
  return { result: shortResult, resultDetail: hasMore ? content.slice(0, DETAIL_CAP) : undefined }
}

// ── Public API ──

/**
 * Extracts a brief human-readable result summary from a tool result.
 * Returns both a short `result` (one-line) and an optional `resultDetail`
 * (expanded text, up to ~2K chars) for the expand panel in ToolActivityBlock.
 */
export function extractResultSummary(
  toolName: string,
  content: string | undefined
): ToolResultSummary | undefined {
  if (!content) return undefined
  try {
    // Global pre-checks
    const persisted = checkPersistedOutput(content)
    if (persisted) return persisted

    const toolError = checkToolUseError(content)
    if (toolError) return toolError

    // Exact name match (SDK built-in tools)
    const exactHandler = EXACT_HANDLERS[toolName]
    if (exactHandler) return exactHandler(content)

    // Prefix match (MCP tools)
    for (const { prefix, handler } of PREFIX_HANDLERS) {
      if (toolName.startsWith(prefix)) {
        const result = handler(content)
        if (result) return result
      }
    }

    // Default fallback
    return defaultSummary(content)
  } catch {
    return undefined
  }
}
