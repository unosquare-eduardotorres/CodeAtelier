/**
 * BootstrapKnowledge — shell for "Feed Brain" / "Deep Scan" ingestion.
 *
 * Routes between idle / running / paused / finished and delegates each state to
 * a panel in ./bootstrap. The run itself is durable and background-safe: this
 * component can unmount mid-ingestion and re-attach from the snapshot, and the
 * status bar keeps reporting progress either way.
 */

import { useState, useCallback, useEffect } from 'react'
import { Brain } from 'lucide-react'
import { useWorkspaceStore, useMemoryStore } from '@renderer/store'
import type { BootstrapMode, BootstrapScope } from '../../../../../shared/types'
import {
  RunControls,
  RunProgressPanel,
  ItemList,
  LastRunSummary,
  BrainIngestScene
} from './bootstrap'

/**
 * Escape hatch for the scene. A machine-level prefers-reduced-motion (Windows
 * ships it with "Adjust for best performance", so it is on far more often than
 * users realise) otherwise leaves the visual frozen with no way back short of
 * changing an OS accessibility setting globally.
 */
const ANIMATION_KEY = 'brain-ingest-animation'

export default function BootstrapKnowledge(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const {
    bootstrap,
    bootstrapLatestRun,
    bootstrapResumableRunId,
    bootstrapItems,
    bootstrapItemsTotal,
    bootstrapItemFilter,
    startBootstrap,
    pauseBootstrap,
    resumeBootstrap,
    cancelBootstrap,
    dismissBootstrap,
    loadBootstrapSnapshot,
    loadBootstrapItems,
    setBootstrapItemFilter
  } = useMemoryStore()

  const [selectedMode, setSelectedMode] = useState<BootstrapMode>('full')
  const [selectedScope, setSelectedScope] = useState<BootstrapScope>('changed')
  const [forceAnimation, setForceAnimation] = useState(
    () => localStorage.getItem(ANIMATION_KEY) === 'true'
  )
  // Opened from the "N failed" count on the last-run summary, which was
  // previously red text with no way to see what actually failed.
  const [inspectingFailures, setInspectingFailures] = useState(false)

  useEffect(() => {
    localStorage.setItem(ANIMATION_KEY, String(forceAnimation))
  }, [forceAnimation])

  const workspaceId = activeWorkspace?.id
  const workspacePath = activeWorkspace?.repoPath

  // Re-attach to whatever this workspace was doing — including a run left
  // paused by a previous app session.
  useEffect(() => {
    if (workspaceId) loadBootstrapSnapshot(workspaceId)
  }, [workspaceId, loadBootstrapSnapshot])

  const runId = bootstrap?.runId ?? bootstrapLatestRun?.id ?? null
  useEffect(() => {
    if (runId) loadBootstrapItems(runId)
  }, [runId, loadBootstrapItems])

  // Keep the item list fresh while a run is in flight. Progress events are
  // throttled and item rows change often, so a slow poll is simpler (and
  // cheaper) than streaming every row mutation over IPC.
  const isActive = bootstrap?.jobStatus === 'running' || bootstrap?.jobStatus === 'planning'
  useEffect(() => {
    if (!isActive || !runId) return undefined
    const timer = setInterval(() => loadBootstrapItems(runId), 2500)
    return () => clearInterval(timer)
  }, [isActive, runId, loadBootstrapItems])

  const handleStart = useCallback(async () => {
    if (!workspaceId || !workspacePath) return
    await startBootstrap(workspaceId, workspacePath, selectedMode, false, selectedScope)
  }, [workspaceId, workspacePath, selectedMode, selectedScope, startBootstrap])

  const handlePause = useCallback(() => {
    if (workspaceId) pauseBootstrap(workspaceId)
  }, [workspaceId, pauseBootstrap])

  const handleResume = useCallback(
    (id: string) => {
      if (workspacePath) resumeBootstrap(id, workspacePath)
    },
    [workspacePath, resumeBootstrap]
  )

  const handleDismiss = useCallback(() => {
    dismissBootstrap(workspaceId)
  }, [workspaceId, dismissBootstrap])

  const jobStatus = bootstrap?.jobStatus ?? 'idle'
  const showProgress = bootstrap !== null && jobStatus !== 'idle'
  const showScene = jobStatus === 'running' || jobStatus === 'planning' || jobStatus === 'paused'

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-text-primary flex items-center gap-1.5">
          <Brain className="w-4 h-4 text-teal" />
          Bootstrap Project Knowledge
        </h3>
        <p className="text-xs text-text-muted mt-0.5">
          Scans docs, manifests, central source files and git history to build project memory. Runs
          in the background — you can pause and resume without losing progress.
        </p>
      </div>

      {bootstrapLatestRun && !showProgress && (
        <LastRunSummary
          run={bootstrapLatestRun}
          resumableRunId={bootstrapResumableRunId}
          onResume={handleResume}
          onInspectFailures={
            bootstrapLatestRun.itemsFailed > 0
              ? () => {
                  setBootstrapItemFilter('failed')
                  setInspectingFailures(true)
                }
              : undefined
          }
          busy={isActive}
        />
      )}

      {inspectingFailures && !showProgress && (
        <div className="rounded-lg border border-border-default bg-surface-float p-3">
          <ItemList
            items={bootstrapItems}
            total={bootstrapItemsTotal}
            filter={bootstrapItemFilter}
            onFilterChange={setBootstrapItemFilter}
          />
        </div>
      )}

      {showProgress && bootstrap && (
        <div className="rounded-lg border border-border-default bg-surface-float p-3 space-y-3">
          <div className={showScene ? 'grid grid-cols-[1fr_180px] gap-3 items-start' : ''}>
            <RunProgressPanel progress={bootstrap} />
            {showScene && (
              <div className="space-y-1">
                <BrainIngestScene
                  itemsPerMinute={bootstrap.itemsPerMinute}
                  paused={bootstrap.jobStatus === 'paused'}
                  forceAnimation={forceAnimation}
                  className="h-[180px]"
                />
                <label
                  className="flex items-center gap-1.5 text-[11px] text-text-muted cursor-pointer select-none"
                  title="Draw the scene even when your system asks for reduced motion."
                >
                  <input
                    type="checkbox"
                    data-testid="bootstrap-animation-toggle"
                    checked={forceAnimation}
                    onChange={(e) => setForceAnimation(e.target.checked)}
                    className="w-3 h-3 accent-teal"
                  />
                  Show ingestion animation
                </label>
              </div>
            )}
          </div>

          <ItemList
            items={bootstrapItems}
            total={bootstrapItemsTotal}
            filter={bootstrapItemFilter}
            onFilterChange={setBootstrapItemFilter}
          />
        </div>
      )}

      <RunControls
        mode={selectedMode}
        scope={selectedScope}
        onModeChange={setSelectedMode}
        onScopeChange={setSelectedScope}
        onStart={handleStart}
        onPause={handlePause}
        onResume={handleResume}
        onCancel={cancelBootstrap}
        onDismiss={handleDismiss}
        jobStatus={jobStatus}
        canStart={Boolean(workspaceId && workspacePath)}
        resumableRunId={bootstrapResumableRunId}
      />
    </div>
  )
}
