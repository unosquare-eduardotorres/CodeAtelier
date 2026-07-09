/**
 * PromptOptimizerService — rewrites user chat prompts for clarity before dispatch.
 *
 * A cheap one-shot Haiku call makes the prompt more explicit and unambiguous while
 * preserving the user's core intent and language. The optimizer:
 *  - Skips short prompts (<80 chars), slash commands, disabled setting, local-LLM
 *  - Wraps the original in <original_prompt> tags to prevent injection
 *  - Parses a ```optimized-prompt fenced block or NO_CHANGES sentinel
 *  - Rejects oversize output (>min(4× original, 4000) chars)
 *  - Falls back to the original prompt on any error
 *
 * Follows the GoalDecomposerService singleton pattern.
 */

import log from 'electron-log'
import { runOneShotClaude, type OneShotClaudeOptions } from './one-shot-claude'
import { modelConfigService } from './model-config.service'
import { workspaceRepository } from '../db/repositories'

const optimizerLog = log.scope('prompt-optimizer')

// ── Meta-prompt ──────────────────────────────────────────────────────────

const META_PROMPT = `You are a prompt optimizer. Your job is to rewrite a user's chat prompt so it is clearer, more actionable, and less ambiguous for a coding assistant — while preserving the user's core intent, language, and tone.

Rules:
- Make instructions explicit and unambiguous.
- Add structure (numbered steps, bullet points) only when it genuinely helps clarity.
- Preserve the user's terminology and phrasing where possible.
- Stay self-contained — don't reference prior conversation context you don't have.
- Never answer the prompt — only rewrite it.
- Never invent requirements, constraints, or technologies the user didn't mention.
- If the prompt is already clear and actionable, output the literal text NO_CHANGES.
- You MUST output ONLY a single fenced block with the optimized prompt, or the literal NO_CHANGES. No explanation, no commentary.

Output format (when changes are made):
\`\`\`optimized-prompt
<your rewritten prompt here>
\`\`\`

Or, if the prompt is already good:
NO_CHANGES`

// ── Result types ─────────────────────────────────────────────────────────

export interface PromptOptimizeResult {
  /** The text to dispatch — either optimized or original */
  optimizedText: string
  /** Whether the text was actually changed */
  changed: boolean
  /** If skipped or fell back, the reason */
  skippedReason?: string
}

// ── Service ──────────────────────────────────────────────────────────────

class PromptOptimizerService {
  /** Test seam — overrides the CLI runner when set. Defaults to undefined (uses runClaudeCliOneShot). */
  _runner?: OneShotClaudeOptions['_runner']

  /**
   * Check whether the optimizer should run for this prompt.
   * Returns null if the optimizer should proceed, or a skip reason string if not.
   * Call this BEFORE emitting a running card so guarded prompts produce no card.
   */
  checkGuards(params: {
    text: string
    workspaceId: string
  }): string | null {
    const { text, workspaceId } = params

    const settings = workspaceRepository.getSettings(workspaceId)
    if (settings.promptOptimizationEnabled === false) return 'disabled'

    const provider = settings.llmProvider ?? 'claude'
    if (provider === 'local-llm') return 'local-llm'

    if (text.length < 80) return 'short'
    if (text.trimStart().startsWith('/')) return 'slash-command'
    // NOTE: Grill mode never reaches stream() — it uses GrillAgentService + grill.ipc.ts
    // (intent-router.ts routes grill prompts away from chat). No guard needed here.

    return null // guards pass — proceed with optimization
  }

  /**
   * Optimize a user prompt for clarity before dispatch.
   * Returns the original text unchanged when any guard triggers or on error.
   */
  async optimize(params: {
    text: string
    workspaceId: string
    conversationId: string
    mode: 'plan' | 'build'
  }): Promise<PromptOptimizeResult> {
    const { text, workspaceId, mode } = params

    // ── Guard check (also callable externally via checkGuards) ──
    const guardReason = this.checkGuards({ text, workspaceId })
    if (guardReason) {
      return { optimizedText: text, changed: false, skippedReason: guardReason }
    }

    // ── Call Claude one-shot ──
    const model = modelConfigService.getModelById(workspaceId, 'prompt:optimize')
    const modeHint = mode === 'plan'
      ? 'The user is in Plan mode (thinking, planning, Q&A — no code execution).'
      : 'The user is in Build mode (code writing, execution, and tool use).'
    const wrappedPrompt = `<original_prompt>\n${text}\n</original_prompt>\n\n${modeHint}`

    try {
      const { text: responseText } = await runOneShotClaude({
        feature: 'prompt_optimize',
        model,
        workspaceId,
        conversationId: params.conversationId,
        args: [
          '-p', wrappedPrompt,
          '--model', model,
          '--system-prompt', META_PROMPT,
          '--permission-mode', 'plan',
          '--max-turns', '1'
        ],
        cli: { timeout: 15_000 },
        _runner: this._runner
      })

      return this.parseResponse(responseText, text)
    } catch (err) {
      optimizerLog.warn('[optimize] Claude CLI call failed, using original:', err)
      return { optimizedText: text, changed: false, skippedReason: 'error' }
    }
  }

  // ── Response parsing ─────────────────────────────────────────────────

  private parseResponse(response: string, original: string): PromptOptimizeResult {
    const trimmed = response.trim()

    // NO_CHANGES sentinel — exact match or starts-with (model may append whitespace)
    if (trimmed === 'NO_CHANGES' || trimmed.startsWith('NO_CHANGES')) {
      return { optimizedText: original, changed: false }
    }

    // Parse fenced block: ```optimized-prompt ... ```
    const fenceMatch = trimmed.match(/```optimized-prompt\s*\n([\s\S]*?)```/)
    if (!fenceMatch || fenceMatch[1] === undefined) {
      optimizerLog.warn('[optimize] Failed to parse fenced block, using original')
      return { optimizedText: original, changed: false, skippedReason: 'parse-error' }
    }

    const optimized = fenceMatch[1].trim()

    // Guard: empty
    if (!optimized) {
      optimizerLog.warn('[optimize] Empty optimized prompt, using original')
      return { optimizedText: original, changed: false, skippedReason: 'empty-output' }
    }

    // Guard: oversize — reject output > min(4× original, 4000 chars)
    const maxLen = Math.min(original.length * 4, 4000)
    if (optimized.length > maxLen) {
      optimizerLog.warn(
        `[optimize] Oversize output (${optimized.length} > ${maxLen}), using original`
      )
      return { optimizedText: original, changed: false, skippedReason: 'oversize' }
    }

    // Guard: no actual change
    if (optimized === original) {
      return { optimizedText: original, changed: false }
    }

    return { optimizedText: optimized, changed: true }
  }
}

export const promptOptimizerService = new PromptOptimizerService()
