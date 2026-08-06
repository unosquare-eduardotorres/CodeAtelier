import { useState } from 'react'
import { Upload, Plus, X, FolderDown } from 'lucide-react'

import { SettingsCard } from '@renderer/components/common'
import type { MemoryCaptureSettings } from '../../../../../shared/types'

// ── Sub-components ──

function CaptureToggle({
  label,
  description,
  checked,
  onChange
}: {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer">
      <div>
        <div className="text-sm text-text-primary">{label}</div>
        <div className="text-xs text-text-muted">{description}</div>
      </div>
      <div
        className={`relative w-9 h-5 rounded-full transition-colors ${
          checked ? 'bg-teal' : 'bg-surface-float border border-border-default'
        }`}
        onClick={() => onChange(!checked)}
      >
        <div
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-4' : ''
          }`}
        />
      </div>
    </label>
  )
}

/**
 * Editor for the extra instruction-file globs.
 *
 * Standard locations (AGENTS.md, .cursor/rules, nested CLAUDE.md, …) are found
 * automatically; this list is only for layouts that put them elsewhere, so it
 * starts empty and stays small.
 */
function GlobListEditor({
  globs,
  onChange
}: {
  globs: string[]
  onChange: (next: string[]) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')

  const add = (): void => {
    const value = draft.trim()
    if (!value || globs.includes(value)) return
    onChange([...globs, value])
    setDraft('')
  }

  return (
    <div className="mt-3">
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          placeholder="packages/*/AGENTS.md"
          className="flex-1 px-2 py-1.5 text-sm bg-surface-float border border-border-default rounded-md text-text-primary placeholder:text-text-muted"
        />
        <button
          onClick={add}
          disabled={!draft.trim()}
          className="flex items-center gap-1 px-2.5 py-1.5 text-sm bg-primary-muted text-primary-text border border-border-default rounded-md hover:bg-primary/20 disabled:opacity-50"
        >
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
      </div>

      {globs.length > 0 && (
        <ul className="mt-2 space-y-1">
          {globs.map((glob) => (
            <li
              key={glob}
              className="flex items-center justify-between gap-2 px-2 py-1 bg-surface-float border border-border-default rounded text-xs"
            >
              <span className="font-mono text-text-secondary truncate">{glob}</span>
              <button
                onClick={() => onChange(globs.filter((g) => g !== glob))}
                title="Remove"
                className="p-0.5 text-text-muted hover:text-danger shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── Main Component ──

interface CaptureSettingsProps {
  captureSettings: MemoryCaptureSettings | null
  feedStatus: 'idle' | 'running' | 'completed' | 'error'
  feedMessage: string | null
  feedError: string | null
  onFeedDocument: () => void
  onUpdateSettings: (workspaceId: string, settings: Partial<MemoryCaptureSettings>) => void
  workspaceId: string
  workspacePath: string
}

export default function CaptureSettings({
  captureSettings,
  feedStatus,
  feedMessage,
  feedError,
  onFeedDocument,
  onUpdateSettings,
  workspaceId,
  workspacePath
}: CaptureSettingsProps): React.JSX.Element {
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  const handleExport = async (): Promise<void> => {
    setExporting(true)
    setExportResult(null)
    setExportError(null)
    try {
      const result = await window.api.memoryProjectExport({ workspaceId, workspacePath })
      setExportResult(
        `Wrote ${result.factsProjected} fact(s) to ${result.indexPath}` +
          (result.factsPruned > 0 ? ` (${result.factsPruned} pruned from the index)` : '')
      )
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-4">
      <SettingsCard>
        <h3 className="text-sm font-medium text-text-primary">Document Feed</h3>
        <p className="text-xs text-text-secondary mt-0.5">Extract memories from documents</p>
        <div className="flex gap-2 mt-3">
          <button
            onClick={onFeedDocument}
            disabled={feedStatus === 'running'}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary-muted text-primary-text border border-border-default rounded-md hover:bg-primary/20 disabled:opacity-50"
          >
            <Upload className="w-4 h-4" /> Feed Document
          </button>
        </div>
        {feedStatus !== 'idle' && (
          <div className="mt-2 text-xs">
            {feedStatus === 'running' && <span className="text-info">{feedMessage}</span>}
            {feedStatus === 'error' && <span className="text-danger">{feedError}</span>}
            {feedStatus === 'completed' && <span className="text-success">{feedMessage}</span>}
          </div>
        )}
      </SettingsCard>

      {captureSettings && (
        <SettingsCard>
          <h3 className="text-sm font-medium text-text-primary">Automatic Capture</h3>
          <p className="text-xs text-text-secondary mt-0.5">
            Control which sources automatically extract memories
          </p>
          <div className="space-y-3 mt-3">
            <CaptureToggle
              label="Session transcripts"
              description="Extract memories from completed chat sessions"
              checked={captureSettings.sessionCapture}
              onChange={(v) => onUpdateSettings(workspaceId, { sessionCapture: v })}
            />
            <CaptureToggle
              label="Commit changes"
              description="Extract memories from git commits"
              checked={captureSettings.commitCapture}
              onChange={(v) => onUpdateSettings(workspaceId, { commitCapture: v })}
            />
            <CaptureToggle
              label="Document watcher"
              description="Watch docs for changes and extract memories"
              checked={captureSettings.docCapture}
              onChange={(v) => onUpdateSettings(workspaceId, { docCapture: v })}
            />
            <CaptureToggle
              label="Blueprint lifecycle"
              description="Capture decisions from blueprint approvals, completions, and failures"
              checked={captureSettings.captureBlueprints}
              onChange={(v) => onUpdateSettings(workspaceId, { captureBlueprints: v })}
            />
            <CaptureToggle
              label="Chat plan execution"
              description="Extract memories when chat plan executions complete"
              checked={captureSettings.capturePlans}
              onChange={(v) => onUpdateSettings(workspaceId, { capturePlans: v })}
            />
            <CaptureToggle
              label="Grill decisions"
              description="Extract memories from grill evaluations and structured plans"
              checked={captureSettings.captureGrill}
              onChange={(v) => onUpdateSettings(workspaceId, { captureGrill: v })}
            />
            <CaptureToggle
              label="Document attachments"
              description="Extract memories when documents are attached to blueprints"
              checked={captureSettings.captureDocumentsOnAttach}
              onChange={(v) => onUpdateSettings(workspaceId, { captureDocumentsOnAttach: v })}
            />
            <CaptureToggle
              label="Code rationales"
              description="Mine // WHY:, // NOTE:, // HACK:, // GOTCHA: comments and ADR/RFC citations while indexing (off by default)"
              checked={captureSettings.captureRationales}
              onChange={(v) => onUpdateSettings(workspaceId, { captureRationales: v })}
            />
            <CaptureToggle
              label="Reflection"
              description="Let an idle pass summarise clusters of similar memories into one parent fact. Costs money; proposals wait for your approval (off by default)"
              checked={captureSettings.reflectionEnabled}
              onChange={(v) => onUpdateSettings(workspaceId, { reflectionEnabled: v })}
            />
          </div>
        </SettingsCard>
      )}

      {captureSettings && (
        <SettingsCard>
          <h3 className="text-sm font-medium text-text-primary">Extra Instruction Files</h3>
          <p className="text-xs text-text-secondary mt-0.5">
            Globs for agent rule files to load into the prompt alongside CLAUDE.md. Standard
            locations (AGENTS.md, .cursor/rules, .clinerules, nested CLAUDE.md) are already found
            automatically — add globs here only for unusual layouts.
          </p>
          <GlobListEditor
            globs={captureSettings.instructionSources}
            onChange={(next) => onUpdateSettings(workspaceId, { instructionSources: next })}
          />
        </SettingsCard>
      )}

      {captureSettings && (
        <SettingsCard>
          <h3 className="text-sm font-medium text-text-primary">Markdown Export</h3>
          <p className="text-xs text-text-secondary mt-0.5">
            Mirror the fact database to <code className="font-mono">.agentstudio/memory/</code> so
            it is reviewable in a diff. This writes files into your repository — decide whether to
            commit or ignore that directory before turning it on.
          </p>
          <div className="space-y-3 mt-3">
            <CaptureToggle
              label="Export after Feed Brain"
              description="Regenerate the markdown automatically at the end of every run (off by default)"
              checked={captureSettings.projectionEnabled}
              onChange={(v) => onUpdateSettings(workspaceId, { projectionEnabled: v })}
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleExport()}
                disabled={exporting}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary-muted text-primary-text border border-border-default rounded-md hover:bg-primary/20 disabled:opacity-50"
              >
                <FolderDown className="w-4 h-4" /> {exporting ? 'Exporting…' : 'Export now'}
              </button>
            </div>
            {exportResult && <p className="text-xs text-success">{exportResult}</p>}
            {exportError && <p className="text-xs text-danger">{exportError}</p>}
          </div>
        </SettingsCard>
      )}

      {captureSettings && (
        <SettingsCard>
          <h3 className="text-sm font-medium text-text-primary">Feed Brain Throughput</h3>
          <p className="text-xs text-text-secondary mt-0.5">
            How many documents Feed Brain extracts at once. Each one spawns a Claude CLI process —
            raise this to finish sooner, lower it if you hit API rate limits.
          </p>
          <div className="flex items-center gap-3 mt-3">
            <input
              type="range"
              min={1}
              max={6}
              step={1}
              value={captureSettings.bootstrapConcurrency}
              onChange={(e) =>
                onUpdateSettings(workspaceId, { bootstrapConcurrency: Number(e.target.value) })
              }
              className="flex-1 accent-teal"
            />
            <span className="text-sm font-mono text-text-primary w-6 text-right tabular-nums">
              {captureSettings.bootstrapConcurrency}
            </span>
          </div>
          <p className="text-[10px] text-text-muted mt-1">
            Takes effect on the next run. Default 3.
          </p>
        </SettingsCard>
      )}
    </div>
  )
}
