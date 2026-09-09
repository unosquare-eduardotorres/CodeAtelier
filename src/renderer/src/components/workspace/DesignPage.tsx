/**
 * DesignPage — the Audit Design tool: Impeccable-powered design review.
 *
 * Three views, mirroring HealthPage: landing (history) → configure → run.
 *
 * The event listeners are wired here rather than per-view because a run keeps
 * streaming while the user is on the landing page, and the store is the thing
 * that has to stay current. The store itself drops events tagged with another
 * workspace, which matters here in a way it does not for Workspace Health:
 * design runs are permitted to run concurrently across workspaces.
 */

import { useCallback, useEffect, useState } from 'react'
import { useWorkspaceStore, useDesignStore } from '@renderer/store'
import type { AuditRun } from '../../../../shared/types'
import { DesignLanding, DesignConfigure, DesignRunView } from './design'
import type { DesignRunRequest } from './design'

type DesignView = 'landing' | 'configure' | 'run'

export default function DesignPage(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const workspaceId = activeWorkspace?.id

  const {
    isRunning,
    lastError,
    loadLatest,
    openRun,
    startDesign,
    reset,
    handleProgress,
    handleResult,
    handleComplete,
    handleStreamChunk,
    handleIntermediate
  } = useDesignStore()

  const [view, setView] = useState<DesignView>('landing')

  // Bind the store to this workspace. Resetting first means a workspace switch
  // cannot leave the previous workspace's run on screen while the load is in
  // flight — and, with the store's workspace filter, cannot leave it there at all.
  useEffect(() => {
    if (!workspaceId) return
    reset()
    void loadLatest(workspaceId)
  }, [workspaceId, reset, loadLatest])

  useEffect(() => {
    const cleanups = [
      window.api.onDesignProgress(handleProgress),
      window.api.onDesignResult(handleResult),
      window.api.onDesignComplete(handleComplete),
      window.api.onDesignStreamChunk(handleStreamChunk),
      window.api.onDesignIntermediate(handleIntermediate)
    ]
    return () => cleanups.forEach((c) => c())
  }, [handleProgress, handleResult, handleComplete, handleStreamChunk, handleIntermediate])

  // A run in flight always wins over whatever view the user left behind.
  useEffect(() => {
    if (isRunning) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- follow the live run
      setView('run')
    }
  }, [isRunning])

  const handleRun = useCallback(
    async (request: DesignRunRequest) => {
      if (!workspaceId) return
      const refusal = await startDesign({
        workspaceId,
        commandIds: request.commandIds,
        scope: request.scope,
        brief: request.brief,
        llmProvider: request.provider
      })
      // On refusal go back to Configure — the reason is rendered there. The
      // `isRunning` effect below has already flipped the view to 'run' from the
      // optimistic start, and leaving it there would strand the user on a run
      // view whose run never existed.
      setView(refusal ? 'configure' : 'run')
    },
    [workspaceId, startDesign]
  )

  const handleOpenRun = useCallback(
    (run: AuditRun) => {
      if (!workspaceId) return
      openRun(workspaceId, run)
      setView('run')
    },
    [workspaceId, openRun]
  )

  if (view === 'configure' && workspaceId) {
    return (
      <DesignConfigure
        workspaceId={workspaceId}
        onRun={(request) => void handleRun(request)}
        onBack={() => setView('landing')}
        error={lastError}
      />
    )
  }

  if (view === 'run') {
    return <DesignRunView onBack={() => setView('landing')} />
  }

  return (
    <div data-testid="design-page" className="flex flex-col h-full">
      <DesignLanding onNewRun={() => setView('configure')} onOpenRun={handleOpenRun} />
    </div>
  )
}
