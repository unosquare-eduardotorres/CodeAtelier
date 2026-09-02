import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  BookOpen,
  ChevronDown,
  ListChecks,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Settings2,
  SquareKanban
} from 'lucide-react'
import { Button, Switch, Tabs } from '@renderer/components/common/ui'
import { useChatActions, useWorkspaceStore } from '@renderer/store'
import { EXTERNAL_MCP_INTEGRATIONS } from '../../../../../shared/constants'
import type { IntegrationCredentialStatus } from '../../../../../shared/integration-credentials.types'
import type {
  JiraCreateBlueprintsResult,
  JiraIssueDetail,
  JiraTransition
} from '../../../../../shared/jira.types'
import { JIRA_MAX_BULK_ISSUES, JIRA_MAX_LOADED_ROWS } from '../../../../../shared/jira.types'
import { findTransitionTo } from '../../../../../shared/jira-transition-match'
import {
  buildJiraChatPrompt,
  deriveGroupTitle,
  groupTicketOf,
  resolveGroupAnchor
} from '../../../../../shared/jira-format'
import { IntegrationCard } from '../integrations'
import JiraTicketList from './JiraTicketList'
import JiraTicketDetail from './JiraTicketDetail'
import JiraSelectionTray from './JiraSelectionTray'
import JiraListControls from './JiraListControls'
import JiraScopeControls from './JiraScopeControls'
import JiraFilterChips from './JiraFilterChips'
import { useJiraTickets } from './useJiraTickets'
import { useJiraKeyboard } from './useJiraKeyboard'

/** The Jira entry in the integration registry — drives the connection card. */
const JIRA_INTEGRATION = EXTERNAL_MCP_INTEGRATIONS.find((i) => i.id === 'jira')!

/** Jira is a bundled server, so there is no CLI to probe on PATH. */
const BUNDLED_CLI_STATUS = { checked: true, found: true }

/** Which half of the right-hand aside is showing. */
type AsideTab = 'ticket' | 'selected'

/**
 * Jira tickets panel.
 *
 * Owns Jira setup as well as browsing: the credential form used to live on the
 * Integrations page, but a user who comes here to find a ticket and discovers
 * Jira is not connected should not have to go looking for another tab.
 *
 * There is deliberately no auto-refresh. Polling a corporate Jira behind a VPN
 * is how a workspace gets rate-limited, so the list carries an "as of" stamp and
 * a refresh button instead.
 */
export default function JiraTicketsPage({
  onNavigateToChat,
  onNavigateToBlueprints
}: {
  onNavigateToChat: () => void
  onNavigateToBlueprints: () => void
}): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const { selectConversation, sendMessage, loadConversations } = useChatActions()
  const workspaceId = activeWorkspace?.id ?? null

  const [credentialStatus, setCredentialStatus] = useState<IntegrationCredentialStatus>()
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [savingId, setSavingId] = useState<string | null>(null)
  // null = follow the connection state; a boolean = the user has taken over.
  const [connectionOverride, setConnectionOverride] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<null | 'blueprints' | 'chat'>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [conversionResult, setConversionResult] = useState<JiraCreateBlueprintsResult | null>(null)
  const [asideTab, setAsideTab] = useState<AsideTab>('ticket')
  // `workspaceId:issueKey` → its "start work" transition, or null when the
  // workflow offers none. Cached because probing costs one Jira request per
  // ticket: without it, ticking ten rows one at a time would cost fifty-five.
  //
  // Keyed by workspace rather than reset on switch: transition ids are
  // per-workflow ("In Progress" is 21 on one project and 4 on the next), and a
  // namespaced key makes a stale hit impossible without an effect to clear it.
  const [transitionByKey, setTransitionByKey] = useState<Record<string, JiraTransition | null>>({})
  // Stamped with the selection it was ticked for, so changing the selection
  // implicitly un-ticks the box with no effect writing state to do it.
  const [moveForSelection, setMoveForSelection] = useState<string | null>(null)

  const filterInputRef = useRef<HTMLInputElement | null>(null)
  /** Keys already asked about, so a re-render cannot re-request them. */
  const probedKeys = useRef<Set<string>>(new Set())
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    []
  )

  const isConnected = credentialStatus?.configured === true

  const tickets = useJiraTickets(workspaceId, isConnected)
  const selectedCount = tickets.selectedKeys.size
  const selectedKeyList = useMemo(() => [...tickets.selectedKeys], [tickets.selectedKeys])
  // Carries the workspace so a selection cannot survive a switch as "ticked".
  const selectionSignature = `${workspaceId}|${selectedKeyList.join(',')}`
  const cacheKey = (issueKey: string): string => `${workspaceId}:${issueKey}`

  /** The selected rows, in selection order, resolved against every loaded page. */
  const selectedRows = useMemo(() => {
    const byKey = new Map(tickets.issues.map((issue) => [issue.key, issue]))
    return selectedKeyList
      .map((key) => byKey.get(key))
      .filter((issue): issue is NonNullable<typeof issue> => issue !== undefined)
  }, [tickets.issues, selectedKeyList])

  // Offered only when *every* selected ticket has such a transition: a checkbox
  // that silently moves six of ten tickets is worse than no checkbox.
  const selectedTransitions = selectedKeyList.map((key) => transitionByKey[cacheKey(key)])
  const canMoveAll =
    selectedKeyList.length > 0 && selectedTransitions.every((t) => t !== undefined && t !== null)
  const moveTargets = new Set(
    selectedTransitions.map((t) => (t ? (t.toStatus ?? t.name) : '')).filter(Boolean)
  )
  const moveLabel = moveTargets.size === 1 ? [...moveTargets][0] : 'In Progress'
  const moveToInProgress = canMoveAll && moveForSelection === selectionSignature

  useJiraKeyboard({
    enabled: isConnected,
    filterInputRef,
    cursorKey: tickets.cursorKey,
    onMove: tickets.moveCursor,
    onToggle: tickets.toggleSelected,
    onOpen: tickets.setActiveKey
  })

  // ── Credential + settings state (shared with the connection card) ──

  const reloadSettings = useCallback(() => {
    if (!workspaceId) return
    window.api
      .getWorkspaceSettings({ workspaceId })
      .then(setSettings)
      .catch((err) => console.warn('[JiraTicketsPage] Non-fatal: settings load failed:', err))
  }, [workspaceId])

  useEffect(reloadSettings, [reloadSettings])

  useEffect(() => {
    if (!workspaceId) return
    window.api
      .getIntegrationCredentialStatus({ workspaceId, integrationId: 'jira' })
      .then(setCredentialStatus)
      .catch((err) => console.warn('[JiraTicketsPage] Non-fatal: credential status failed:', err))
  }, [workspaceId])

  // First run: an unconfigured workspace lands straight on the setup form rather
  // than on an empty list with no obvious next step. Derived, not an effect, so
  // it cannot flash the wrong panel while the status is still loading.
  const showConnection = connectionOverride ?? credentialStatus?.configured === false

  const handleToggle = useCallback(
    async (integrationId: string, enabled: boolean) => {
      if (!workspaceId) return
      setSavingId(integrationId)
      const key = `${integrationId}Available`
      try {
        await window.api.updateWorkspaceSettings({ workspaceId, settings: { [key]: enabled } })
        setSettings((prev) => ({ ...prev, [key]: enabled }))
      } catch (err) {
        console.error('[JiraTicketsPage] Failed to update integration setting:', err)
      } finally {
        setSavingId(null)
      }
    },
    [workspaceId]
  )

  /**
   * Write one of the status write-back toggles.
   *
   * Optimistic, like `handleToggle`: the switch reflects the click immediately
   * and a failed write logs rather than banners — nothing has been sent to Jira
   * yet, so the cost of being wrong is one more click.
   */
  const handleSyncSetting = useCallback(
    async (key: 'jiraSyncStatus' | 'jiraDoneOnWarnings', value: boolean) => {
      if (!workspaceId) return
      setSettings((prev) => ({ ...prev, [key]: value }))
      try {
        await window.api.updateWorkspaceSettings({ workspaceId, settings: { [key]: value } })
      } catch (err) {
        console.error('[JiraTicketsPage] Failed to update Jira sync setting:', err)
        setSettings((prev) => ({ ...prev, [key]: !value }))
      }
    },
    [workspaceId]
  )

  const handleCredentialStatusChange = useCallback(
    (_id: string, status: IntegrationCredentialStatus) => setCredentialStatus(status),
    []
  )

  // ── "Move to In Progress" opt-in for the chat handoff ──

  useEffect(() => {
    if (!workspaceId) return
    const missing = selectedKeyList.filter((key) => !probedKeys.current.has(cacheKey(key)))
    if (missing.length === 0) return
    for (const key of missing) probedKeys.current.add(cacheKey(key))

    // Sequential and never cancelled: the answer is cached per key, so a result
    // that lands after the selection moved on is still correct for that key.
    void (async () => {
      for (const issueKey of missing) {
        let transition: JiraTransition | null = null
        try {
          transition = findTransitionTo(
            await window.api.jiraListTransitions({ workspaceId, issueKey }),
            'in-progress'
          )
        } catch {
          // No transitions readable means no checkbox — never an error banner.
        }
        if (!mounted.current) return
        setTransitionByKey((prev) => ({ ...prev, [`${workspaceId}:${issueKey}`]: transition }))
      }
    })()
    // `cacheKey` closes over workspaceId, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, selectedKeyList])

  // ── Aside tabs ──

  // The tray is only worth interrupting for once the selection stops being a
  // single ticket — that is the point at which what will be built stops being
  // obvious from the row itself.
  const previousCount = useRef(selectedCount)
  useEffect(() => {
    if (selectedCount > 1 && previousCount.current <= 1) setAsideTab('selected')
    previousCount.current = selectedCount
  }, [selectedCount])

  const activeTab: AsideTab =
    asideTab === 'ticket' && tickets.activeKey === null
      ? 'selected'
      : asideTab === 'selected' && selectedCount === 0
        ? 'ticket'
        : asideTab

  // ── Conversions ──

  const handleCreateBlueprints = async (): Promise<void> => {
    if (!workspaceId || selectedKeyList.length === 0) return
    setBusy('blueprints')
    setActionError(null)
    setConversionResult(null)
    try {
      const result = await window.api.jiraCreateBlueprints({
        workspaceId,
        issueKeys: selectedKeyList
      })
      setConversionResult(result)
      // Keep failures ticked so the user can retry exactly those; drop the ones
      // that succeeded — and the ones that already had a blueprint — so a second
      // click cannot duplicate them.
      tickets.deselect([
        ...(result.created?.issueKeys ?? []),
        ...result.skipped.map((s) => s.issueKey)
      ])
      // Badge the newly converted rows without a re-search.
      void tickets.reloadConverted()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create blueprints.')
    } finally {
      setBusy(null)
    }
  }

  const handleStartChat = async (): Promise<void> => {
    if (!workspaceId || selectedKeyList.length === 0) return
    setBusy('chat')
    setActionError(null)
    try {
      // Sequential, like the blueprint conversion: a burst of parallel requests
      // against an on-prem Jira behind a VPN is what trips rate limiting.
      const issues: JiraIssueDetail[] = []
      for (const issueKey of selectedKeyList) {
        issues.push(await window.api.jiraGetIssue({ workspaceId, issueKey }))
      }

      // The status moves happen first and on their own: if the workflow rejects
      // one, nothing has been created yet and the user can retry or untick the
      // box. Doing it after the chat exists would leave a half-done handoff
      // behind an error the navigation immediately hides. Retrying is safe —
      // Jira stops offering a transition into a state an issue is already in.
      if (moveToInProgress) {
        const moved: string[] = []
        for (const issue of issues) {
          const transition = transitionByKey[cacheKey(issue.key)]
          if (!transition) continue
          try {
            await window.api.jiraTransitionIssue({
              workspaceId,
              issueKey: issue.key,
              transitionId: transition.id
            })
            moved.push(issue.key)
          } catch (err) {
            const message = err instanceof Error ? err.message : 'the transition was rejected'
            setActionError(
              `${issue.key} could not be moved: ${message}. ` +
                `${moved.length > 0 ? `Already moved: ${moved.join(', ')}. ` : ''}` +
                'No chat was created — untick the box or retry.'
            )
            return
          }
        }
      }

      const anchor = resolveGroupAnchor(issues)
      const epic = anchor.epicKey
        ? {
            key: anchor.epicKey,
            summary: anchor.epicSummary,
            type: anchor.epicType,
            url: anchor.epicUrl
          }
        : undefined

      // IPC directly rather than the store action: the store's createConversation
      // returns void and bails without setting state when another switch races
      // it, which would send the brief into whichever chat happened to be active.
      // Holding the conversation and selecting it by id removes both hazards —
      // and selectConversation is what resets `isStreaming` for the target.
      const conversation = await window.api.createConversation({
        workspaceId,
        mode: 'build',
        title: deriveGroupTitle(issues.map(groupTicketOf)),
        // Activates the Jira MCP pill for this chat. The executor ANDs this with
        // the workspace-level toggle, so it is a no-op until Jira is enabled.
        mcpOverrides: { jira: true },
        autoBranch: true
      })
      await loadConversations(workspaceId)
      await selectConversation(conversation.id)
      await sendMessage(buildJiraChatPrompt(issues, epic))
      onNavigateToChat()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to start chat.')
    } finally {
      setBusy(null)
    }
  }

  // ── Render ──

  if (!activeWorkspace) {
    return (
      <div className="p-6">
        <p className="text-xs text-text-secondary">Open a workspace to browse Jira tickets.</p>
      </div>
    )
  }

  const loadedCount = tickets.issues.length
  const visibleCount = tickets.visibleIssues.length
  const atRowCeiling = loadedCount >= JIRA_MAX_LOADED_ROWS

  return (
    <div data-testid="jira-tickets-page" className="flex-1 flex min-h-0">
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* ── Header ── */}
        <div className="px-6 pt-6 pb-3 space-y-3 shrink-0">
          <div className="flex items-center gap-2">
            <SquareKanban size={16} className="text-blue-400" />
            <h3 className="text-sm font-semibold text-text-primary">Jira Tickets</h3>
            <Button
              size="xs"
              variant="ghost"
              className="ml-auto"
              data-testid="jira-connection-toggle"
              onClick={() => setConnectionOverride(!showConnection)}
            >
              <Settings2 size={11} />
              {showConnection ? 'Hide connection' : 'Connection'}
            </Button>
          </div>
          <p className="text-xs text-text-secondary">
            Browse your board, then fold a selection into one blueprint — or take it into a chat on
            its own branch.
          </p>

          {showConnection && (
            <>
              <IntegrationCard
                integration={JIRA_INTEGRATION}
                available={!!settings.jiraAvailable}
                cliStatus={BUNDLED_CLI_STATUS}
                onToggle={handleToggle}
                savingId={savingId}
                workspaceId={workspaceId}
                credentialStatus={credentialStatus}
                onCredentialStatusChange={handleCredentialStatusChange}
                onCredentialsCleared={reloadSettings}
              />

              {/* Off by default and deliberately so: every other Jira write in
                  the app is something the user clicked. This one is not, and it
                  writes to a ticket the whole team reads. */}
              <div
                data-testid="jira-sync-settings"
                className="bg-surface-overlay rounded-lg border border-border-subtle p-3 space-y-3"
              >
                <Switch
                  checked={settings.jiraSyncStatus === true}
                  onChange={(next) => void handleSyncSetting('jiraSyncStatus', next)}
                  disabled={!isConnected}
                  label="Move tickets as blueprints progress"
                  description="Converting a selection moves its tickets to In Progress; a clean blueprint completion moves them to Done. Tickets whose workflow offers no matching transition are left alone."
                  title={isConnected ? undefined : 'Connect Jira first'}
                />
                <Switch
                  checked={settings.jiraDoneOnWarnings === true}
                  onChange={(next) => void handleSyncSetting('jiraDoneOnWarnings', next)}
                  disabled={!isConnected || settings.jiraSyncStatus !== true}
                  label="Move to Done even when checks could not be verified"
                  description="Off: a blueprint that finishes with unverified checks gets a comment naming them, and the status is left unchanged rather than claiming work that was not proven."
                  title={
                    settings.jiraSyncStatus === true ? undefined : 'Turn on status moves first'
                  }
                />
              </div>
            </>
          )}

          {isConnected && (
            <>
              {/* JQL search */}
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  void tickets.search()
                }}
              >
                <input
                  aria-label="JQL query"
                  data-testid="jira-jql-input"
                  value={tickets.jql}
                  onChange={(e) => tickets.setJql(e.target.value)}
                  spellCheck={false}
                  placeholder="project = PROJ AND status = 'In Progress' ORDER BY updated DESC"
                  className="flex-1 bg-surface-overlay border border-border-default rounded px-2 py-1.5 text-xs text-text-primary font-mono"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="primary"
                  data-testid="jira-search-submit"
                  disabled={tickets.isLoading}
                >
                  {tickets.isLoading ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Search size={12} />
                  )}
                  Search
                </Button>
              </form>

              <JiraFilterChips
                savedFilters={tickets.savedFilters}
                onApply={(jql) => {
                  tickets.setJql(jql)
                  void tickets.search(jql)
                }}
                onSave={tickets.saveCurrentFilter}
                onRemove={tickets.removeSavedFilter}
              />

              <JiraScopeControls
                projects={tickets.projects}
                projectKey={tickets.projectKey}
                onProjectChange={tickets.selectProject}
                boards={tickets.boards}
                boardId={tickets.boardId}
                onBoardChange={tickets.selectBoard}
                sprints={tickets.sprints}
                sprintId={tickets.sprintId}
                onSprintChange={tickets.selectSprint}
              />

              <JiraListControls
                filterText={tickets.filterText}
                onFilterChange={tickets.setFilterText}
                filterInputRef={filterInputRef}
                sortField={tickets.sortField}
                sortDir={tickets.sortDir}
                onSortChange={tickets.setSort}
                isServerSorted={tickets.isServerSorted}
                grouped={tickets.grouped}
                onGroupedChange={tickets.setGrouped}
              />
            </>
          )}
        </div>

        {/* ── Selection toolbar ── */}
        {isConnected && selectedCount > 0 && (
          <div
            data-testid="jira-selection-toolbar"
            className="mx-6 mb-3 flex items-center gap-2 flex-wrap rounded-lg border border-accent/30 bg-surface-overlay px-3 py-2 shrink-0"
          >
            <span className="text-xs text-text-primary font-medium">{selectedCount} selected</span>
            <Button
              size="xs"
              variant="primary"
              data-testid="jira-create-blueprints"
              onClick={handleCreateBlueprints}
              disabled={busy !== null}
              title={
                selectedCount === 1
                  ? 'Create a blueprint from this ticket'
                  : `Fold all ${selectedCount} tickets into one blueprint on one branch`
              }
            >
              {busy === 'blueprints' ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <BookOpen size={11} />
              )}
              {selectedCount === 1
                ? 'Create blueprint'
                : `Create 1 blueprint from ${selectedCount}`}
            </Button>
            <Button
              size="xs"
              data-testid="jira-start-chat"
              onClick={handleStartChat}
              disabled={busy !== null}
              title={
                selectedCount === 1
                  ? 'Create a chat and a git branch for this ticket'
                  : `Create one chat and one git branch covering all ${selectedCount} tickets`
              }
            >
              {busy === 'chat' ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <MessageSquare size={11} />
              )}
              Chat + branch
            </Button>

            <Button
              size="xs"
              variant="ghost"
              data-testid="jira-review-selection"
              onClick={() => setAsideTab('selected')}
              title="See what these become before converting"
            >
              <ListChecks size={11} />
              Review
            </Button>

            {/* Opt-in, never implicit: this writes to tickets the whole team
                reads, and the target status is named on the label. Offered only
                when every selected ticket has such a transition. */}
            {canMoveAll && (
              <label className="flex items-center gap-1 text-[11px] text-text-secondary">
                <input
                  type="checkbox"
                  data-testid="jira-move-in-progress"
                  checked={moveToInProgress}
                  onChange={(e) =>
                    setMoveForSelection(e.target.checked ? selectionSignature : null)
                  }
                />
                Move {selectedCount === 1 ? 'it' : `all ${selectedCount}`} to “{moveLabel}”
              </label>
            )}

            <Button size="xs" variant="ghost" onClick={tickets.clearSelection}>
              Clear
            </Button>

            {tickets.selectionAtCap && (
              <span className="text-[11px] text-text-muted" data-testid="jira-selection-cap-note">
                Capped at {JIRA_MAX_BULK_ISSUES} tickets per blueprint — each costs one Jira
                request.
              </span>
            )}

            {!settings.jiraAvailable && (
              <span className="text-[11px] text-text-muted" data-testid="jira-tools-off-note">
                Jira is off for this workspace — the chat gets the ticket, but no Jira tools.
              </span>
            )}
          </div>
        )}

        {/* ── List ── */}
        <div className="flex-1 overflow-y-auto px-6 pb-6 min-h-0 space-y-3">
          {actionError && (
            <div className="flex items-start gap-2 bg-warning-muted border border-warning/20 rounded-md p-2.5 text-[11px] text-text-secondary">
              <AlertTriangle size={12} className="text-warning mt-0.5 shrink-0" />
              <span>{actionError}</span>
            </div>
          )}

          {conversionResult && (
            <div
              data-testid="jira-conversion-result"
              className="rounded-md border border-border-subtle bg-surface-overlay p-2.5 text-[11px] text-text-secondary space-y-1"
            >
              {conversionResult.created && (
                <p data-testid="jira-conversion-created">
                  Created{' '}
                  <span className="text-text-primary">{conversionResult.created.title}</span> from{' '}
                  {conversionResult.created.issueKeys.length} ticket
                  {conversionResult.created.issueKeys.length === 1 ? '' : 's'} (
                  {conversionResult.created.issueKeys.join(', ')}).{' '}
                  <button
                    type="button"
                    onClick={onNavigateToBlueprints}
                    className="text-accent hover:underline"
                  >
                    Open Blueprints
                  </button>
                </p>
              )}
              {conversionResult.skipped.length > 0 && (
                <p data-testid="jira-conversion-skipped">
                  Already converted, so left alone:{' '}
                  {conversionResult.skipped.map((s) => s.issueKey).join(', ')}.{' '}
                  <button
                    type="button"
                    onClick={onNavigateToBlueprints}
                    className="text-accent hover:underline"
                  >
                    Open Blueprints
                  </button>
                </p>
              )}
              {conversionResult.failed.map((failure) => (
                <p key={failure.issueKey} className="text-warning">
                  {failure.issueKey}: {failure.error}
                </p>
              ))}
            </div>
          )}

          {!isConnected ? (
            <p className="text-xs text-text-secondary">
              Connect Jira above to browse your tickets.
            </p>
          ) : tickets.error ? (
            <div
              data-testid="jira-search-error"
              className="flex items-start gap-2 bg-warning-muted border border-warning/20 rounded-md p-2.5 text-[11px] text-text-secondary"
            >
              <AlertTriangle size={12} className="text-warning mt-0.5 shrink-0" />
              <span>{tickets.error}</span>
            </div>
          ) : tickets.isLoading && loadedCount === 0 ? (
            <div className="flex items-center gap-2 text-[11px] text-text-muted">
              <Loader2 size={12} className="animate-spin" /> Searching Jira…
            </div>
          ) : loadedCount === 0 ? (
            <p className="text-xs text-text-secondary">
              {tickets.hasSearched
                ? 'No tickets matched that query.'
                : 'Run a search to list your tickets.'}
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-text-muted" data-testid="jira-result-count">
                  {visibleCount === loadedCount
                    ? `${loadedCount} loaded`
                    : `${visibleCount} of ${loadedCount} loaded`}
                  {tickets.result?.total !== undefined ? ` · ${tickets.result.total} match` : ''}
                  {tickets.fetchedAt
                    ? ` · as of ${new Date(tickets.fetchedAt).toLocaleTimeString()}`
                    : ''}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  data-testid="jira-refresh"
                  onClick={() => void tickets.refresh()}
                  disabled={tickets.isLoading}
                  title="Re-run the query — nothing polls Jira on its own"
                >
                  <RefreshCw size={11} className={tickets.isLoading ? 'animate-spin' : ''} />
                  Refresh
                </Button>
                <Button size="xs" variant="ghost" onClick={tickets.selectAll} className="ml-auto">
                  Select all
                </Button>
              </div>

              {visibleCount === 0 && (
                <p className="text-xs text-text-secondary">
                  No loaded ticket matches “{tickets.filterText}”.
                  {tickets.canLoadMore ? ' More pages exist — load them or narrow the JQL.' : ''}
                </p>
              )}

              <JiraTicketList
                issues={tickets.visibleIssues}
                groups={tickets.groups}
                selectedKeys={tickets.selectedKeys}
                activeKey={tickets.activeKey}
                cursorKey={tickets.cursorKey}
                convertedKeys={tickets.convertedKeys}
                onToggleSelected={tickets.toggleSelected}
                onOpenDetail={tickets.setActiveKey}
                onOpenBlueprint={onNavigateToBlueprints}
              />

              {tickets.canLoadMore && (
                <Button
                  size="xs"
                  variant="ghost"
                  data-testid="jira-load-more"
                  onClick={() => void tickets.loadMore()}
                  disabled={tickets.isLoadingMore}
                >
                  {tickets.isLoadingMore ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <ChevronDown size={11} />
                  )}
                  Load 50 more
                </Button>
              )}

              {atRowCeiling && (
                <p className="text-[11px] text-text-muted" data-testid="jira-row-ceiling">
                  Showing the first {JIRA_MAX_LOADED_ROWS} rows. Narrow the JQL to see the rest —
                  past this point more rows stop being a list and start being a scroll.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* One aside, two tabs. A second right-hand panel for the selection would
          have to fight the detail pane for the same space; switching inside the
          panel is the arbitration every other page here uses. */}
      {isConnected && workspaceId && (tickets.activeKey !== null || selectedCount > 0) && (
        <aside className="w-96 shrink-0 border-l border-border-subtle bg-surface-base flex flex-col min-h-0">
          <div className="px-2 pt-1 border-b border-border-subtle shrink-0">
            <Tabs
              ariaLabel="Ticket panel"
              idPrefix="jira-aside-"
              value={activeTab}
              onChange={setAsideTab}
              items={[
                ...(tickets.activeKey !== null
                  ? [{ key: 'ticket' as const, label: 'Ticket', testId: 'jira-aside-tab-ticket' }]
                  : []),
                ...(selectedCount > 0
                  ? [
                      {
                        key: 'selected' as const,
                        label: 'Selected',
                        badge: selectedCount,
                        testId: 'jira-aside-tab-selected'
                      }
                    ]
                  : [])
              ]}
            />
          </div>

          {activeTab === 'ticket' && tickets.activeKey !== null ? (
            <JiraTicketDetail
              // Remount on ticket change so no state survives the switch.
              key={tickets.activeKey}
              workspaceId={workspaceId}
              issueKey={tickets.activeKey}
              onClose={() => tickets.setActiveKey(null)}
            />
          ) : (
            <JiraSelectionTray
              selected={selectedRows}
              convertedKeys={tickets.convertedKeys}
              onRemove={tickets.toggleSelected}
              onClear={tickets.clearSelection}
              onOpenBlueprint={onNavigateToBlueprints}
            />
          )}
        </aside>
      )}
    </div>
  )
}
