import type { ConversationMode } from '../../shared/types'

/**
 * Mode-driven allow / disallow tool lists, shared by DaVinci and Project
 * Specialists. Role-specific MCP tool names (code-graph, semantic-search,
 * git-context, etc.) are appended by the caller once it knows which feature
 * flags are active.
 *
 * - `allowedTools = undefined` means "no allow-list" (build mode — all
 *   SDK built-ins are allowed except the ones in `disallowedTools`).
 * - In plan mode we ship an explicit allow-list so Write/Edit/Bash are
 *   implicitly blocked.
 *
 * The Agent and ToolSearch tools are blocked globally:
 *   - Agent: SDK sub-agents are not part of this architecture — specialists
 *     execute directly, DaVinci doesn't delegate.
 *   - ToolSearch: wastes turns looking for tools we don't surface.
 *
 * ExitPlanMode and AskUserQuestion are blocked in both modes — we surface
 * equivalents via the control-actions MCP (emit_plan, ask_user).
 */
export interface ModePermissions {
  /** Plan-mode base allow-list (caller appends MCP tool names). undefined in build mode. */
  baseAllowed: string[] | undefined
  /** Mode-specific disallow-list. */
  disallowed: string[]
}

export function buildModePermissions(mode: ConversationMode): ModePermissions {
  switch (mode) {
    case 'build':
      return {
        baseAllowed: undefined, // all SDK built-ins allowed
        disallowed: [
          'Agent',
          'Task',
          'local_agent',
          'ToolSearch',
          'ExitPlanMode',
          'AskUserQuestion'
        ]
      }
    case 'danger':
      return {
        baseAllowed: undefined, // all SDK built-ins allowed
        disallowed: [
          'Agent',
          'Task',
          'local_agent',
          'ToolSearch',
          'ExitPlanMode',
          'AskUserQuestion'
        ]
      }
    case 'plan':
    default:
      return {
        // Bash added — CLI 'plan' permission mode gates what's safe
        // (read-only commands allowed, write commands still prompt)
        baseAllowed: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'],
        disallowed: [
          'Write',
          'Edit',
          'Agent',
          'Task',
          'local_agent',
          'ExitPlanMode',
          'AskUserQuestion',
          'ToolSearch'
        ]
      }
  }
}
