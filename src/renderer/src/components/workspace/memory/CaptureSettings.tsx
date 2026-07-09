import { Upload, Sparkles } from 'lucide-react'

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
        <div className="text-sm text-primary">{label}</div>
        <div className="text-xs text-tertiary">{description}</div>
      </div>
      <div
        className={`relative w-9 h-5 rounded-full transition-colors ${
          checked ? 'bg-accent' : 'bg-border'
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

// ── Main Component ──

interface CaptureSettingsProps {
  captureSettings: MemoryCaptureSettings | null
  feedStatus: 'idle' | 'running' | 'completed' | 'error'
  feedMessage: string | null
  feedError: string | null
  onFeedDocument: () => void
  onRegenerateClaudeMd: () => void
  onUpdateSettings: (workspaceId: string, settings: Partial<MemoryCaptureSettings>) => void
  workspaceId: string
}

export default function CaptureSettings({
  captureSettings,
  feedStatus,
  feedMessage,
  feedError,
  onFeedDocument,
  onRegenerateClaudeMd,
  onUpdateSettings,
  workspaceId
}: CaptureSettingsProps): React.JSX.Element {
  return (
    <div className="space-y-4">
      <SettingsCard>
        <h3 className="text-sm font-medium text-text-primary">Document Feed</h3>
        <p className="text-xs text-text-secondary mt-0.5">Extract facts from documents and regenerate CLAUDE.md</p>
        <div className="flex gap-2 mt-3">
          <button
            onClick={onFeedDocument}
            disabled={feedStatus === 'running'}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-accent text-accent-foreground rounded-md hover:bg-accent/80 disabled:opacity-50"
          >
            <Upload className="w-4 h-4" /> Feed Document
          </button>
          <button
            onClick={onRegenerateClaudeMd}
            disabled={feedStatus === 'running'}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-secondary text-primary rounded-md hover:bg-hover disabled:opacity-50"
          >
            <Sparkles className="w-4 h-4" /> Regenerate CLAUDE.md
          </button>
        </div>
        {feedStatus !== 'idle' && (
          <div className="mt-2 text-xs">
            {feedStatus === 'running' && (
              <span className="text-info">{feedMessage}</span>
            )}
            {feedStatus === 'error' && (
              <span className="text-error">{feedError}</span>
            )}
            {feedStatus === 'completed' && (
              <span className="text-success">{feedMessage}</span>
            )}
          </div>
        )}
      </SettingsCard>

      {captureSettings && (
        <SettingsCard>
          <h3 className="text-sm font-medium text-text-primary">Automatic Capture</h3>
          <p className="text-xs text-text-secondary mt-0.5">Control which sources automatically extract facts</p>
          <div className="space-y-3 mt-3">
            <CaptureToggle
              label="Session transcripts"
              description="Extract facts from completed chat sessions"
              checked={captureSettings.sessionCapture}
              onChange={(v) => onUpdateSettings(workspaceId, { sessionCapture: v })}
            />
            <CaptureToggle
              label="Commit changes"
              description="Extract facts from git commits"
              checked={captureSettings.commitCapture}
              onChange={(v) => onUpdateSettings(workspaceId, { commitCapture: v })}
            />
            <CaptureToggle
              label="Document watcher"
              description="Watch docs for changes and extract facts"
              checked={captureSettings.docCapture}
              onChange={(v) => onUpdateSettings(workspaceId, { docCapture: v })}
            />
          </div>
        </SettingsCard>
      )}
    </div>
  )
}
