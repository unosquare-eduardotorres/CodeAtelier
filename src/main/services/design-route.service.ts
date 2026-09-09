/**
 * DesignRouteService — maps a free-text design brief to preselected commands.
 *
 * One cheap one-shot call ("this page feels generic and AI-made" → Critique +
 * Distill) so the wizard's card step opens with a sensible selection instead of
 * sixteen unchecked boxes.
 *
 * ── Three rules this module exists to enforce ────────────────────────────────
 * 1. **It never blocks the wizard.** Timeout, empty response, unparseable JSON,
 *    a missing workspace, a dead local server — every one of those degrades to
 *    the deterministic keyword table below. `routeDesignBrief` does not throw.
 * 2. **A model cannot preselect an invalid set.** Returned ids are filtered
 *    through the catalogue and then through the incompatibility matrix, because
 *    `parseDesignRunConfig` *throws* on an unknown id or a conflicting pair — a
 *    hallucinated `shape`, or `bolder` next to `quieter`, would turn a helpful
 *    preselect into an unexplained failure at Run time.
 * 3. **The scope hint is not trusted here.** It is the model's raw suggestion;
 *    `design.ipc.ts` normalises it against the workspace root before it reaches
 *    the renderer, which is where that trust boundary already lives.
 */

import log from 'electron-log'
import {
  DESIGN_COMMANDS,
  DESIGN_COMMANDS_BY_ID,
  evaluateCommandsSelected,
  validateDesignCommandSet
} from '../../shared/design-commands'
import type { DesignCommandId, DesignContextStatus, DesignRouteResult } from '../../shared/types'
import { workspaceRepository } from '../db/repositories'
import { buildResolveOpts, modelConfigService, resolveAssignment } from './model-config.service'
import { runOneShotClaude, type OneShotClaudeOptions } from './one-shot-claude'
import { runOneShotLocal } from './one-shot-local'

const routeLog = log.scope('design-route')

/**
 * Hard ceiling on the round trip. The wizard fires this in the background while
 * the user reads the card step, so a slow answer is worth less than a fast
 * fallback — 10s is roughly the point at which the user has already chosen.
 */
const ROUTE_TIMEOUT_MS = 10_000

/**
 * Cap on preselected cards. A model that returns twelve cards has not routed
 * anything; it has just restated the catalogue, and a wall of pre-ticked boxes
 * is worse for the user than none.
 */
export const MAX_ROUTED_COMMANDS = 6

/** Longest scope hint worth carrying. Anything longer is not a path. */
const MAX_SCOPE_HINT_CHARS = 200

/** The evaluate pass used when a selection names none, mirroring DesignAgentService. */
const DEFAULT_EVALUATE: DesignCommandId = 'critique'

// ── Deterministic keyword fallback ───────────────────────────────────────────

/**
 * Brief keywords → commands, in priority order.
 *
 * This is the floor, not a nicety: it is what runs whenever the model call is
 * skipped, slow, or wrong, so it has to produce a defensible selection on its
 * own. Patterns are matched against the lowercased brief.
 */
const KEYWORD_ROUTES: { pattern: RegExp; commands: DesignCommandId[] }[] = [
  // Evaluate intents
  { pattern: /\baudit|review|assess|evaluate|a11y|accessib/, commands: ['audit', 'critique'] },
  {
    pattern: /\bgeneric|slop|ai[- ]?made|ai[- ]?generated|bland|boring|forgettable/,
    commands: ['critique', 'distill']
  },
  // Amplify / visual voice
  { pattern: /\banimat|motion|transition|micro[- ]?interaction/, commands: ['animate'] },
  { pattern: /\bbold|striking|confident|exciting|stimulating|louder/, commands: ['bolder'] },
  { pattern: /\bcolou?r|monochrom|washed|flat\b/, commands: ['colorize'] },
  { pattern: /\bdelight|joy|personality|playful|memorable|fun\b/, commands: ['delight'] },
  { pattern: /\blayout|spacing|grid|rhythm|align|hierarch/, commands: ['layout'] },
  {
    pattern: /\bquiet|calm|noisy|noise|busy|overwhelm|overstimul|aggressive/,
    commands: ['quieter']
  },
  { pattern: /\btypograph|font|typeface|readab|type\b/, commands: ['typeset'] },
  // Simplify
  {
    pattern: /\bresponsive|mobile|tablet|breakpoint|screen size|small screen/,
    commands: ['adapt']
  },
  { pattern: /\bcopy|wording|microcopy|label|error message|instruction/, commands: ['clarify'] },
  { pattern: /\bsimplif|declutter|minimal|essence|strip|cluttered/, commands: ['distill'] },
  // Harden
  {
    pattern: /\bproduction|launch|ship\b|edge case|i18n|internationali|overflow/,
    commands: ['harden']
  },
  {
    pattern: /\bonboard|first[- ]?run|empty state|getting started|new user/,
    commands: ['onboard']
  },
  { pattern: /\boptimi[sz]|slow|perf\b|performance|bundle|loading/, commands: ['optimize'] },
  { pattern: /\bpolish|final pass|consistenc|detail/, commands: ['polish'] }
]

/**
 * The deterministic route for a brief. Pure and exported so the table itself is
 * testable without a model.
 *
 * Always returns a valid, non-empty selection: an empty or unrecognised brief
 * yields the broad evaluation pass rather than nothing.
 */
export function keywordRoute(brief: string): DesignCommandId[] {
  const lower = brief.toLowerCase()
  const matched: DesignCommandId[] = []
  for (const route of KEYWORD_ROUTES) {
    if (!route.pattern.test(lower)) continue
    for (const id of route.commands) {
      if (!matched.includes(id)) matched.push(id)
    }
  }
  return sanitizeCommandIds(matched)
}

// ── Selection sanitisation ───────────────────────────────────────────────────

/**
 * Reduce any candidate id list to a valid, runnable selection.
 *
 * Drops unknown ids, resolves the incompatibility matrix by keeping the
 * earlier-ranked command of a clashing pair (the model and the keyword table
 * both emit in priority order, so "first wins" preserves the stronger signal),
 * caps the count, and guarantees an evaluate pass.
 */
export function sanitizeCommandIds(candidates: readonly string[]): DesignCommandId[] {
  const kept: DesignCommandId[] = []

  for (const raw of candidates) {
    const def = DESIGN_COMMANDS_BY_ID[raw]
    if (!def) continue
    const id = def.id
    if (kept.includes(id)) continue
    // Greedy conflict resolution — never admit a card that clashes with one
    // already kept, so the result satisfies validateDesignCommandSet by
    // construction rather than by a later check.
    if (def.incompatibleWith.some((other) => kept.includes(other))) continue
    kept.push(id)
    if (kept.length >= MAX_ROUTED_COMMANDS) break
  }

  if (evaluateCommandsSelected(kept).length === 0) {
    // Refine cards never execute. A selection of nothing but refine cards would
    // start a run with no pass to attach findings to.
    if (!kept.includes(DEFAULT_EVALUATE)) kept.unshift(DEFAULT_EVALUATE)
  }

  return kept.slice(0, MAX_ROUTED_COMMANDS)
}

// ── Prompt ───────────────────────────────────────────────────────────────────

const CATALOGUE_LINES = DESIGN_COMMANDS.map(
  (c) => `- ${c.id} (${c.category}): ${c.description}`
).join('\n')

const INCOMPATIBLE_LINES = DESIGN_COMMANDS.filter((c) => c.incompatibleWith.length > 0)
  .map((c) => `- ${c.id} cannot be combined with: ${c.incompatibleWith.join(', ')}`)
  .join('\n')

const SYSTEM_PROMPT = `You route a user's design brief to the design commands that address it.

Commands:
${CATALOGUE_LINES}

Only 'audit' and 'critique' actually execute as review passes; every other command shapes what the review looks for. Include at least one of 'audit' or 'critique'.

Incompatible pairs — never return both:
${INCOMPATIBLE_LINES}

Rules:
- Return between 1 and ${MAX_ROUTED_COMMANDS} command ids, most relevant first.
- Use ONLY ids from the list above. Never invent one.
- If the brief names a directory or area of the codebase, put it in scopeHint as a repository-relative path. Otherwise use null.
- rationale is ONE short sentence explaining the selection to the user.
- Output ONLY a single JSON object. No commentary, no code fence.

Output format:
{"commandIds":["critique","distill"],"scopeHint":"src/renderer","rationale":"..."}`

function buildUserMessage(brief: string, contextStatus?: DesignContextStatus | null): string {
  const lines = [`<brief>\n${brief}\n</brief>`]
  if (contextStatus && !contextStatus.designMd) {
    // Without DESIGN.md the model has no house style to appeal to, so a brief
    // about "consistency" is better served by a broad pass than a narrow one.
    lines.push(
      'The workspace has no DESIGN.md, so there is no documented design system to check against.'
    )
  }
  return lines.join('\n\n')
}

// ── Response parsing ─────────────────────────────────────────────────────────

interface RawRoute {
  commandIds: string[]
  scopeHint: string | null
  rationale: string
}

/**
 * Pull the route object out of a model response.
 *
 * Tolerant by necessity: local models wrap JSON in fences, prepend
 * `<think>` blocks, or add a sentence before the object. Returns null when
 * nothing usable is present, which the caller treats as a fallback trigger.
 */
export function parseRouteResponse(response: string): RawRoute | null {
  const withoutThinking = response.replace(/<think>[\s\S]*?<\/think>/g, '')
  const withoutFences = withoutThinking.replace(/```[a-z]*\n?/gi, '')

  const start = withoutFences.indexOf('{')
  const end = withoutFences.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(withoutFences.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const obj = parsed as Record<string, unknown>
  const rawIds = Array.isArray(obj.commandIds) ? obj.commandIds : []
  const commandIds = rawIds.filter((id): id is string => typeof id === 'string')
  if (commandIds.length === 0) return null

  const rawHint = typeof obj.scopeHint === 'string' ? obj.scopeHint.trim() : ''
  const scopeHint = rawHint.length > 0 && rawHint.length <= MAX_SCOPE_HINT_CHARS ? rawHint : null

  const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim().slice(0, 300) : ''

  return { commandIds, scopeHint, rationale }
}

// ── Service ──────────────────────────────────────────────────────────────────

export interface DesignRouteInput {
  workspaceId: string
  brief: string
  /** From DESIGN_CONTEXT_STATUS once P5 lands; absent until then. */
  contextStatus?: DesignContextStatus | null
}

class DesignRouteService {
  /** Test seam — overrides the Claude CLI runner. */
  _runner?: OneShotClaudeOptions['_runner']
  /** Test seam — overrides the local one-shot call. */
  _localRunner?: (opts: { systemPrompt: string; userMessage: string }) => Promise<{ text: string }>

  /**
   * Route a brief. Never throws, never rejects — a failure is a fallback.
   */
  async route(input: DesignRouteInput): Promise<DesignRouteResult> {
    const brief = input.brief.trim()
    const fallback = (why: string): DesignRouteResult => {
      routeLog.info(`[design:route] falling back to keywords (${why})`)
      return {
        commandIds: keywordRoute(brief),
        scopeHint: null,
        rationale: 'Matched from your brief. Adjust the selection if it missed something.',
        usedFallback: true
      }
    }

    if (brief.length === 0) return fallback('empty brief')

    let responseText: string
    try {
      responseText = await this.callModel(input.workspaceId, brief, input.contextStatus)
    } catch (err) {
      return fallback(err instanceof Error ? err.message : String(err))
    }

    if (!responseText.trim()) return fallback('empty response')

    const parsed = parseRouteResponse(responseText)
    if (!parsed) return fallback('unparseable response')

    // Checked BEFORE sanitising, not after: `sanitizeCommandIds` guarantees a
    // runnable selection by prepending the default evaluate pass, so an answer
    // of nothing but hallucinated ids would come back as a bare 'critique' and
    // look like a successful route. The user's own keywords are a better guess
    // than a model answer that contributed nothing.
    const recognized = parsed.commandIds.filter((id) => DESIGN_COMMANDS_BY_ID[id] !== undefined)
    if (recognized.length === 0) return fallback('model returned no known command ids')

    const commandIds = sanitizeCommandIds(recognized)
    // Belt and braces: the wizard must never receive an invalid set.
    if (commandIds.length === 0 || !validateDesignCommandSet(commandIds).valid) {
      return fallback('model returned no usable command ids')
    }

    routeLog.info(
      `[design:route] routed to ${commandIds.join(',')}` +
        (parsed.scopeHint ? ` scopeHint=${parsed.scopeHint}` : '')
    )

    return {
      commandIds,
      scopeHint: parsed.scopeHint,
      rationale: parsed.rationale || 'Selected from your brief.',
      usedFallback: false
    }
  }

  /**
   * Resolve the local model id for design routing.
   *
   * Without this the Design → Route row in model settings has NO EFFECT on a
   * local-LLM workspace: the local branch used to read `localCfg.localModel`
   * directly and never consult the role assignment.
   *
   * Only honoured when the assignment explicitly targets a local provider —
   * default assignments resolve to Claude models, which the local server 404s
   * on. Mirrors `PromptOptimizerService.resolveLocalModel`.
   */
  resolveLocalModel(workspaceId: string, localCfg: { localModel?: string }): string {
    const assignment = resolveAssignment({
      action: 'design:route',
      ...buildResolveOpts(workspaceId)
    })
    return assignment.provider === 'local-llm' && assignment.modelId
      ? assignment.modelId
      : (localCfg.localModel ?? 'qwen3-coder')
  }

  /** Dispatch to the workspace's provider, mirroring PromptOptimizerService. */
  private async callModel(
    workspaceId: string,
    brief: string,
    contextStatus?: DesignContextStatus | null
  ): Promise<string> {
    const userMessage = buildUserMessage(brief, contextStatus)

    if (this._localRunner) {
      const r = await this._localRunner({ systemPrompt: SYSTEM_PROMPT, userMessage })
      return r.text
    }

    const settings = workspaceRepository.getSettings(workspaceId)
    const provider = settings.llmProvider ?? 'claude'

    if (provider === 'local-llm') {
      const ws = workspaceRepository.findById(workspaceId)
      if (!ws?.repoPath) throw new Error('workspace has no repo path')

      const localCfg = modelConfigService.getLocalLLMConfig(ws.repoPath)
      const result = await runOneShotLocal({
        systemPrompt: SYSTEM_PROMPT,
        userMessage,
        baseUrl: modelConfigService.getLocalBaseUrl(localCfg),
        model: this.resolveLocalModel(workspaceId, localCfg),
        apiKey: localCfg.localApiKey,
        feature: 'design_route',
        workspaceId,
        maxTokens: 400,
        timeoutMs: ROUTE_TIMEOUT_MS
      })
      return result.text
    }

    const model = modelConfigService.getModelById(workspaceId, 'design:route')
    const { text } = await runOneShotClaude({
      feature: 'design_route',
      model,
      workspaceId,
      args: [
        '-p',
        userMessage,
        '--model',
        model,
        '--system-prompt',
        SYSTEM_PROMPT,
        '--permission-mode',
        'plan',
        '--max-turns',
        '1',
        '--tools',
        '',
        '--no-session-persistence'
      ],
      cli: { timeout: ROUTE_TIMEOUT_MS },
      _runner: this._runner
    })
    return text
  }
}

export const designRouteService = new DesignRouteService()
