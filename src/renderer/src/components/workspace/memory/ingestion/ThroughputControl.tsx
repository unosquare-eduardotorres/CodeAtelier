import { SettingsCard } from '@renderer/components/common'
import { PanelHeader } from '@renderer/components/common/ui'
import type { MemoryCaptureSettings } from '../../../../../../shared/types'

interface ThroughputControlProps {
  captureSettings: MemoryCaptureSettings
  onUpdateSettings: (workspaceId: string, settings: Partial<MemoryCaptureSettings>) => void
  workspaceId: string
}

/**
 * Feed Brain concurrency. Sits with Bootstrap rather than in the capture
 * settings list — it only affects the run started from that pane.
 */
export default function ThroughputControl({
  captureSettings,
  onUpdateSettings,
  workspaceId
}: ThroughputControlProps): React.JSX.Element {
  return (
    <SettingsCard>
      <PanelHeader
        title="Feed Brain Throughput"
        description="How many documents Feed Brain extracts at once. Each one spawns a Claude CLI process — raise this to finish sooner, lower it if you hit API rate limits. Takes effect on the next run; default 3."
      />
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
          aria-label="Feed Brain concurrency"
          className="flex-1 accent-teal"
        />
        <span className="text-sm font-mono text-text-primary w-6 text-right tabular-nums">
          {captureSettings.bootstrapConcurrency}
        </span>
      </div>
    </SettingsCard>
  )
}
