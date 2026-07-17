/**
 * BlueprintVerifyExtractor — deterministic post-hoc extraction of structured
 * verify findings from raw agent output.
 *
 * When the verify agent completes without emitting the structured
 * `blueprint-phase-complete` fence block, this module makes a cheap one-shot
 * Haiku call to extract overallStatus, findings, artifact counts, and
 * remediation tasks from the raw streaming text.
 *
 * Uses the existing runOneShotClaude infrastructure — no new dependencies.
 */

import log from 'electron-log'
import { runOneShotClaude } from './one-shot-claude'
import { modelConfigService } from './model-config.service'
import type { BlueprintPhaseCompletion } from '../../shared/blueprint-types'

const extractorLog = log.scope('blueprint-verify-extractor')

// ── Extraction Prompt ──

const EXTRACTION_SYSTEM_PROMPT = `You are a structured data extractor. You receive the raw text output from a code verification agent and extract its findings into a fixed JSON schema.

Rules:
- Read the entire text carefully.
- Determine the overall verification status:
  - "passed" — all checks passed, no gaps found
  - "gaps_found" — one or more real issues, missing files, broken tests, or stub implementations found
  - "human_needed" — issues found that require human judgment (security, architecture decisions)
- Extract individual findings with descriptions and affected file paths.
- Count artifact statuses: missing (file doesn't exist), stub (placeholder code), orphaned (exists but unused).
- If the agent found actionable gaps, generate remediation tasks with IDs (R001, R002, ...) and descriptions.
- Only include findings the agent explicitly identified — never invent issues.
- If the agent's text is too short or unclear to determine status, use "gaps_found" as the conservative default.

You MUST output ONLY valid JSON matching this exact schema — no markdown, no commentary, no fence blocks.`

// ── Max input size for extraction (keep Haiku fast + cheap) ──
const MAX_EXTRACTION_INPUT_CHARS = 80_000

/**
 * Extract structured verify findings from raw agent output text.
 *
 * Makes a one-shot Haiku call with the raw text and returns a parsed
 * BlueprintPhaseCompletion, or null if extraction fails.
 *
 * Designed to be cheap and fast (~2s, ~$0.003). Falls back gracefully
 * on any error — the caller should treat null as "extraction failed,
 * use existing fallback behavior."
 */
export async function extractVerifyCompletion(params: {
  text: string
  blueprintId: string
  workspaceId: string
}): Promise<BlueprintPhaseCompletion | null> {
  const { text, blueprintId, workspaceId } = params

  // Guard: too little text to extract from
  if (text.length < 100) {
    extractorLog.info(
      `[extractVerifyCompletion] Text too short (${text.length} chars) — skipping extraction`
    )
    return null
  }

  // Truncate to keep Haiku fast. Prefer the tail (findings are at the end).
  let extractionInput = text
  if (text.length > MAX_EXTRACTION_INPUT_CHARS) {
    const head = text.slice(0, 10_000)
    const tail = text.slice(-(MAX_EXTRACTION_INPUT_CHARS - 10_000))
    extractionInput =
      head +
      '\n\n[… middle truncated for extraction …]\n\n' +
      tail
    extractorLog.info(
      `[extractVerifyCompletion] Truncated input from ${text.length} to ${extractionInput.length} chars`
    )
  }

  const userMessage = [
    'Extract structured verification findings from the following agent output.',
    '',
    '<agent_output>',
    extractionInput,
    '</agent_output>'
  ].join('\n')

  const model = modelConfigService.getModelById(workspaceId, 'haiku')

  try {
    const { text: responseText } = await runOneShotClaude({
      feature: 'verify_extract',
      model,
      workspaceId,
      args: [
        '-p', userMessage,
        '--model', model,
        '--system-prompt', EXTRACTION_SYSTEM_PROMPT,
        '--permission-mode', 'plan',
        '--max-turns', '1'
      ],
      cli: { timeout: 30_000 } // 30s generous timeout for large inputs
    })

    return parseExtractionResponse(responseText, blueprintId)
  } catch (err) {
    extractorLog.warn(
      `[extractVerifyCompletion] Extraction call failed for blueprint ${blueprintId}:`, err
    )
    return null
  }
}

/**
 * Parse the extraction response into a BlueprintPhaseCompletion.
 * Accepts raw JSON (from the LLM) — strips markdown fences if present.
 */
export function parseExtractionResponse(
  responseText: string,
  blueprintId: string
): BlueprintPhaseCompletion | null {
  // Strip markdown fences if present (LLM sometimes wraps in ```json)
  let jsonText = responseText.trim()
  const fenceMatch = jsonText.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  if (fenceMatch?.[1]) {
    jsonText = fenceMatch[1].trim()
  }

  try {
    const parsed = JSON.parse(jsonText)

    // Validate required fields
    if (!parsed.overallStatus) {
      extractorLog.warn(
        `[parseExtractionResponse] Missing overallStatus in extraction for blueprint ${blueprintId}`
      )
      return null
    }

    // Normalize overallStatus to known values
    const validStatuses = new Set(['passed', 'gaps_found', 'human_needed'])
    if (!validStatuses.has(parsed.overallStatus)) {
      extractorLog.warn(
        `[parseExtractionResponse] Unknown overallStatus '${parsed.overallStatus}' — defaulting to 'gaps_found'`
      )
      parsed.overallStatus = 'gaps_found'
    }

    // Build BlueprintPhaseCompletion
    return {
      phase: 'verify',
      status: 'complete',
      ...parsed
    } as BlueprintPhaseCompletion
  } catch (err) {
    extractorLog.warn(
      `[parseExtractionResponse] JSON parse failed for blueprint ${blueprintId}:`, err
    )
    return null
  }
}
