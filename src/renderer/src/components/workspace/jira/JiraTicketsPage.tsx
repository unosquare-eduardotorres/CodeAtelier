import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  BookOpen,
  Loader2,
  MessageSquare,
  Search,
  Settings2,
  SquareKanban
} from 'lucide-react'
import { Button } from '@renderer/components/common/ui'
import { useChatActions, useWorkspaceStore } from '@renderer/store'
import { EXTERNAL_MCP_INTEGRATIONS } from '../../../../../shared/constants'
import type { IntegrationCredentialStatus } from '../../../../../shared/integration-credentials.types'
import type { JiraCreateBlueprintsResult } from '../../../../../shared/jira.types'
import { JIRA_QUICK_FILTERS } from '../../../../../shared/jira.types'
import { buildJiraChatPrompt } from '../../../../../shared/jira-format'
import { IntegrationCard } from '../integrations'
import JiraTicketList from './JiraTicketList'
import JiraTicketDetail from './JiraTicketDetail'
import { useJiraTickets } from './useJiraTickets'

/** The Jira entry in the integration registry — drives the connection card. */
const JIRA_INTEGRATION = EXTERNAL_MCP_INTEGRATIONS.find((i) => i.id === 'jira')!

/** Jira is a bundled server, so there is no CLI to probe on PATH. */
const BUNDLED_CLI_STATUS = { checked: true, found: true }

/**
 * Jira tickets panel.
 *
 * Owns Jira setup as well as browsing: the credential form used to live on the
 * Integrations page, but a user who comes here to find a ticket and discovers
 * Jira is not connected should not have to go looking for another tab.
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

  const isConnected = credentialStatus?.configured === true

  const tickets = useJiraTickets(workspaceId, isConnected)
  const selectedCount = tickets.selectedKeys.size
  const selectedKeyList = useMemo(() => [...tickets.selectedKeys], [tickets.selectedKeys])

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

  const handleCredentialStatusChange = useCallback(
    (_id: string, status: IntegrationCredentialStatus) => setCredentialStatus(status),
    []
  )

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
        ...result.created.map((c) => c.issueKey),
        ...result.skipped.map((s) => s.issueKey)
      ])
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create blueprints.')
    } finally {
      setBusy(null)
    }
  }

  const handleStartChat = async (): Promise<void> => {
    if (!workspaceId || selectedKeyList.length !== 1) return
    const issueKey = selectedKeyList[0]
    setBusy('chat')
    setActionError(null)
    try {
      const issue = await window.api.jiraGetIssue({ workspaceId, issueKey })
      // IPC directly rather than the store action: the store's createConversation
      // returns void and bails without setting state when another switch races
      // it, which would send the brief into whichever chat happened to be active.
      // Holding the conversation and selecting it by id removes both hazards —
      // and selectConversation is what resets `isStreaming` for the target.
      const conversation = await window.api.createConversation({
        workspaceId,
        mode: 'build',
        title: `${issue.key}: ${issue.summary}`,
        // Activates the Jira MCP pill for this chat. The executor ANDs this with
        // the workspace-level toggle, so it is a no-op until Jira is enabled.
        mcpOverrides: { jira: true },
        autoBranch: true
      })
      await loadConversations(workspaceId)
      await selectConversation(conversation.id)
      await sendMessage(buildJiraChatPrompt(issue))
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
            Browse your board, then turn tickets into blueprints in bulk — or take one into a chat
            on its own branch.
          </p>

          {showConnection && (
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

              <div className="flex flex-wrap gap-1.5">
                {JIRA_QUICK_FILTERS.map((filter) => (
                  <button
                    key={filter.id}
                    type="button"
                    onClick={() => {
                      tickets.setJql(filter.jql)
                      void tickets.search(filter.jql)
                    }}
                    className="text-[11px] px-2 py-0.5 rounded-full border border-border-subtle text-text-secondary hover:border-accent hover:text-accent transition-colors"
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* ── Selection toolbar ── */}
        {isConnected && selectedCount > 0 && (
          <div
            data-testid="jira-selection-toolbar"
            className="mx-6 mb-3 flex items-center gap-2 rounded-lg border border-accent/30 bg-surface-overlay px-3 py-2 shrink-0"
          >
            <span className="text-xs text-text-primary font-medium">{selectedCount} selected</span>
            <Button
              size="xs"
              variant="primary"
              data-testid="jira-create-blueprints"
              onClick={handleCreateBlueprints}
              disabled={busy !== null}
            >
              {busy === 'blueprints' ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <BookOpen size={11} />
              )}
              Create {selectedCount} blueprint{selectedCount === 1 ? '' : 's'}
            </Button>
            <Button
              size="xs"
              data-testid="jira-start-chat"
              onClick={handleStartChat}
              disabled={busy !== null || selectedCount !== 1}
              title={
                selectedCount === 1
                  ? 'Create a chat and a git branch for this ticket'
                  : 'Select exactly one ticket to start a chat'
              }
            >
              {busy === 'chat' ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <MessageSquare size={11} />
              )}
              Chat + branch
            </Button>
            <Button size="xs" variant="ghost" onClick={tickets.clearSelection}>
              Clear
            </Button>
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
              {conversionResult.created.length > 0 && (
                <p>
                  Created {conversionResult.created.length} blueprint
                  {conversionResult.created.length === 1 ? '' : 's'}.{' '}
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
          ) : tickets.isLoading && tickets.issues.length === 0 ? (
            <div className="flex items-center gap-2 text-[11px] text-text-muted">
              <Loader2 size={12} className="animate-spin" /> Searching Jira…
            </div>
          ) : tickets.issues.length === 0 ? (
            <p className="text-xs text-text-secondary">
              {tickets.hasSearched
                ? 'No tickets matched that query.'
                : 'Run a search to list your tickets.'}
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-text-muted">
                  {tickets.result?.total !== undefined
                    ? `${tickets.issues.length} of ${tickets.result.total}`
                    : `${tickets.issues.length} ticket${tickets.issues.length === 1 ? '' : 's'}`}
                  {tickets.result?.hasMore ? ' · more available — narrow the JQL' : ''}
                </span>
                <Button size="xs" variant="ghost" onClick={tickets.selectAll} className="ml-auto">
                  Select all
                </Button>
              </div>
              <JiraTicketList
                issues={tickets.issues}
                selectedKeys={tickets.selectedKeys}
                activeKey={tickets.activeKey}
                onToggleSelected={tickets.toggleSelected}
                onOpenDetail={tickets.setActiveKey}
              />
            </>
          )}
        </div>
      </div>

      {isConnected && tickets.activeKey && workspaceId && (
        <JiraTicketDetail
          // Remount on ticket change so no state survives the switch.
          key={tickets.activeKey}
          workspaceId={workspaceId}
          issueKey={tickets.activeKey}
          onClose={() => tickets.setActiveKey(null)}
        />
      )}
    </div>
  )
}
