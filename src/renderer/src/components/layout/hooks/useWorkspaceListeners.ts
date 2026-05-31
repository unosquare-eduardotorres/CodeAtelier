import { useEffect } from 'react'
import {
  useAuditStore,
  useBugStore,
  useIndexingStore,
  useMpaStore,
  useToastStore
} from '@renderer/store'
import { useCouncilStore } from '@renderer/store/council.store'
import type { Workspace } from '../../../../../shared/types'

/**
 * Consolidates workspace-scoped event listeners:
 * audit, MPA, council auto-nav, bug tracker, and indexing events.
 */
export function useWorkspaceListeners(
  activeWorkspace: Workspace | null,
  setWorkspaceSettingsTab: (tab: string) => void,
  setSidebarView: (view: 'chat' | 'settings') => void
): void {
  // Audit listeners — keeps status bar in sync even when HealthPage is not mounted
  const loadLatestAudit = useAuditStore((s) => s.loadLatest)
  const handleAuditComplete = useAuditStore((s) => s.handleComplete)

  useEffect(() => {
    if (!activeWorkspace) return
    loadLatestAudit(activeWorkspace.id)
    const unsub = window.api.onAuditComplete(handleAuditComplete)
    return unsub
  }, [activeWorkspace?.id, loadLatestAudit, handleAuditComplete])

  // MPA listeners — keeps status bar in sync even when GoalPage is not mounted
  const registerMpaListeners = useMpaStore((s) => s.registerListeners)
  const loadMpaStatus = useMpaStore((s) => s.loadStatus)

  useEffect(() => {
    if (!activeWorkspace) return
    loadMpaStatus(activeWorkspace.id)
    const cleanup = registerMpaListeners()
    return cleanup
  }, [activeWorkspace?.id, registerMpaListeners, loadMpaStatus])

  // Auto-navigate to council tab when council starts
  const councilIsActive = useCouncilStore((s) => s.isActive)

  useEffect(() => {
    if (councilIsActive) {
      setWorkspaceSettingsTab('council')
      setSidebarView('settings')
    }
  }, [councilIsActive, setWorkspaceSettingsTab, setSidebarView])

  // Indexing listener
  const startIndexingListener = useIndexingStore((s) => s.startListening)
  const stopIndexingListener = useIndexingStore((s) => s.stopListening)

  useEffect(() => {
    if (!activeWorkspace) return
    startIndexingListener()
    return () => stopIndexingListener()
  }, [activeWorkspace?.id, startIndexingListener, stopIndexingListener])

  // Indexing complete toast
  const indexingState = useIndexingStore((s) => s.indexingState)
  const addToast = useToastStore((s) => s.addToast)

  useEffect(() => {
    if (indexingState?.status === 'complete' && indexingState.processedChunks > 0) {
      addToast({
        type: 'success',
        message: `Semantic search ready — ${indexingState.processedChunks.toLocaleString()} symbols indexed`
      })
    }
  }, [indexingState?.status, indexingState?.processedChunks, addToast])

  // Bug tracker: fetch count + listen for new bugs
  const fetchBugCount = useBugStore((s) => s.fetchCount)

  useEffect(() => {
    fetchBugCount()
    const unsub = window.api.onNewBug(() => {
      addToast({ message: 'A new bug was created', type: 'bug', onClickNavigate: 'bugs' })
      fetchBugCount()
    })
    return unsub
  }, [fetchBugCount, addToast])
}
