import log from 'electron-log/main'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { summarizeToolInput } from './agent-base.service'

const approvalLog = log.scope('ToolApproval')

/** TTL for cached approvals (30 seconds) */
const APPROVAL_CACHE_TTL_MS = 30_000

/** Timeout before auto-approving an unresponded request (30 seconds) */
const APPROVAL_TIMEOUT_MS = 30_000

interface PendingApproval {
  resolve: (approved: boolean) => void
  toolName: string
  toolInput: Record<string, unknown>
  agentId: string
  taskId?: string
}

interface CachedApproval {
  approved: boolean
  expiresAt: number
}

export class ToolApprovalService {
  private pendingApprovals = new Map<string, PendingApproval>()
  private approvalCache = new Map<string, CachedApproval>()

  /** Tools that are always auto-approved (safe, read-only) */
  private autoApprovedTools = new Set([
    'Read',
    'Glob',
    'Grep',
    'WebSearch',
    'WebFetch',
    'TodoRead',
    'TodoWrite',
    'TaskOutput'
  ])

  /** Prefix patterns for auto-approval (e.g., all MCP tools) */
  private autoApprovedPrefixes = ['mcp__']

  /**
   * Check if a tool call should be approved.
   * Returns immediately for auto-approved/cached tools.
   * Sends IPC to renderer for user confirmation otherwise.
   */
  async requestApproval(
    toolName: string,
    toolInput: Record<string, unknown>,
    agentId: string,
    taskId?: string
  ): Promise<boolean> {
    // Auto-approve safe tools
    if (this.isAutoApproved(toolName)) return true

    // Check cache
    const cacheKey = this.buildCacheKey(toolName, toolInput)
    const cached = this.approvalCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.approved
    }

    // Request approval from renderer
    const requestId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(requestId, {
        resolve,
        toolName,
        toolInput,
        agentId,
        taskId
      })

      // Send to renderer via focused window
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (win) {
        win.webContents.send(IPC_CHANNELS.TOOL_APPROVAL_REQUEST, {
          requestId,
          toolName,
          toolInput: summarizeToolInput(toolName, toolInput),
          agentId,
          taskId
        })
      } else {
        // No window available — auto-approve to avoid blocking
        approvalLog.warn(`No window available for tool approval — auto-approving ${toolName}`)
        this.pendingApprovals.delete(requestId)
        resolve(true)
        return
      }

      // Auto-approve after timeout (don't block forever)
      setTimeout(() => {
        if (this.pendingApprovals.has(requestId)) {
          approvalLog.warn(`Tool approval timed out for ${toolName}, auto-approving`)
          this.resolveApproval(requestId, true)
        }
      }, APPROVAL_TIMEOUT_MS)
    })
  }

  /** Called from IPC handler when user responds */
  resolveApproval(requestId: string, approved: boolean): void {
    const pending = this.pendingApprovals.get(requestId)
    if (!pending) return

    this.pendingApprovals.delete(requestId)

    // Cache the decision
    const cacheKey = this.buildCacheKey(pending.toolName, pending.toolInput)
    this.approvalCache.set(cacheKey, {
      approved,
      expiresAt: Date.now() + APPROVAL_CACHE_TTL_MS
    })

    pending.resolve(approved)
  }

  private isAutoApproved(toolName: string): boolean {
    if (this.autoApprovedTools.has(toolName)) return true
    // Prefix match for MCP tools
    return this.autoApprovedPrefixes.some((prefix) => toolName.startsWith(prefix))
  }

  private buildCacheKey(toolName: string, input: Record<string, unknown>): string {
    // Cache key includes tool name + key input params (e.g., file path for Write)
    const keyInput = input.file_path ?? input.command ?? input.url ?? ''
    return `${toolName}:${keyInput}`
  }
}

export const toolApprovalService = new ToolApprovalService()
