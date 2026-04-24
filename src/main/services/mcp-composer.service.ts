/**
 * McpComposerService — assembles a Project Specialist's MCP configuration
 * from three layers (lowest precedence → highest):
 *
 *   1. Baseline  — MCPs that every specialist gets (control-actions, code-graph,
 *                  semantic-search when available).
 *   2. Tech-stack recommendations — from TECH_TO_MCP on the workspace's
 *      detected_techs.
 *   3. Skill-declared MCPs — MCPs that enabled skills request (TBD per skill
 *      metadata; accepts a Record<skillId, mcpId[]> argument).
 *   4. User overrides — kept in specialists.mcp_overrides as
 *      { mcpId: { enabled: boolean } }.
 *
 * The composed IDs are stored on specialists.mcp_config. The SessionService
 * reads the config and instantiates the concrete MCP server objects at
 * query-time. This service deals in IDs only — no SDK-level MCP server
 * construction happens here.
 *
 * See docs/architecture/project-specialist-refactor.md §5.2.
 */

import type { ConversationMode } from '../../shared/types'
import { TECH_TO_MCP } from './tech-stack-detector.service'
import { chatAgentLogger } from '../logger'

/** Known MCP server IDs. Must match what the runtime can actually instantiate. */
export const KNOWN_MCPS = [
  'control-actions',
  'code-graph',
  'semantic-search',
  'git-context',
  'task-context',
  'checkpoint-context',
  'github-context'
] as const

export type McpId = (typeof KNOWN_MCPS)[number] | string

/** Baseline MCPs that every Project Specialist gets. */
const BASELINE_MCPS: McpId[] = ['control-actions', 'code-graph']

/** Mode-specific additions (plan mode gets the read-only set by default). */
const MODE_MCPS: Record<ConversationMode, McpId[]> = {
  plan: [],
  build: ['task-context', 'checkpoint-context']
}

/** User-editable override shape — stored as JSON on specialists.mcp_overrides. */
export interface McpOverrides {
  [mcpId: string]: { enabled: boolean }
}

/** Composed, ready-to-persist MCP configuration (stored as JSON on specialists.mcp_config). */
export interface ComposedMcpConfig {
  enabled: McpId[]
  disabled: McpId[]
  /** Source attribution for debugging / UI display. */
  sources: Record<McpId, 'baseline' | 'tech' | 'skill' | 'override'>
}

export interface McpComposeInput {
  mode: ConversationMode
  detectedTechs: string[]
  /** Skills currently enabled on the specialist, mapped to the MCPs they request. */
  enabledSkillMcps?: Record<string, McpId[]>
  /** Per-MCP user toggles stored on the specialist. */
  overrides?: McpOverrides
  /** When false, semantic-search is removed from the final set. */
  semanticSearchAvailable?: boolean
  /** When false, github-context is removed from the final set. */
  githubAvailable?: boolean
}

export class McpComposerService {
  private readonly log = chatAgentLogger

  compose(input: McpComposeInput): ComposedMcpConfig {
    const set = new Map<McpId, ComposedMcpConfig['sources'][string]>()

    // Baseline
    for (const id of BASELINE_MCPS) set.set(id, 'baseline')
    // Mode
    for (const id of MODE_MCPS[input.mode]) set.set(id, 'baseline')

    // Tech-stack
    for (const tech of input.detectedTechs) {
      for (const id of TECH_TO_MCP[tech] ?? []) {
        if (!set.has(id)) set.set(id, 'tech')
      }
    }

    // Skill-declared
    if (input.enabledSkillMcps) {
      for (const skillId of Object.keys(input.enabledSkillMcps)) {
        for (const id of input.enabledSkillMcps[skillId] ?? []) {
          if (!set.has(id)) set.set(id, 'skill')
        }
      }
    }

    // Environment availability
    if (input.semanticSearchAvailable === false) set.delete('semantic-search')
    if (input.githubAvailable === false) set.delete('github-context')

    // User overrides (always highest precedence)
    const disabledByOverride = new Set<McpId>()
    if (input.overrides) {
      for (const id of Object.keys(input.overrides)) {
        const ov = input.overrides[id]
        if (!ov) continue
        if (ov.enabled) {
          set.set(id, 'override')
        } else {
          disabledByOverride.add(id)
          set.delete(id)
        }
      }
    }

    const enabled = Array.from(set.keys())
    const sources: Record<McpId, ComposedMcpConfig['sources'][string]> = {}
    for (const [id, src] of set) sources[id] = src

    const result: ComposedMcpConfig = {
      enabled,
      disabled: Array.from(disabledByOverride),
      sources
    }

    this.log.info(
      `[mcp-composer] mode=${input.mode} techs=[${input.detectedTechs.join(',')}] enabled=[${enabled.join(',')}] disabled=[${result.disabled.join(',')}]`
    )

    return result
  }

  /** Parse a persisted mcp_config JSON string back into a ComposedMcpConfig. Returns null on malformed input. */
  parseConfig(raw: string | null | undefined): ComposedMcpConfig | null {
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return null
      return parsed as ComposedMcpConfig
    } catch {
      return null
    }
  }

  /** Parse a persisted mcp_overrides JSON string. Returns empty object on malformed input. */
  parseOverrides(raw: string | null | undefined): McpOverrides {
    if (!raw) return {}
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return {}
      return parsed as McpOverrides
    } catch {
      return {}
    }
  }

  serialize(config: ComposedMcpConfig): string {
    return JSON.stringify(config)
  }

  serializeOverrides(overrides: McpOverrides): string {
    return JSON.stringify(overrides)
  }
}

export const mcpComposerService = new McpComposerService()
