import { useState, useEffect } from 'react'
import { copyTextToClipboard } from '@renderer/utils/clipboard'
import {
  CheckCircle,
  Trash2,
  Copy,
  Check,
  Undo2,
  ChevronDown,
  ChevronRight,
  Monitor,
  Layout,
  Plug,
  AlertTriangle,
  Skull,
  Clock,
  Cpu,
  Globe,
  Eye,
  User,
  FolderOpen,
  FileCode2,
  Layers,
  Plus,
  Pencil
} from 'lucide-react'
import type { BugRecord } from '../../../../shared/types'
import { parseDbTimestamp } from '../../../../shared/db-time'

interface BugDetailProps {
  bug: BugRecord
  onResolve: (id: string) => void
  onUnresolve: (id: string) => void
  onDelete: (id: string) => void
  onUpdateNote: (id: string, note: string) => void
}

const PROCESS_ICON = {
  main: Monitor,
  renderer: Layout,
  preload: Plug
} as const

function formatTimestamp(iso: string): string {
  return parseDbTimestamp(iso).toLocaleString()
}

/* ── Collapsible Section ────────────────────────────────────────────── */

function CollapsibleSection({
  title,
  icon,
  defaultOpen = true,
  children
}: {
  title: string
  icon?: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-raised/40">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-raised/50 transition-colors"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {icon && <span className="text-text-muted shrink-0">{icon}</span>}
        <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
          {title}
        </span>
      </button>
      {open && <div className="px-3 py-2.5">{children}</div>}
    </div>
  )
}

/* ── Info Item ──────────────────────────────────────────────────────── */

function InfoItem({
  icon,
  label,
  value,
  mono
}: {
  icon?: React.ReactNode
  label: string
  value: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-1.5">
      {icon && <span className="text-text-muted mt-0.5 shrink-0">{icon}</span>}
      <div>
        <dt className="text-[10px] font-medium text-text-muted uppercase tracking-wide">
          {label}
        </dt>
        <dd
          className={`text-xs text-text-secondary mt-0.5 truncate ${mono ? 'font-mono' : ''}`}
          title={value}
        >
          {value}
        </dd>
      </div>
    </div>
  )
}

/* ── Bug Detail ─────────────────────────────────────────────────────── */

export default function BugDetail({
  bug,
  onResolve,
  onUnresolve,
  onDelete,
  onUpdateNote
}: BugDetailProps): React.JSX.Element {
  const [note, setNote] = useState(bug.note ?? '')
  const [isEditingNote, setIsEditingNote] = useState(false)
  const [isSavingNote, setIsSavingNote] = useState(false)
  const [copiedStack, setCopiedStack] = useState(false)
  const [stackOpen, setStackOpen] = useState(true)

  // Reset local state when bug changes
  useEffect(() => {
    setNote(bug.note ?? '')
    setIsEditingNote(false)
    setCopiedStack(false)
  }, [bug.id, bug.note])

  const ProcessIcon = PROCESS_ICON[bug.process] ?? Monitor

  const handleCopyStack = async (): Promise<void> => {
    if (bug.stackTrace && await copyTextToClipboard(bug.stackTrace)) {
      setCopiedStack(true)
      setTimeout(() => setCopiedStack(false), 2000)
    }
  }

  const handleSaveNote = async (): Promise<void> => {
    setIsSavingNote(true)
    await onUpdateNote(bug.id, note)
    setIsSavingNote(false)
    setIsEditingNote(false)
  }

  return (
    <div data-testid="bug-detail-panel" className="flex flex-col h-full overflow-y-auto p-4 gap-4">
      {/* ── Section 1: Header ─────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {/* Severity badge */}
          <div
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-semibold uppercase ${
              bug.severity === 'fatal'
                ? 'bg-danger/20 text-danger'
                : 'bg-warning/20 text-warning'
            }`}
          >
            {bug.severity === 'fatal' ? <Skull size={12} /> : <AlertTriangle size={12} />}
            {bug.severity}
          </div>

          {/* Error message */}
          <h2 className="text-base font-semibold text-text-primary mt-2 break-words leading-relaxed">
            {bug.errorMessage}
          </h2>

          {/* Inline metadata row */}
          <div className="flex items-center gap-3 mt-2 text-xs text-text-muted">
            <span className="inline-flex items-center gap-1">
              <ProcessIcon size={11} /> {bug.process}
            </span>
            <span>·</span>
            <span>
              {bug.occurrenceCount} occurrence{bug.occurrenceCount !== 1 ? 's' : ''}
            </span>
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              <Clock size={11} /> {formatTimestamp(bug.timestamp)} → {formatTimestamp(bug.lastSeenAt)}
            </span>
          </div>
        </div>
      </div>

      {/* ── Section 2: Actions ────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        {/* Primary actions */}
        {bug.isResolved ? (
          <button
            onClick={() => onUnresolve(bug.id)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-surface-overlay border border-border-subtle rounded-md hover:bg-surface-base text-text-secondary transition-colors"
          >
            <Undo2 size={14} /> Reopen
          </button>
        ) : (
          <button
            onClick={() => onResolve(bug.id)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-emerald-500/10 border border-emerald-500/20 rounded-md hover:bg-emerald-500/20 text-emerald-400 transition-colors"
          >
            <CheckCircle size={14} /> Mark Resolved
          </button>
        )}
        {bug.stackTrace && (
          <button
            onClick={handleCopyStack}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-surface-overlay border border-border-subtle rounded-md hover:bg-surface-base text-text-secondary transition-colors"
            title="Copy stack trace"
          >
            {copiedStack ? <Check size={14} /> : <Copy size={14} />} Copy Stack
          </button>
        )}

        {/* Divider + destructive action */}
        <div className="flex-1" />
        <div className="w-px h-5 bg-border-subtle" />
        <button
          onClick={() => onDelete(bug.id)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-red-500/10 border border-red-500/20 rounded-md hover:bg-red-500/20 text-red-400 transition-colors"
        >
          <Trash2 size={14} /> Delete
        </button>
      </div>

      {/* ── Section 3: Stack Trace (collapsible, error-styled) ──── */}
      {bug.stackTrace && (
        <div className="rounded-lg border border-danger/20 overflow-hidden">
          <div className="flex items-center justify-between w-full px-3 py-2 bg-danger/10">
            <button
              onClick={() => setStackOpen(!stackOpen)}
              className="flex items-center gap-1.5 text-xs font-semibold text-danger hover:bg-danger/15 transition-colors rounded px-1 -ml-1"
            >
              {stackOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              Stack Trace
            </button>
            <button
              onClick={handleCopyStack}
              className="text-xs text-text-muted hover:text-text-secondary transition-colors inline-flex items-center gap-1"
            >
              {copiedStack ? <Check size={12} /> : <Copy size={12} />} Copy
            </button>
          </div>
          {stackOpen && (
            <pre className="p-3 text-xs font-mono text-text-secondary bg-danger/5 overflow-x-auto max-h-64 whitespace-pre-wrap">
              {bug.stackTrace}
            </pre>
          )}
        </div>
      )}

      {/* ── Section 4: Environment (only fields with values) ────── */}
      <CollapsibleSection title="Environment" icon={<Globe size={14} />} defaultOpen>
        <div className="grid grid-cols-2 gap-3">
          {bug.sourceFile && (
            <InfoItem
              icon={<FileCode2 size={11} />}
              label="Source"
              value={`${bug.sourceFile}${bug.sourceLine != null ? `:${bug.sourceLine}` : ''}${bug.sourceColumn != null ? `:${bug.sourceColumn}` : ''}`}
              mono
            />
          )}
          {bug.componentName && (
            <InfoItem icon={<Layers size={11} />} label="Component" value={bug.componentName} />
          )}
          <InfoItem icon={<Cpu size={11} />} label="App Version" value={bug.appVersion} />
          {bug.osInfo && (
            <InfoItem icon={<Globe size={11} />} label="OS" value={bug.osInfo} />
          )}
          {bug.workspaceId && (
            <InfoItem
              icon={<FolderOpen size={11} />}
              label="Workspace"
              value={bug.workspaceId}
              mono
            />
          )}
          {bug.agentId && (
            <InfoItem icon={<User size={11} />} label="Agent" value={bug.agentId} />
          )}
          {bug.activeView && (
            <InfoItem icon={<Eye size={11} />} label="Active View" value={bug.activeView} />
          )}
        </div>
      </CollapsibleSection>

      {/* ── Section 5: Notes (collapsed when empty) ────────────── */}
      {bug.note ? (
        <CollapsibleSection title="Note" icon={<Pencil size={14} />} defaultOpen>
          {isEditingNote ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-surface-overlay border border-border-subtle rounded-md text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 resize-y min-h-[60px]"
                rows={3}
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSaveNote}
                  disabled={isSavingNote}
                  className="px-3 py-1.5 text-sm bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isSavingNote ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => {
                    setNote(bug.note ?? '')
                    setIsEditingNote(false)
                  }}
                  className="px-3 py-1.5 text-sm bg-surface-overlay border border-border-subtle rounded-md hover:bg-surface-base text-text-secondary transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <p className="text-sm text-text-secondary flex-1 whitespace-pre-wrap">{bug.note}</p>
              <button
                onClick={() => setIsEditingNote(true)}
                className="p-1 rounded hover:bg-surface-base text-text-muted hover:text-text-secondary transition-colors shrink-0"
                title="Edit note"
              >
                <Pencil size={12} />
              </button>
            </div>
          )}
        </CollapsibleSection>
      ) : isEditingNote ? (
        <div className="rounded-lg border border-border-subtle bg-surface-raised/40 p-3">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note about this bug..."
            className="w-full px-3 py-2 text-sm bg-surface-overlay border border-border-subtle rounded-md text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 resize-y min-h-[60px]"
            rows={3}
            autoFocus
          />
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={handleSaveNote}
              disabled={isSavingNote || !note.trim()}
              className="px-3 py-1.5 text-sm bg-primary text-white rounded-md hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSavingNote ? 'Saving...' : 'Save'}
            </button>
            <button
              onClick={() => {
                setNote('')
                setIsEditingNote(false)
              }}
              className="px-3 py-1.5 text-sm bg-surface-overlay border border-border-subtle rounded-md hover:bg-surface-base text-text-secondary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setIsEditingNote(true)}
          className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
        >
          <Plus size={12} /> Add Note
        </button>
      )}
    </div>
  )
}
