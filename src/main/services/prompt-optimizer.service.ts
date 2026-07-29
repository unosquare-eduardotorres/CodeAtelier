/**
 * PromptOptimizerService — rewrites user chat prompts for clarity before dispatch.
 *
 * A cheap one-shot Haiku call makes the prompt more explicit and unambiguous while
 * preserving the user's core intent and language. The optimizer:
 *  - Skips short prompts (<80 chars), slash commands, disabled setting, local-LLM
 *  - Wraps the original in <original_prompt> tags to prevent injection
 *  - Parses a ```optimized-prompt fenced block or NO_CHANGES sentinel
 *  - Rejects oversize output (>max(4× original, 2000) chars)
 *  - Rejects keyword drift (<40% of original keywords preserved, with stemming)
 *  - Falls back to the original prompt on any error
 *
 * Follows the GoalDecomposerService singleton pattern.
 */

import log from 'electron-log'
import { runOneShotClaude, type OneShotClaudeOptions } from './one-shot-claude'
import { runOneShotLocal } from './one-shot-local'
import { modelConfigService, resolveAssignment, buildResolveOpts } from './model-config.service'
import { workspaceRepository } from '../db/repositories'
import { backgroundCliSession } from './background-cli-session'
import { usageTrackerService } from './usage-tracker.service'

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
- Keep the rewritten prompt roughly the same length as the original (±50%). Do NOT expand a short sentence into a detailed specification.
- Do NOT decompose a single request into numbered sub-tasks unless the original already lists multiple steps.
- Do NOT add examples, technologies, or file formats the user didn't mention.
- If the prompt is already clear and actionable, output the literal text NO_CHANGES.
- You MUST output ONLY a single fenced block with the optimized prompt, or the literal NO_CHANGES. No explanation, no commentary.

Output format (when changes are made):
\`\`\`optimized-prompt
<your rewritten prompt here>
\`\`\`

Or, if the prompt is already good:
NO_CHANGES`

const STOP_WORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'been', 'were', 'will',
  'would', 'could', 'should', 'their', 'there', 'about', 'which',
  'when', 'what', 'your', 'also', 'more', 'some', 'make', 'like',
  'them', 'then', 'than', 'each', 'into', 'only', 'very', 'just',
  'does', 'here', 'much', 'well', 'back', 'even', 'most', 'made',
  'after', 'those', 'these', 'other', 'being', 'over', 'such',
  'before', 'between', 'under', 'using', 'based', 'please',
  'ensure', 'include', 'following', 'currently',
])

// ── Result types ─────────────────────────────────────────────────────────

export interface PromptOptimizeResult {
  /** The text to dispatch — either optimized or original */
  optimizedText: string
  /** Whether the text was actually changed */
  changed: boolean
  /** If skipped or fell back, the reason */
  skippedReason?: string
  /** Human-readable error detail when skippedReason is 'error' */
  errorDetail?: string
}

// ── Service ──────────────────────────────────────────────────────────────

class PromptOptimizerService {
  /** Test seam — overrides the CLI runner when set. Defaults to undefined (uses runOneShotClaude). */
  _runner?: OneShotClaudeOptions['_runner']
  /** R6-B1: Test seam for the local LLM path — overrides runOneShotLocal when set. */
  _localRunner?: (opts: { systemPrompt: string; userMessage: string }) => Promise<{ text: string }>

  /**
   * Resolve the local model id for prompt optimization.
   * Only honors the assignment when it explicitly targets a local provider —
   * default assignments resolve to Claude models, which oMLX 404s on.
   */
  resolveLocalModel(
    workspaceId: string,
    localCfg: { localModel?: string }
  ): string {
    const assignment = resolveAssignment({
      action: 'prompt:optimize',
      ...buildResolveOpts(workspaceId)
    })
    return (assignment.provider === 'local-llm' && assignment.modelId)
      ? assignment.modelId
      : (localCfg.localModel ?? 'qwen3-coder')
  }

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

    // R6-B1: Removed local-llm guard — optimizer now runs via runOneShotLocal for local providers

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

    const modeHint = mode === 'plan'
      ? 'The user is in Plan mode (thinking, planning, Q&A — no code execution).'
      : 'The user is in Build mode (code writing, execution, and tool use).'
    const wrappedPrompt = `<original_prompt>\n${text}\n</original_prompt>\n\n${modeHint}`

    // ── R6-B1: Local LLM path via runOneShotLocal ──
    const settings = workspaceRepository.getSettings(workspaceId)
    const provider = settings.llmProvider ?? 'claude'

    if (provider === 'local-llm') {
      return this.optimizeLocal({ text, workspaceId, wrappedPrompt })
    }

    // ── Claude path ──
    const model = modelConfigService.getModelById(workspaceId, 'prompt:optimize')
    try {
      let responseText: string

      if (this._runner) {
        // Test seam — bypass warm session, use one-shot path
        const { text: t } = await runOneShotClaude({
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
        responseText = t
      } else {
        // Warm session path — persistent interactive CLI process
        try {
          backgroundCliSession.setSystemPrompt(META_PROMPT)
          backgroundCliSession.setModel(model)
          const { text: t, usage } = await backgroundCliSession.run({
            userMessage: wrappedPrompt,
            timeoutMs: 15_000
          })
          responseText = t

          // Record usage (previously handled inside runOneShotClaude)
          usageTrackerService.recordUsage({
            feature: 'prompt_optimize',
            model,
            workspaceId,
            conversationId: params.conversationId,
            tokens: usage
          })
        } catch (warmErr) {
          optimizerLog.warn('[optimize] Warm session failed, falling back to one-shot:',
            (warmErr as Error).message)
          // Fallback: fresh one-shot `claude -p` call
          const { text: t } = await runOneShotClaude({
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
            cli: { timeout: 15_000 }
          })
          responseText = t
        }
      }

      return this.parseResponse(responseText, text)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      optimizerLog.warn('[optimize] Claude CLI call failed, using original:', msg)
      return { optimizedText: text, changed: false, skippedReason: 'error', errorDetail: msg }
    }
  }

  // ── R6-B1: Local LLM optimization path ──────────────────────────────

  private async optimizeLocal(params: {
    text: string
    workspaceId: string
    wrappedPrompt: string
  }): Promise<PromptOptimizeResult> {
    const { text, workspaceId, wrappedPrompt } = params

    try {
      let responseText: string

      if (this._localRunner) {
        // Test seam
        const r = await this._localRunner({ systemPrompt: META_PROMPT, userMessage: wrappedPrompt })
        responseText = r.text
      } else {
        const ws = workspaceRepository.findById(workspaceId)
        const workspacePath = ws?.repoPath
        if (!workspacePath) {
          optimizerLog.warn('[optimize] No workspace path found, using original')
          return { optimizedText: text, changed: false, skippedReason: 'error', errorDetail: 'No workspace path found' }
        }

        const localCfg = modelConfigService.getLocalLLMConfig(workspacePath)
        const baseUrl = modelConfigService.getLocalBaseUrl(localCfg)
        const model = this.resolveLocalModel(workspaceId, localCfg)

        const result = await runOneShotLocal({
          systemPrompt: META_PROMPT,
          userMessage: wrappedPrompt,
          baseUrl,
          model,
          apiKey: localCfg.localApiKey,
          feature: 'prompt_optimize',
          workspaceId,
          maxTokens: Math.min(Math.max(Math.ceil(text.length / 2), 512), 4096),
          timeoutMs: 30_000
          // No claudeFallbackArgs — empty response → skippedReason: 'error' → original prompt used
        })

        responseText = result.text
      }

      if (!responseText) {
        optimizerLog.warn('[optimize] Empty local LLM response, using original')
        return { optimizedText: text, changed: false, skippedReason: 'error', errorDetail: 'Empty response from local LLM' }
      }

      // R6-B1: Strip <think>…</think> blocks from local model reasoning leakage
      responseText = this.stripThinkingBlocks(responseText)

      return this.parseResponse(responseText, text)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      optimizerLog.warn('[optimize] Local LLM call failed, using original:', msg)
      return { optimizedText: text, changed: false, skippedReason: 'error', errorDetail: msg }
    }
  }

  // ── Response parsing ─────────────────────────────────────────────────

  /** Strip <think>…</think> blocks that local reasoning models sometimes emit */
  private stripThinkingBlocks(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  }

  /**
   * Basic suffix stripping — covers 80% of false positives from morphological
   * variations ("processing" → "process" matches "processed").
   */
  private stemWord(word: string): string {
    return word
      .replace(/(ation|tion|sion|ment|ness|ence|ance|ity|ous|ive|ing|ied|ies|ers|est|ful|less|able|ible)$/, '')
      .replace(/(ed|ly|er|al)$/, '')
  }

  /**
   * Extract significant words (≥4 chars, lowercased, stemmed, deduplicated) from text.
   * Filters out common English stop words, then applies basic stemming.
   */
  private extractKeywords(text: string): Set<string> {
    const words = text.toLowerCase().match(/[a-z]{4,}/g) ?? []
    return new Set(
      words
        .filter(w => !STOP_WORDS.has(w))
        .map(w => this.stemWord(w))
        .filter(w => w.length >= 3)
    )
  }

  /**
   * Check that the optimized prompt preserves ≥40% of the original's keywords.
   * Returns the preservation ratio (0–1).
   */
  private keywordPreservation(original: string, optimized: string): number {
    const origKeywords = this.extractKeywords(original)
    if (origKeywords.size < 3) return 1 // too few keywords to judge
    const optKeywords = this.extractKeywords(optimized)
    let preserved = 0
    for (const kw of origKeywords) {
      if (optKeywords.has(kw)) preserved++
    }
    return preserved / origKeywords.size
  }

  private parseResponse(response: string, original: string): PromptOptimizeResult {
    const trimmed = response.trim()

    // NO_CHANGES sentinel — exact match or starts-with (model may append whitespace)
    if (trimmed === 'NO_CHANGES' || trimmed.startsWith('NO_CHANGES')) {
      return { optimizedText: original, changed: false }
    }

    // Parse fenced block: prefer ```optimized-prompt ... ```, fallback to a single generic ``` fence
    let fenceMatch = trimmed.match(/```optimized-prompt\s*\n([\s\S]*?)```/)
    if (!fenceMatch || fenceMatch[1] === undefined) {
      // Fallback: accept a single generic fenced block (any or no info string)
      // — local models (qwen, llama) often emit plain ``` fences instead of the requested tag
      const genericFences = [...trimmed.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
      if (genericFences.length === 1 && genericFences[0][1] !== undefined) {
        fenceMatch = genericFences[0]
        optimizerLog.info('[optimize] Accepted single generic fence block (local-model fallback)')
      } else {
        optimizerLog.warn('[optimize] Failed to parse fenced block, using original')
        return { optimizedText: original, changed: false, skippedReason: 'parse-error' }
      }
    }

    const optimized = fenceMatch[1].trim()

    // Guard: empty
    if (!optimized) {
      optimizerLog.warn('[optimize] Empty optimized prompt, using original')
      return { optimizedText: original, changed: false, skippedReason: 'empty-output' }
    }

    // Guard: oversize — reject output > max(4× original, 2000 chars)
    // Floor of 2000 lets short prompts (~250 chars) expand into structured rewrites.
    // The 4× ratio is the proportional safety net at every scale.
    const maxLen = Math.max(original.length * 4, 2000)
    if (optimized.length > maxLen) {
      optimizerLog.warn(
        `[optimize] Oversize output (${optimized.length} > ${maxLen}), using original`
      )
      return { optimizedText: original, changed: false, skippedReason: 'oversize' }
    }

    // Guard: keyword drift — reject if <40% of original keywords survive (with stemming)
    const preservation = this.keywordPreservation(original, optimized)
    if (preservation < 0.4) {
      optimizerLog.warn(
        `[optimize] Keyword drift (${(preservation * 100).toFixed(0)}% preserved), using original`
      )
      return { optimizedText: original, changed: false, skippedReason: 'keyword-drift' }
    }

    // Guard: no actual change
    if (optimized === original) {
      return { optimizedText: original, changed: false }
    }

    return { optimizedText: optimized, changed: true }
  }
}

export const promptOptimizerService = new PromptOptimizerService()
