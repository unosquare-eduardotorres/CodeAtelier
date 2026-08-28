/**
 * GateCommandsSection — workspace settings surface for `settings.gateCommands`
 * (M9.5).
 *
 * Human-typed overrides for the deterministic gate commands (build/lint/test/
 * smoke). Highest precedence — beats the PLAN phase's declaration and disk
 * detection. Values are validated client-side with `isSafeGateCommand` /
 * `isSafeGateCwd` before save: a command with shell metacharacters would be
 * rejected by the resolver anyway, so the editor says so up front.
 *
 * Provenance display: each kind shows where the currently-effective command
 * comes from (override / declared / detected) from the resolved set.
 */

import { useState, type JSX } from 'react'
import { ShieldCheck, AlertTriangle } from 'lucide-react'
import {
  isSafeGateCommand,
  isSafeGateCwd,
  type GateCommandKind,
  type GateCommandSet
} from '../../../../../shared/gate-command-types'

const KIND_LABELS: Record<GateCommandKind, { label: string; hint: string }> = {
  build: { label: 'Build', hint: 'e.g. npm run build' },
  lint: { label: 'Lint', hint: 'e.g. npm run lint' },
  test: { label: 'Test', hint: 'e.g. npm run test:unit' },
  smoke: { label: 'Smoke', hint: 'e.g. npm run smoke' }
}

const KINDS: GateCommandKind[] = ['build', 'lint', 'test', 'smoke']

export default function GateCommandsSection({
  workspaceId,
  gateCommands,
  resolved,
  onSave
}: {
  workspaceId: string
  /** Current overrides from workspace settings (settings.gateCommands). */
  gateCommands: GateCommandSet | undefined
  /** The resolved set — for provenance display (override/declared/detected). */
  resolved?: Partial<Record<GateCommandKind, { command: string; provenance: string }>>
  onSave: (workspaceId: string, commands: GateCommandSet) => Promise<void>
}): JSX.Element {
  const [draft, setDraft] = useState<GateCommandSet>(gateCommands ?? {})
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const setKind = (kind: GateCommandKind, command: string, cwd?: string): void => {
    setDraft((prev) => {
      const next = { ...prev }
      if (command.trim() === '' && !cwd) delete next[kind]
      else next[kind] = { command: command.trim(), ...(cwd ? { cwd } : {}) }
      return next
    })
  }

  const setKindCwd = (kind: GateCommandKind, cwd: string): void => {
    setDraft((prev) => {
      const existing = prev[kind]
      if (!existing) return prev
      const next = { ...prev }
      if (cwd.trim() === '') {
        const { cwd: _drop, ...rest } = existing
        next[kind] = rest
      } else {
        next[kind] = { ...existing, cwd: cwd.trim() }
      }
      return next
    })
  }

  // Client-side validation — the same predicates the resolver applies.
  const invalid: Partial<Record<GateCommandKind, string>> = {}
  for (const kind of KINDS) {
    const entry = draft[kind]
    if (!entry) continue
    if (entry.command && !isSafeGateCommand(entry.command)) {
      invalid[kind] =
        'Unsafe command — plain commands only, no shell metacharacters (; | & > < $ ( ) { })'
    } else if (!isSafeGateCwd(entry.cwd)) {
      invalid[kind] = 'Unsafe working directory — must be a relative path inside the workspace'
    }
  }
  const hasInvalid = Object.keys(invalid).length > 0

  const save = async (): Promise<void> => {
    if (hasInvalid) return
    setSaving(true)
    setError(null)
    try {
      await onSave(workspaceId, draft)
      setSavedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      data-testid="gate-commands-section"
      className="rounded-xl border border-border-subtle bg-surface-raised p-4 space-y-3"
    >
      <div className="flex items-start gap-2">
        <ShieldCheck size={14} className="text-text-muted mt-0.5" />
        <div className="flex-1">
          <h3 className="text-sm font-medium text-text-primary">Quality Gate Commands</h3>
          <p className="text-xs text-text-secondary mt-0.5">
            Overrides for the deterministic gates the Blueprint build runs. Highest precedence —
            beats the plan&apos;s declaration and disk detection. Leave a field empty to fall
            through.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {KINDS.map((kind) => {
          const entry = draft[kind]
          const provenance = resolved?.[kind]?.provenance
          return (
            <div key={kind} className="flex items-center gap-2">
              <label className="text-xs font-medium text-text-secondary w-14 shrink-0">
                {KIND_LABELS[kind].label}
              </label>
              <input
                type="text"
                value={entry?.command ?? ''}
                onChange={(e) => setKind(kind, e.target.value, entry?.cwd)}
                placeholder={KIND_LABELS[kind].hint}
                data-testid={`gate-command-${kind}`}
                className={`flex-1 text-xs font-mono bg-surface-inset border rounded-lg px-2 py-1.5 text-text-primary placeholder:text-text-muted focus:outline-none ${
                  invalid[kind]
                    ? 'border-danger/50 focus:border-danger'
                    : 'border-border-subtle focus:border-accent'
                }`}
              />
              <input
                type="text"
                value={entry?.cwd ?? ''}
                onChange={(e) => setKindCwd(kind, e.target.value)}
                placeholder="cwd (optional)"
                data-testid={`gate-command-${kind}-cwd`}
                disabled={!entry}
                className="w-32 text-xs font-mono bg-surface-inset border border-border-subtle rounded-lg px-2 py-1.5 text-text-secondary placeholder:text-text-muted focus:outline-none focus:border-accent disabled:opacity-40"
              />
              {/* Provenance of the currently-effective command */}
              <span
                className="text-[10px] text-text-muted w-16 shrink-0 text-right"
                title={
                  resolved?.[kind]
                    ? `Effective: ${resolved[kind]!.command} (${resolved[kind]!.provenance})`
                    : 'No command resolved — the gate reports unverifiable/no_command'
                }
              >
                {entry
                  ? 'override'
                  : provenance
                    ? `← ${provenance}`
                    : '← none'}
              </span>
            </div>
          )
        })}
      </div>

      {hasInvalid && (
        <div className="flex items-start gap-2 text-xs text-danger">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <div className="space-y-0.5">
            {Object.entries(invalid).map(([kind, msg]) => (
              <p key={kind}>
                <span className="font-semibold capitalize">{kind}:</span> {msg}
              </p>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || hasInvalid}
          data-testid="gate-commands-save"
          className="text-xs font-medium px-3 py-1.5 rounded-lg bg-accent text-white hover:bg-accent/80 disabled:opacity-40 transition-colors"
        >
          {saving ? 'Saving…' : 'Save gate commands'}
        </button>
        {savedAt && !error && (
          <span className="text-xs text-success">Saved — applies to the next gate run</span>
        )}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </div>
  )
}
