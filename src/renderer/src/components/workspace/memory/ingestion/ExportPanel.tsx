import { useState } from 'react'
import { FolderDown } from 'lucide-react'

import { SettingsCard } from '@renderer/components/common'
import { Button, PanelHeader, Switch } from '@renderer/components/common/ui'
import type { MemoryCaptureSettings } from '../../../../../../shared/types'

interface ExportPanelProps {
  captureSettings: MemoryCaptureSettings
  onUpdateSettings: (workspaceId: string, settings: Partial<MemoryCaptureSettings>) => void
  workspaceId: string
  workspacePath: string
}

/** Mirrors the fact database to `.agentstudio/memory/` as reviewable markdown. */
export default function ExportPanel({
  captureSettings,
  onUpdateSettings,
  workspaceId,
  workspacePath
}: ExportPanelProps): React.JSX.Element {
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleExport = async (): Promise<void> => {
    setExporting(true)
    setResult(null)
    setError(null)
    try {
      const res = await window.api.memoryProjectExport({ workspaceId, workspacePath })
      setResult(
        `Wrote ${res.factsProjected} fact(s) to ${res.indexPath}` +
          (res.factsPruned > 0 ? ` (${res.factsPruned} pruned from the index)` : '')
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }

  return (
    <SettingsCard>
      <PanelHeader
        title="Markdown Export"
        description={
          <>
            Mirror the fact database to <code className="font-mono">.agentstudio/memory/</code> so
            it is reviewable in a diff. This writes files into your repository — decide whether to
            commit or ignore that directory before turning it on.
          </>
        }
        actions={
          <Button
            variant="secondary"
            size="md"
            onClick={() => void handleExport()}
            disabled={exporting}
          >
            <FolderDown className="w-4 h-4" /> {exporting ? 'Exporting…' : 'Export now'}
          </Button>
        }
      />
      <div className="mt-3">
        <Switch
          label="Export after Feed Brain"
          description="Regenerate the markdown automatically at the end of every run"
          checked={captureSettings.projectionEnabled}
          onChange={(v) => onUpdateSettings(workspaceId, { projectionEnabled: v })}
        />
      </div>
      {result && <p className="text-xs text-success mt-2">{result}</p>}
      {error && <p className="text-xs text-danger mt-2">{error}</p>}
    </SettingsCard>
  )
}
