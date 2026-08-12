import { SettingsCard } from '@renderer/components/common'
import { PanelHeader, Switch, Tooltip } from '@renderer/components/common/ui'
import GlobListEditor from './GlobListEditor'
import type { MemoryCaptureSettings } from '../../../../../../shared/types'

interface CapturePanelProps {
  captureSettings: MemoryCaptureSettings
  onUpdateSettings: (workspaceId: string, settings: Partial<MemoryCaptureSettings>) => void
  workspaceId: string
}

/** Marks the two settings that spend API tokens. */
function CostBadge(): React.JSX.Element {
  return (
    <Tooltip content="Runs a model — this setting costs API tokens">
      <span className="px-1 py-0.5 rounded bg-warning-muted text-warning text-[11px] font-mono">
        $
      </span>
    </Tooltip>
  )
}

/**
 * Automatic capture, grouped by what the toggle actually does.
 *
 * Nine switches at equal weight gave no signal about which ones spend money;
 * they are now split into Sources / Pipelines / Advanced with the paid ones
 * marked.
 */
export default function CapturePanel({
  captureSettings,
  onUpdateSettings,
  workspaceId
}: CapturePanelProps): React.JSX.Element {
  const set = (patch: Partial<MemoryCaptureSettings>): void => onUpdateSettings(workspaceId, patch)

  return (
    <div className="space-y-4">
      <SettingsCard>
        <PanelHeader title="Sources" description="Where memories are extracted from as you work." />
        <div className="space-y-3 mt-3">
          <Switch
            label="Session transcripts"
            description="Extract memories from completed chat sessions"
            checked={captureSettings.sessionCapture}
            onChange={(v) => set({ sessionCapture: v })}
          />
          <Switch
            label="Commit changes"
            description="Extract memories from git commits"
            checked={captureSettings.commitCapture}
            onChange={(v) => set({ commitCapture: v })}
          />
          <Switch
            label="Document watcher"
            description="Watch docs for changes and extract memories"
            checked={captureSettings.docCapture}
            onChange={(v) => set({ docCapture: v })}
          />
        </div>
      </SettingsCard>

      <SettingsCard>
        <PanelHeader
          title="Pipelines"
          description="Capture decisions made by the structured workflows."
        />
        <div className="space-y-3 mt-3">
          <Switch
            label="Blueprint lifecycle"
            description="Capture decisions from blueprint approvals, completions, and failures"
            checked={captureSettings.captureBlueprints}
            onChange={(v) => set({ captureBlueprints: v })}
          />
          <Switch
            label="Chat plan execution"
            description="Extract memories when chat plan executions complete"
            checked={captureSettings.capturePlans}
            onChange={(v) => set({ capturePlans: v })}
          />
          <Switch
            label="Grill decisions"
            description="Extract memories from grill evaluations and structured plans"
            checked={captureSettings.captureGrill}
            onChange={(v) => set({ captureGrill: v })}
          />
          <Switch
            label="Document attachments"
            description="Extract memories when documents are attached to blueprints"
            checked={captureSettings.captureDocumentsOnAttach}
            onChange={(v) => set({ captureDocumentsOnAttach: v })}
          />
        </div>
      </SettingsCard>

      <SettingsCard>
        <PanelHeader
          title="Advanced"
          description="Off by default — these run extra passes and consume API tokens."
        />
        <div className="space-y-3 mt-3">
          <Switch
            label="Code rationales"
            badge={<CostBadge />}
            description="Mine // WHY:, // NOTE:, // HACK:, // GOTCHA: comments and ADR/RFC citations while indexing"
            checked={captureSettings.captureRationales}
            onChange={(v) => set({ captureRationales: v })}
          />
          <Switch
            label="Reflection"
            badge={<CostBadge />}
            description="Let an idle pass summarise clusters of similar memories into one parent fact. Proposals wait for your approval"
            checked={captureSettings.reflectionEnabled}
            onChange={(v) => set({ reflectionEnabled: v })}
          />
        </div>
      </SettingsCard>

      <SettingsCard>
        <PanelHeader
          title="Extra Instruction Files"
          description="Globs for agent rule files to load into the prompt alongside CLAUDE.md. Standard locations (AGENTS.md, .cursor/rules, .clinerules, nested CLAUDE.md) are already found automatically — add globs here only for unusual layouts."
        />
        <GlobListEditor
          globs={captureSettings.instructionSources}
          onChange={(next) => set({ instructionSources: next })}
        />
      </SettingsCard>
    </div>
  )
}
