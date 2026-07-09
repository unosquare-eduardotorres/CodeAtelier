import { useEffect, useRef, useState, useCallback, type JSX } from 'react'
import { Terminal, AlertTriangle, StopCircle, ChevronDown, Copy, Check } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { PHASE_ICONS, type PhaseIconKey } from './phase-icons'
import type { StreamEvent } from '@renderer/store/blueprint.store'
import { stripBlueprintBlocks } from '../../../../../shared/blueprint-clarify-parsers'

// ── Stale detection threshold ──

const STALE_THRESHOLD_MS = 90_000 // 90 seconds
/** Distance from bottom (px) to consider "pinned" to live scroll */
const SCROLL_PIN_THRESHOLD = 60

interface BlueprintPhaseStreamProps {
  phaseType: string
  streamText: string
  /** Timestamp (Date.now()) when the current phase started */
  phaseStartedAt?: number | null
  /** Timestamp (Date.now()) of the last stream chunk received */
  lastChunkAt?: number | null
  /** Whether the pipeline is actively running */
  isRunning?: boolean
  /** Cancel callback for the stale warning shortcut */
  onCancel?: () => void
  /** Structured stream events (text + tool badges) */
  streamEvents?: StreamEvent[]
  /** B5-FIX: Suppress stale warning when user action is awaited */
  awaitingUser?: boolean
}

// ── Elapsed time formatter ──

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
}

// ── Tool badge component ──

function ToolBadge({ name }: { name: string }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 py-1 text-text-muted">
      <span className="text-[10px] text-text-muted">▸</span>
      <span className="text-xs font-mono text-text-muted truncate">{name}</span>
    </div>
  )
}

export default function BlueprintPhaseStream({
  phaseType,
  streamText,
  phaseStartedAt,
  lastChunkAt,
  isRunning = false,
  onCancel,
  streamEvents,
  awaitingUser = false
}: BlueprintPhaseStreamProps): JSX.Element {
  // B4-FIX: Strip fenced JSON blocks from clarify stream display
  const displayText = phaseType === 'clarify' ? stripBlueprintBlocks(streamText) : streamText
  const scrollRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(Date.now())
  const [isPinned, setIsPinned] = useState(true)
  const [copied, setCopied] = useState(false)

  // ── Smart auto-scroll (sticky-bottom pattern) ──
  const checkIfPinned = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setIsPinned(distanceFromBottom < SCROLL_PIN_THRESHOLD)
  }, [])

  // Auto-scroll only when pinned
  useEffect(() => {
    if (isPinned && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [streamText, isPinned, streamEvents?.length])

  // Track scroll position
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', checkIfPinned, { passive: true })
    return () => el.removeEventListener('scroll', checkIfPinned)
  }, [checkIfPinned])

  // Jump to bottom
  const jumpToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      setIsPinned(true)
    }
  }, [])

  // Tick every second for elapsed time display
  // B5-FIX: Pause the ticker while awaiting user action (no need to show stale time)
  useEffect(() => {
    if (!isRunning || awaitingUser) return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [isRunning, awaitingUser])

  // Copy stream text to clipboard
  const handleCopy = useCallback(() => {
    if (!streamText) return
    navigator.clipboard.writeText(streamText).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [streamText])

  const iconConfig = PHASE_ICONS[phaseType as PhaseIconKey]
  const Icon = iconConfig?.icon ?? Terminal
  const phaseLabel = iconConfig?.label ?? phaseType

  // Elapsed time since phase started
  const elapsed = phaseStartedAt ? now - phaseStartedAt : null
  // Time since last chunk (clamp to 0 — chunk timestamps can race the 1s tick)
  const lastActivityAgo = lastChunkAt ? Math.max(0, now - lastChunkAt) : null
  // Stale detection — B5-FIX: suppress when awaiting user action
  const isStale = isRunning && !awaitingUser && lastActivityAgo !== null && lastActivityAgo > STALE_THRESHOLD_MS

  // Extract tool events from stream events
  const toolEvents = streamEvents?.filter((e) => e.kind === 'tool') ?? []

  return (
    <div className="flex flex-col h-full min-h-0 relative">
      {/* Header with activity indicator */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle">
        <Icon size={14} className={isRunning ? 'text-accent' : 'text-text-muted'} />
        <span className="text-xs font-medium text-text-secondary">{phaseLabel} Output</span>

        {/* Live / Paused chip */}
        {isRunning && (
          <span
            className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
              isPinned
                ? 'bg-success-muted text-success'
                : 'bg-surface-float text-text-muted'
            }`}
          >
            {isPinned ? '● Live' : 'Paused'}
          </span>
        )}

        {/* Right side: elapsed, copy, activity */}
        <div className="ml-auto flex items-center gap-3 text-[10px] text-text-muted">
          {elapsed !== null && (
            <span className="tabular-nums">{formatElapsed(elapsed)}</span>
          )}
          {isRunning && lastActivityAgo !== null && (
            <span className={isStale ? 'text-warning' : ''}>
              last activity {formatElapsed(lastActivityAgo)} ago
            </span>
          )}
          {streamText && (
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-surface-overlay transition-colors"
              title="Copy output"
            >
              {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            </button>
          )}
          {isRunning && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
          )}
        </div>
      </div>

      {/* Stale warning banner */}
      {isStale && (
        <div className="flex items-center gap-2 px-3 py-2 bg-warning-muted border-b border-warning/20 text-warning text-xs">
          <AlertTriangle size={14} className="flex-shrink-0" />
          <span className="flex-1">
            No output for {formatElapsed(lastActivityAgo!)} — the agent may be working on a long
            tool call
          </span>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-warning hover:text-text-primary bg-warning/15 hover:bg-warning/25 rounded transition-colors"
            >
              <StopCircle size={10} />
              Stop
            </button>
          )}
        </div>
      )}

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4"
      >
        {displayText ? (
          <div className="space-y-1">
            {/* B4-FIX: Render displayText (stripped of fenced blocks for clarify) */}
            <div className="prose prose-sm max-w-none text-text-body
              prose-headings:text-text-primary prose-headings:font-semibold
              prose-p:leading-relaxed prose-p:text-sm
              prose-code:font-mono prose-code:text-xs prose-code:bg-surface-base prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-accent prose-code:before:content-none prose-code:after:content-none
              prose-pre:bg-surface-base prose-pre:border prose-pre:border-border-subtle prose-pre:rounded-lg
              prose-strong:text-text-primary prose-strong:font-semibold
              prose-a:text-accent prose-a:no-underline hover:prose-a:underline
              prose-li:text-sm prose-li:text-text-body
              prose-th:text-text-secondary prose-td:text-text-body
            ">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                {displayText}
              </ReactMarkdown>
            </div>

            {/* Tool activity badges */}
            {toolEvents.length > 0 && (
              <div className="border-t border-border-subtle/50 pt-1 mt-2">
                {toolEvents.slice(-10).map((event, i) => (
                  <ToolBadge key={i} name={event.content} />
                ))}
              </div>
            )}

            {/* Pulsing cursor while live */}
            {isRunning && (
              <span className="inline-block w-1.5 h-4 bg-accent/60 animate-pulse ml-0.5 align-text-bottom" />
            )}
          </div>
        ) : (
          <span className="text-text-muted text-sm animate-pulse">Waiting for agent output...</span>
        )}
      </div>

      {/* Jump to latest pill (when unpinned) */}
      {!isPinned && isRunning && (
        <button
          type="button"
          onClick={jumpToBottom}
          className="absolute bottom-4 right-4 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium
            bg-surface-float border border-border-default rounded-full shadow-lg
            hover:bg-surface-overlay transition-colors text-text-secondary"
        >
          <ChevronDown size={14} />
          Jump to latest
        </button>
      )}
    </div>
  )
}
