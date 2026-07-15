/**
 * ResultDetailPanel — inline transcript + assertion rendering (no overlay).
 *
 * Used in ResultDetailView (drill-in page), ScenarioCatalog, and RunsView.
 */

import { useEffect, useState, useMemo } from 'react'
import {
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Wrench,
  AlertTriangle,
  ExternalLink,
  Eye,
  EyeOff
} from 'lucide-react'
import type { E2EResultDetail, E2ETranscriptEntry, E2EAssertionResult } from '../../../../shared/types'
import { useChatActions } from '@renderer/store'

// ── Types ──

export interface ResultDetailPanelProps {
  resultId: string
  /** Optional — used in aria label */
  scenarioTitle?: string
}

/** Merged transcript entry — consecutive assistant/text entries collapsed into one */
interface MergedTranscriptEntry {
  kind: 'message' | 'tool_pair' | 'status' | 'error'
  role: 'user' | 'assistant' | 'system'
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  mergedCount: number
  timestamp: number
}

// ── Helpers ──

function isStatusEntry(entry: E2ETranscriptEntry): boolean {
  return entry.type === 'status'
}

function mergeTranscript(
  entries: E2ETranscriptEntry[],
  includeStatus: boolean
): MergedTranscriptEntry[] {
  const result: MergedTranscriptEntry[] = []
  let i = 0

  while (i < entries.length) {
    const entry = entries[i]

    if (isStatusEntry(entry)) {
      if (includeStatus) {
        result.push({
          kind: 'status',
          role: entry.role,
          content: entry.content ?? `[${entry.type}]`,
          mergedCount: 1,
          timestamp: entry.timestamp
        })
      }
      i++
      continue
    }

    if (entry.type === 'tool_use') {
      const next = entries[i + 1]
      const hasResult = next && next.type === 'tool_result'
      result.push({
        kind: 'tool_pair',
        role: entry.role,
        content: entry.content ?? '',
        toolName: entry.toolName,
        toolArgs: entry.toolArgs,
        toolResult: hasResult ? (next.toolResult ?? next.content ?? '') : undefined,
        mergedCount: hasResult ? 2 : 1,
        timestamp: entry.timestamp
      })
      i += hasResult ? 2 : 1
      continue
    }

    if (entry.type === 'tool_result') {
      result.push({
        kind: 'tool_pair',
        role: entry.role,
        content: '',
        toolName: entry.toolName ?? 'Tool',
        toolResult: entry.toolResult ?? entry.content ?? '',
        mergedCount: 1,
        timestamp: entry.timestamp
      })
      i++
      continue
    }

    if (entry.type === 'error') {
      result.push({
        kind: 'error',
        role: entry.role,
        content: entry.content ?? 'Unknown error',
        mergedCount: 1,
        timestamp: entry.timestamp
      })
      i++
      continue
    }

    if (entry.type === 'text' || entry.type === 'thinking') {
      const chunks: string[] = []
      const role = entry.role
      let count = 0
      const startTimestamp = entry.timestamp
      while (
        i < entries.length &&
        entries[i].role === role &&
        (entries[i].type === 'text' || entries[i].type === 'thinking') &&
        !isStatusEntry(entries[i])
      ) {
        if (entries[i].content) chunks.push(entries[i].content!)
        count++
        i++
      }
      result.push({
        kind: 'message',
        role,
        content: chunks.join(''),
        mergedCount: count,
        timestamp: startTimestamp
      })
      continue
    }

    result.push({
      kind: 'message',
      role: entry.role,
      content: entry.content ?? '',
      mergedCount: 1,
      timestamp: entry.timestamp
    })
    i++
  }

  return result
}

// ── Skeleton ──

function TranscriptSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-3 animate-pulse">
      {[1, 2, 3].map((n) => (
        <div key={n} className="space-y-2">
          <div className="h-3 w-16 bg-surface-base rounded" />
          <div className="h-12 bg-surface-base rounded" />
        </div>
      ))}
    </div>
  )
}

// ── Main component ──

export default function ResultDetailPanel({
  resultId,
  scenarioTitle
}: ResultDetailPanelProps): React.JSX.Element {
  const [detail, setDetail] = useState<E2EResultDetail | null>(null)
  const [showTranscript, setShowTranscript] = useState(true)
  const [showAssertions, setShowAssertions] = useState(true)
  const [showStatusEvents, setShowStatusEvents] = useState(false)
  const { selectConversation } = useChatActions()

  useEffect(() => {
    setDetail(null)
    window.api.testingGetResultDetail({ resultId }).then((d) => {
      if (d) setDetail(d)
    })
  }, [resultId])

  const statusCount = useMemo(
    () => detail?.transcriptJson.filter(isStatusEntry).length ?? 0,
    [detail]
  )
  const mergedEntries = useMemo(
    () => (detail ? mergeTranscript(detail.transcriptJson, showStatusEvents) : []),
    [detail, showStatusEvents]
  )

  return (
    <div
      className="p-4 space-y-4 bg-surface-overlay/50 border-t border-border-subtle"
      role="region"
      aria-label={scenarioTitle ? `Result details for ${scenarioTitle}` : 'Result details'}
    >
      {!detail ? (
        <TranscriptSkeleton />
      ) : (
        <>
          {/* Status + duration header */}
          <div className="flex items-center gap-2">
            <StatusBadge status={detail.status} />
            {detail.durationMs != null && (
              <span className="text-xs text-text-muted">
                {(detail.durationMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>

          {/* Failure reason */}
          {detail.failureReason && (
            <div className="p-3 rounded bg-danger/10 border border-danger/20">
              <div className="flex items-start gap-2">
                <AlertTriangle size={14} className="text-danger mt-0.5 shrink-0" />
                <p className="text-xs text-danger leading-relaxed">{detail.failureReason}</p>
              </div>
            </div>
          )}

          {/* Assertions */}
          <Section
            title={`Assertions (${detail.assertionResults.filter((a) => a.passed).length}/${detail.assertionResults.length})`}
            open={showAssertions}
            onToggle={() => setShowAssertions(!showAssertions)}
          >
            <div className="space-y-1">
              {detail.assertionResults.map((a, i) => (
                <AssertionRow key={i} assertion={a} />
              ))}
            </div>
          </Section>

          {/* Transcript */}
          <Section
            title={`Transcript (${mergedEntries.length} entries)`}
            open={showTranscript}
            onToggle={() => setShowTranscript(!showTranscript)}
          >
            <div className="space-y-2">
              {mergedEntries.map((entry, i) => (
                <MergedTranscriptRow key={i} entry={entry} />
              ))}
            </div>
            {statusCount > 0 && (
              <button
                onClick={() => setShowStatusEvents(!showStatusEvents)}
                className="flex items-center gap-1.5 mt-3 text-xs text-text-muted hover:text-text-secondary transition-colors"
              >
                {showStatusEvents ? <EyeOff size={12} /> : <Eye size={12} />}
                {showStatusEvents
                  ? 'Hide system events'
                  : `Show system events (${statusCount})`}
              </button>
            )}
          </Section>

          {/* Conversation link */}
          {detail.conversationId && (
            <div className="pt-2 border-t border-border-subtle">
              <button
                onClick={() => selectConversation(detail.conversationId!)}
                className="flex items-center gap-1.5 text-xs text-primary-text hover:underline transition-colors"
              >
                <ExternalLink size={12} />
                Open conversation
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Sub-components ──

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const colors: Record<string, string> = {
    passed: 'bg-success/20 text-success',
    failed: 'bg-danger/20 text-danger',
    error: 'bg-warning/20 text-warning',
    running: 'bg-info/20 text-info',
    queued: 'bg-surface-base text-text-muted',
    skipped: 'bg-surface-base text-text-muted'
  }
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded ${colors[status] ?? 'bg-surface-base text-text-muted'}`}>
      {status}
    </span>
  )
}

function Section({
  title,
  open,
  onToggle,
  children
}: {
  title: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 w-full text-left text-sm font-medium text-text-body hover:text-text-primary transition-colors"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {title}
      </button>
      {open && <div className="mt-2 pl-1">{children}</div>}
    </div>
  )
}

function AssertionRow({ assertion }: { assertion: E2EAssertionResult }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 py-1">
      {assertion.passed ? (
        <CheckCircle2 size={12} className="text-success mt-0.5 shrink-0" />
      ) : (
        <XCircle size={12} className="text-danger mt-0.5 shrink-0" />
      )}
      <div className="min-w-0">
        <span className="text-xs text-text-body font-mono">{assertion.name}</span>
        {assertion.reason && (
          <p className="text-xs text-text-muted mt-0.5">{assertion.reason}</p>
        )}
      </div>
    </div>
  )
}

function MergedTranscriptRow({ entry }: { entry: MergedTranscriptEntry }): React.JSX.Element {
  const [toolOpen, setToolOpen] = useState(false)

  if (entry.kind === 'status') {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-muted italic bg-surface-base/50 rounded border border-border-subtle/50">
        <span className="opacity-60">⊘</span>
        {entry.content}
      </div>
    )
  }

  if (entry.kind === 'error') {
    return (
      <div className="rounded-lg px-3 py-2 text-xs bg-danger/10 border border-danger/20">
        <div className="flex items-center gap-1.5 mb-1 text-text-muted">
          <AlertTriangle size={10} />
          <span className="font-medium">Error</span>
        </div>
        <pre className="whitespace-pre-wrap text-danger leading-relaxed">
          {entry.content}
        </pre>
      </div>
    )
  }

  if (entry.kind === 'tool_pair') {
    return (
      <div className="rounded-lg border border-border-subtle overflow-hidden">
        <button
          onClick={() => setToolOpen(!toolOpen)}
          className="flex items-center gap-1.5 w-full px-3 py-2 text-left text-xs bg-surface-base hover:bg-surface-raised transition-colors"
        >
          <Wrench size={10} className="text-text-muted shrink-0" />
          <span className="font-medium text-text-body">{entry.toolName ?? 'Tool'}</span>
          <span className="ml-auto text-text-muted">
            {toolOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        </button>
        {toolOpen && (
          <div className="px-3 py-2 space-y-2 border-t border-border-subtle bg-surface-overlay/50">
            {entry.toolArgs && (
              <div>
                <span className="text-xs text-text-muted font-medium block mb-1">Arguments</span>
                <pre className="whitespace-pre-wrap text-xs text-text-secondary leading-relaxed">
                  {JSON.stringify(entry.toolArgs, null, 2).slice(0, 2000)}
                </pre>
              </div>
            )}
            {entry.toolResult !== undefined && (
              <div>
                <span className="text-xs text-text-muted font-medium block mb-1">Result</span>
                <pre className="whitespace-pre-wrap text-xs text-text-secondary leading-relaxed">
                  {entry.toolResult.length > 2000
                    ? entry.toolResult.slice(0, 2000) + '…'
                    : entry.toolResult}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  const isUser = entry.role === 'user'

  return (
    <div
      className={`rounded-lg px-3 py-2 text-xs ${
        isUser
          ? 'bg-primary-muted/30 border border-primary-muted/40'
          : 'bg-surface-raised border border-border-subtle'
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1 text-text-muted">
        <MessageSquare size={10} />
        <span className="font-medium">{isUser ? 'User' : entry.role}</span>
        {entry.mergedCount > 1 && (
          <span className="text-text-muted/60">· {entry.mergedCount} chunks merged</span>
        )}
      </div>
      {entry.content && (
        <pre className="whitespace-pre-wrap text-text-body leading-relaxed">
          {entry.content.length > 4000
            ? entry.content.slice(0, 4000) + '…'
            : entry.content}
        </pre>
      )}
    </div>
  )
}
