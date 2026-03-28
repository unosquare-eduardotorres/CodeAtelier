import { useState, useEffect } from 'react'
import { ScrollText, ChevronDown, ChevronRight, Inbox } from 'lucide-react'

interface EventRecord {
  id: string
  sessionId: string | null
  conversationId: string | null
  workspaceId: string | null
  eventType: string
  category: string
  message: string
  dataJson: string
  agentId: string | null
  model: string | null
  createdAt: string
}

const CATEGORIES = [
  'all',
  'session',
  'agent',
  'escalation',
  'gate',
  'abandonment',
  'checkpoint',
  'hook',
  'budget',
  'error'
] as const

const CATEGORY_STYLES: Record<string, { bg: string; text: string }> = {
  session: { bg: 'bg-blue-500/15', text: 'text-blue-400' },
  agent: { bg: 'bg-indigo-500/15', text: 'text-indigo-400' },
  escalation: { bg: 'bg-orange-500/15', text: 'text-orange-400' },
  gate: { bg: 'bg-green-500/15', text: 'text-green-400' },
  abandonment: { bg: 'bg-yellow-500/15', text: 'text-yellow-400' },
  checkpoint: { bg: 'bg-purple-500/15', text: 'text-purple-400' },
  hook: { bg: 'bg-cyan-500/15', text: 'text-cyan-400' },
  budget: { bg: 'bg-amber-500/15', text: 'text-amber-400' },
  error: { bg: 'bg-red-500/15', text: 'text-red-400' }
}

function formatEventTime(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatEventDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / 86_400_000)

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function EventLogPage(): React.JSX.Element {
  const [events, setEvents] = useState<EventRecord[]>([])
  const [filter, setFilter] = useState<string>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [limit, setLimit] = useState(200)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true)
    window.api
      .getRecentEvents({ limit })
      .then((data) => {
        if (!cancelled) setEvents(data)
      })
      .catch((err) => console.error('Failed to load events:', err))
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [limit])

  const filtered = filter === 'all' ? events : events.filter((e) => e.category === filter)

  const toggleExpand = (id: string): void => {
    setExpandedId(expandedId === id ? null : id)
  }

  const parseDataJson = (json: string): string => {
    try {
      return JSON.stringify(JSON.parse(json), null, 2)
    } catch {
      return json
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-center gap-2 mb-6">
        <ScrollText size={18} className="text-rose-400" />
        <h2 className="text-base font-semibold text-text-primary">Event Log</h2>
        <span className="text-xs text-text-muted ml-auto">
          {filtered.length} event{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Category filter pills */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => setFilter(cat)}
            className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${
              filter === cat
                ? 'bg-primary-muted text-primary-text border border-primary/20'
                : 'bg-surface-overlay text-text-secondary hover:text-text-primary border border-border-subtle'
            }`}
          >
            {cat === 'all' ? 'All' : cat.charAt(0).toUpperCase() + cat.slice(1)}
          </button>
        ))}
      </div>

      {/* Event table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <div className="text-sm text-text-secondary">Loading events...</div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center bg-surface-overlay/30 rounded-xl border border-border-subtle">
          <Inbox size={28} className="text-border-default mb-2" />
          <p className="text-sm text-text-secondary">No events found</p>
          <p className="text-xs text-text-muted mt-1">
            {filter !== 'all'
              ? `No "${filter}" events recorded yet`
              : 'Events will appear here as agents run'}
          </p>
        </div>
      ) : (
        <div className="bg-surface-overlay border border-border-subtle rounded-xl overflow-hidden shadow-sm">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border-subtle text-xs text-text-secondary uppercase tracking-wider">
                <th className="text-left px-4 py-2.5 font-medium w-8" />
                <th className="text-left px-4 py-2.5 font-medium w-28">Time</th>
                <th className="text-left px-4 py-2.5 font-medium w-28">Category</th>
                <th className="text-left px-4 py-2.5 font-medium w-36">Agent</th>
                <th className="text-left px-4 py-2.5 font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((event) => {
                const catStyle = CATEGORY_STYLES[event.category] ?? {
                  bg: 'bg-gray-500/15',
                  text: 'text-gray-400'
                }
                const isExpanded = expandedId === event.id
                return (
                  <tr
                    key={event.id}
                    className="border-b border-border-subtle/50 last:border-b-0 hover:bg-surface-overlay/50 cursor-pointer"
                    onClick={() => toggleExpand(event.id)}
                  >
                    <td className="px-4 py-2.5">
                      {isExpanded ? (
                        <ChevronDown size={12} className="text-text-muted" />
                      ) : (
                        <ChevronRight size={12} className="text-text-muted" />
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="text-xs text-text-secondary font-mono">
                        {formatEventTime(event.createdAt)}
                      </div>
                      <div className="text-[10px] text-text-muted">
                        {formatEventDate(event.createdAt)}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${catStyle.bg} ${catStyle.text}`}
                      >
                        {event.category}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-xs text-text-body truncate block max-w-[140px]">
                        {event.agentId ?? '—'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-xs text-text-primary">{event.message}</span>
                      {isExpanded && event.dataJson && event.dataJson !== '{}' && (
                        <div className="mt-2 bg-surface-base rounded p-2 max-h-48 overflow-y-auto">
                          <pre className="text-[11px] text-text-body whitespace-pre-wrap font-mono">
                            {parseDataJson(event.dataJson)}
                          </pre>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {/* Load more */}
          {events.length >= limit && (
            <div className="flex justify-center py-3 border-t border-border-subtle">
              <button
                onClick={() => setLimit((prev) => prev + 200)}
                className="text-xs text-primary-text hover:underline font-medium"
              >
                Load more events
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
