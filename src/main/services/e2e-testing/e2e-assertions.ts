/**
 * E2E Behavioral Assertions — run against captured transcript, never exact-match text.
 *
 * Each assertion is a function that returns { name, passed, reason? }.
 * The runner collects assertion results per scenario.
 */

import type { E2ETranscriptEntry, E2EAssertionResult } from '../../../shared/types'
import type { ZodType } from 'zod'

// ── Assertion Interface ──

export interface E2EAssertion {
  name: string
  run: (transcript: E2ETranscriptEntry[]) => E2EAssertionResult
}

// ── Transcript Helpers ──

function getAssistantText(transcript: E2ETranscriptEntry[]): string {
  return transcript
    .filter((e) => e.role === 'assistant' && e.type === 'text' && e.content)
    .map((e) => e.content!)
    .join('')
}

function getToolUses(transcript: E2ETranscriptEntry[]): E2ETranscriptEntry[] {
  return transcript.filter((e) => e.type === 'tool_use')
}

function hasErrorChunks(transcript: E2ETranscriptEntry[]): E2ETranscriptEntry[] {
  return transcript.filter((e) => e.type === 'error')
}

function hasStatusComplete(transcript: E2ETranscriptEntry[]): boolean {
  return transcript.some(
    (e) => e.type === 'status' && (e.content === 'complete' || e.content === 'done')
  )
}

// ── Assertion Factories ──

/** Assert the stream completed without error */
export function streamCompleted(): E2EAssertion {
  return {
    name: 'streamCompleted',
    run: (transcript) => {
      // Stream completion is indicated by having assistant text OR the stream simply finishing
      const hasText = getAssistantText(transcript).length > 0
      const hasComplete = hasStatusComplete(transcript)
      const passed = hasText || hasComplete
      return {
        name: 'streamCompleted',
        passed,
        reason: passed ? undefined : 'No assistant text or completion status found in transcript'
      }
    }
  }
}

/** Assert no error chunks in transcript */
export function noErrorChunks(): E2EAssertion {
  return {
    name: 'noErrorChunks',
    run: (transcript) => {
      const errors = hasErrorChunks(transcript)
      return {
        name: 'noErrorChunks',
        passed: errors.length === 0,
        reason:
          errors.length > 0
            ? `Found ${errors.length} error(s): ${errors.map((e) => e.content).join('; ')}`
            : undefined
      }
    }
  }
}

/** Assert response text matches a regex pattern */
export function responseMatches(pattern: RegExp): E2EAssertion {
  return {
    name: `responseMatches(${pattern.source})`,
    run: (transcript) => {
      const text = getAssistantText(transcript)
      const passed = pattern.test(text)
      return {
        name: `responseMatches(${pattern.source})`,
        passed,
        reason: passed
          ? undefined
          : `Response did not match /${pattern.source}/${pattern.flags}. Text length: ${text.length}`
      }
    }
  }
}

/** Assert response text is at least N characters */
export function responseMinLength(n: number): E2EAssertion {
  return {
    name: `responseMinLength(${n})`,
    run: (transcript) => {
      const text = getAssistantText(transcript)
      const passed = text.length >= n
      return {
        name: `responseMinLength(${n})`,
        passed,
        reason: passed ? undefined : `Response length ${text.length} < minimum ${n}`
      }
    }
  }
}

/** Assert a specific tool was called (optionally with an args matcher) */
export function toolCalled(
  toolName: string,
  argsMatcher?: (args: Record<string, unknown>) => boolean
): E2EAssertion {
  return {
    name: `toolCalled(${toolName})`,
    run: (transcript) => {
      const toolUses = getToolUses(transcript)
      const matching = toolUses.filter((t) => {
        if (!t.toolName) return false
        // Match by exact name or case-insensitive contains
        const nameMatch =
          t.toolName === toolName || t.toolName.toLowerCase().includes(toolName.toLowerCase())
        if (!nameMatch) return false
        if (argsMatcher && t.toolArgs) {
          return argsMatcher(t.toolArgs)
        }
        return true
      })

      const passed = matching.length > 0
      return {
        name: `toolCalled(${toolName})`,
        passed,
        reason: passed
          ? undefined
          : `Tool "${toolName}" was not called. Tools used: ${toolUses.map((t) => t.toolName).join(', ') || 'none'}`
      }
    }
  }
}

/** Assert at least some assistant response text exists */
export function responseExists(): E2EAssertion {
  return {
    name: 'responseExists',
    run: (transcript) => {
      const text = getAssistantText(transcript)
      return {
        name: 'responseExists',
        passed: text.length > 0,
        reason: text.length === 0 ? 'No assistant response found' : undefined
      }
    }
  }
}

/** Assert a specific tool was NOT called */
export function toolNotCalled(name: string): E2EAssertion {
  return {
    name: `toolNotCalled(${name})`,
    run: (transcript) => {
      const toolUses = getToolUses(transcript)
      const found = toolUses.some(
        (t) => t.toolName === name || t.toolName?.toLowerCase().includes(name.toLowerCase())
      )
      return {
        name: `toolNotCalled(${name})`,
        passed: !found,
        reason: found ? `Tool "${name}" was called but should not have been` : undefined
      }
    }
  }
}

/**
 * Extract a valid JSON string from text, optionally preferring one that passes a Zod schema.
 *
 * Strategy:
 *   1. Quick-path: if the entire text parses as JSON, return it.
 *   2. Scan every `{`/`[` position (not just whitespace-preceded — models often
 *      emit reasoning glued directly to JSON like `…directly.{"key":"val"}`).
 *   3. For each position, bracket-match forward to find the closing `}`/`]`,
 *      then try JSON.parse. Collect ALL parseable candidates.
 *   4. If a `schema` was provided, prefer the LAST candidate that validates —
 *      models emit reasoning first and answer last. Otherwise prefer the last
 *      parseable candidate (same rationale).
 *   5. No `indexOf` fallback — that was the source of the bug where
 *      `[T0/Convention]` was grabbed as garbage JSON.
 */
function extractJsonObject(text: string, schema?: ZodType): string | null {
  // Quick path: entire text is valid JSON
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      if (!schema || schema.safeParse(parsed).success) return text
      // Valid JSON but doesn't match schema — fall through to find alternatives
    } catch {
      // Not valid JSON — fall through to candidate search
    }
  }

  // Collect all parseable JSON candidates from every `{`/`[` in the text
  const candidates: { json: string; idx: number }[] = []

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== '{' && ch !== '[') continue

    const openBrack = ch
    const closeBrack = ch === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    let matchEnd = -1

    for (let j = i; j < text.length; j++) {
      const c = text[j]
      if (c === '"' && (j === 0 || text[j - 1] !== '\\')) {
        inString = !inString
      }
      if (!inString) {
        if (c === openBrack) depth++
        else if (c === closeBrack) depth--
        if (depth === 0) {
          matchEnd = j
          break
        }
      }
    }

    if (matchEnd !== -1) {
      const candidateStr = text.slice(i, matchEnd + 1)
      try {
        JSON.parse(candidateStr)
        candidates.push({ json: candidateStr, idx: i })
      } catch {
        // Not valid JSON — skip
      }
    }
  }

  if (candidates.length === 0) return null

  // Prefer schema-valid candidate (last one — models emit reasoning first, answer last)
  if (schema) {
    for (let i = candidates.length - 1; i >= 0; i--) {
      const parsed = JSON.parse(candidates[i].json)
      if (schema.safeParse(parsed).success) return candidates[i].json
    }
  }

  // Fall back to last parseable candidate
  return candidates[candidates.length - 1].json
}

/** Assert the response contains valid JSON matching a Zod schema */
export function validJson(schema: ZodType): E2EAssertion {
  return {
    name: 'validJson',
    run: (transcript) => {
      const text = getAssistantText(transcript).trim()

      // Try to extract JSON from the response — handle markdown code fences
      let jsonStr = text
      const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
      if (fenceMatch) {
        jsonStr = fenceMatch[1].trim()
      }

      // Extract JSON using schema-aware candidate search — prefers the LAST
      // schema-valid candidate (models emit reasoning first, answer last).
      // The harmful indexOf fallback was removed: it grabbed stray brackets
      // like [T0/Convention] and tried to parse garbage.
      const candidate = extractJsonObject(jsonStr, schema)
      if (candidate) {
        jsonStr = candidate
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(jsonStr)
      } catch (e) {
        return {
          name: 'validJson',
          passed: false,
          reason: `Failed to parse JSON: ${(e as Error).message}. Text: ${jsonStr.slice(0, 200)}`
        }
      }

      const result = schema.safeParse(parsed)
      if (!result.success) {
        return {
          name: 'validJson',
          passed: false,
          reason: `JSON schema validation failed: ${JSON.stringify(result.error.issues)}`
        }
      }

      return { name: 'validJson', passed: true }
    }
  }
}

/** Assert at least one thinking entry exists in transcript */
export function thinkingPresent(): E2EAssertion {
  return {
    name: 'thinkingPresent',
    run: (transcript) => {
      const hasThinking = transcript.some((e) => e.type === 'thinking')
      return {
        name: 'thinkingPresent',
        passed: hasThinking,
        reason: hasThinking ? undefined : 'No thinking entries found in transcript'
      }
    }
  }
}

/** Assert a specific tool was called at least N times */
export function toolCalledTimes(toolName: string, minCount: number): E2EAssertion {
  return {
    name: `toolCalledTimes(${toolName}, ${minCount})`,
    run: (transcript) => {
      const toolUses = getToolUses(transcript)
      const count = toolUses.filter((t) => {
        if (!t.toolName) return false
        return t.toolName === toolName || t.toolName.toLowerCase().includes(toolName.toLowerCase())
      }).length

      const passed = count >= minCount
      return {
        name: `toolCalledTimes(${toolName}, ${minCount})`,
        passed,
        reason: passed
          ? undefined
          : `Tool "${toolName}" called ${count} time(s), expected at least ${minCount}. Tools used: ${toolUses.map((t) => t.toolName).join(', ') || 'none'}`
      }
    }
  }
}

/** Assert at least one of a set of tools was called */
export function anyToolCalled(toolNames: string[]): E2EAssertion {
  return {
    name: `anyToolCalled([${toolNames.join(', ')}])`,
    run: (transcript) => {
      const toolUses = getToolUses(transcript)
      const found = toolNames.some((name) =>
        toolUses.some(
          (t) => t.toolName === name || t.toolName?.toLowerCase().includes(name.toLowerCase())
        )
      )

      return {
        name: `anyToolCalled([${toolNames.join(', ')}])`,
        passed: found,
        reason: found
          ? undefined
          : `None of [${toolNames.join(', ')}] were called. Tools used: ${toolUses.map((t) => t.toolName).join(', ') || 'none'}`
      }
    }
  }
}

/** Assert response contains a MermaidJS code block with non-empty body */
export function responseHasMermaidBlock(): E2EAssertion {
  return {
    name: 'responseHasMermaidBlock',
    run: (transcript) => {
      const text = getAssistantText(transcript)
      const mermaidPattern = /```mermaid\s*\n([\s\S]+?)\n```/
      const match = mermaidPattern.test(text)
      return {
        name: 'responseHasMermaidBlock',
        passed: match,
        reason: match ? undefined : 'No ```mermaid code block with non-empty body found in response'
      }
    }
  }
}

/** Assert response contains a markdown table (pipe rows + separator) */
export function responseHasMarkdownTable(): E2EAssertion {
  return {
    name: 'responseHasMarkdownTable',
    run: (transcript) => {
      const text = getAssistantText(transcript)
      // A markdown table has at least: header row, separator row (|---|), data row
      const hasSeparator = /\|[-:]+\|/.test(text)
      const pipeRows = (text.match(/^\|.+\|$/gm) || []).length
      const passed = hasSeparator && pipeRows >= 2
      return {
        name: 'responseHasMarkdownTable',
        passed,
        reason: passed
          ? undefined
          : `No valid markdown table found (separator: ${hasSeparator}, pipe rows: ${pipeRows})`
      }
    }
  }
}

/** Assert any status entry content matches a regex pattern */
export function statusEntryMatches(pattern: RegExp): E2EAssertion {
  return {
    name: `statusEntryMatches(${pattern.source})`,
    run: (transcript) => {
      const statusEntries = transcript.filter((e) => e.type === 'status' && e.content)
      const found = statusEntries.some((e) => pattern.test(e.content!))
      return {
        name: `statusEntryMatches(${pattern.source})`,
        passed: found,
        reason: found
          ? undefined
          : `No status entry matched /${pattern.source}/${pattern.flags}. Status entries: ${statusEntries.map((e) => e.content).join('; ') || 'none'}`
      }
    }
  }
}

/** Assert that the turn count does not exceed N */
export function turnCountAtMost(n: number): E2EAssertion {
  return {
    name: `turnCountAtMost(${n})`,
    run: (transcript) => {
      const userTurns = transcript.filter((e) => e.role === 'user' && e.type === 'text').length
      return {
        name: `turnCountAtMost(${n})`,
        passed: userTurns <= n,
        reason: userTurns > n ? `User turns ${userTurns} exceeded max ${n}` : undefined
      }
    }
  }
}

/** Assert a file exists in the fixture (checked via tool_result from Write) */
export function fileExistsInFixture(relPath: string, contentRegex?: RegExp): E2EAssertion {
  return {
    name: `fileExistsInFixture(${relPath})`,
    run: (transcript) => {
      // R6-A3: Accept both file_path (snake_case) and filePath (camelCase) — OpenCode
      // uses camelCase while Claude CLI uses snake_case. Scan ALL matching Write calls.
      const writeTools = getToolUses(transcript).filter((t) => {
        if (!t.toolName?.toLowerCase().includes('write')) return false
        const fp = t.toolArgs?.file_path ?? t.toolArgs?.filePath
        return fp && String(fp).includes(relPath)
      })

      if (writeTools.length === 0) {
        return {
          name: `fileExistsInFixture(${relPath})`,
          passed: false,
          reason: `No Write tool call found targeting "${relPath}"`
        }
      }

      if (contentRegex) {
        // R6-A3: Scan all matching Write calls — pass if ANY has matching content
        const anyMatch = writeTools.some((w) => {
          const content = String(w.toolArgs?.content ?? '')
          return contentRegex.test(content)
        })
        return {
          name: `fileExistsInFixture(${relPath})`,
          passed: anyMatch,
          reason: anyMatch ? undefined : `No Write call content matched /${contentRegex.source}/`
        }
      }

      return { name: `fileExistsInFixture(${relPath})`, passed: true }
    }
  }
}

// ── Prompt Optimizer Assertions (R6-B3) ──
// Names deliberately avoid /toolCalled|anyToolCalled|fileExistsInFixture/ so
// scenarioRequiresTools() doesn't force the tools-preflight gate.

/** Assert the Prompt Optimizer tool_use entry exists in transcript */
export function promptOptimizerRan(): E2EAssertion {
  return {
    name: 'promptOptimizerRan',
    run: (transcript) => {
      const found = transcript.some(
        (e) => e.type === 'tool_use' && e.toolName === 'Prompt Optimizer'
      )
      return {
        name: 'promptOptimizerRan',
        passed: found,
        reason: found ? undefined : 'Prompt Optimizer tool_use entry not found in transcript'
      }
    }
  }
}

/** Assert the Prompt Optimizer tool_result exists with non-empty, non-error content.
 *  The optimizer emits 'Error — original prompt sent' on failure (e.g. oMLX 404);
 *  that must NOT count as a successful result. */
export function promptOptimizerResultPresent(): E2EAssertion {
  const ERROR_SENTINEL = 'Error — original prompt sent'
  return {
    name: 'promptOptimizerResultPresent',
    run: (transcript) => {
      const results = transcript.filter(
        (e) => e.type === 'tool_result' && e.toolName === 'Prompt Optimizer'
      )
      if (results.length === 0) {
        return {
          name: 'promptOptimizerResultPresent',
          passed: false,
          reason: 'Prompt Optimizer tool_result not found in transcript'
        }
      }
      const hasError = results.some((e) => {
        const content = e.toolResult ?? e.content ?? ''
        return content.includes(ERROR_SENTINEL)
      })
      if (hasError) {
        return {
          name: 'promptOptimizerResultPresent',
          passed: false,
          reason: `Prompt Optimizer returned error sentinel: "${ERROR_SENTINEL}"`
        }
      }
      const found = results.some((e) => (e.toolResult ?? e.content ?? '').length > 0)
      return {
        name: 'promptOptimizerResultPresent',
        passed: found,
        reason: found ? undefined : `Prompt Optimizer tool_result empty. Results: ${results.length}`
      }
    }
  }
}

/** Assert the Prompt Optimizer actually rewrote the prompt (not "No changes needed",
 *  not an error/failure sentinel). Content must be ≥20 chars of real rewritten text. */
export function promptOptimizerChanged(): E2EAssertion {
  const FAILURE_PATTERNS = [
    'No changes needed',
    'Error — original prompt sent',
    'Optimization failed'
  ]
  return {
    name: 'promptOptimizerChanged',
    run: (transcript) => {
      const results = transcript.filter(
        (e) => e.type === 'tool_result' && e.toolName === 'Prompt Optimizer'
      )
      if (results.length === 0) {
        return {
          name: 'promptOptimizerChanged',
          passed: false,
          reason: 'Prompt Optimizer tool_result not found in transcript'
        }
      }
      const content = results.map((e) => e.toolResult ?? e.content ?? '').join('')
      const isFailure = FAILURE_PATTERNS.some((p) => content.includes(p))
      if (isFailure) {
        return {
          name: 'promptOptimizerChanged',
          passed: false,
          reason: `Prompt Optimizer did not rewrite — content: "${content.slice(0, 120)}"`
        }
      }
      if (content.length < 20) {
        return {
          name: 'promptOptimizerChanged',
          passed: false,
          reason: `Prompt Optimizer content too short (${content.length} chars) — likely not a real rewrite`
        }
      }
      return { name: 'promptOptimizerChanged', passed: true }
    }
  }
}

/** Assert the response text does NOT contain a pattern (safety / non-leakage checks). */
export function responseOmits(pattern: RegExp): E2EAssertion {
  return {
    name: `responseOmits(${pattern.source})`,
    run: (transcript) => {
      const text = getAssistantText(transcript)
      const leaked = pattern.test(text)
      return {
        name: `responseOmits(${pattern.source})`,
        passed: !leaked,
        reason: leaked ? `Response contained forbidden pattern /${pattern.source}/` : undefined
      }
    }
  }
}

/** Assert the total number of tool calls does not exceed N (loop-guard ceiling). */
export function toolCallCountAtMost(n: number): E2EAssertion {
  return {
    name: `toolCallCountAtMost(${n})`,
    run: (transcript) => {
      const count = getToolUses(transcript).length
      return {
        name: `toolCallCountAtMost(${n})`,
        passed: count <= n,
        reason: count > n ? `Tool called ${count} times, exceeds ceiling ${n}` : undefined
      }
    }
  }
}

/** Assert the response text is at most N characters (truncation / brevity check). */
export function responseMaxLength(n: number): E2EAssertion {
  return {
    name: `responseMaxLength(${n})`,
    run: (transcript) => {
      const text = getAssistantText(transcript)
      const passed = text.length <= n
      return {
        name: `responseMaxLength(${n})`,
        passed,
        reason: passed ? undefined : `Response length ${text.length} > maximum ${n}`
      }
    }
  }
}

/**
 * Assert the response exhibits compression / brevity consistent with caveman tone.
 * Checks: short average sentence length, absence of articles/filler words in high
 * frequency, and overall response brevity relative to a normal response.
 * This is heuristic — not exact — but catches obviously non-compressed responses.
 */
export function responseBrevityCheck(
  opts: {
    /** Maximum average words per sentence (caveman ≈ 5–8, normal ≈ 15–25) */
    maxAvgWordsPerSentence?: number
    /** Max ratio of filler words (a/an/the/just/really/basically/certainly) to total words */
    maxFillerRatio?: number
    /** Max total words in response */
    maxTotalWords?: number
  } = {}
): E2EAssertion {
  const maxAvg = opts.maxAvgWordsPerSentence ?? 12
  const maxFiller = opts.maxFillerRatio ?? 0.08
  const maxWords = opts.maxTotalWords ?? 150

  const FILLER_WORDS = new Set([
    'a',
    'an',
    'the',
    'just',
    'really',
    'basically',
    'actually',
    'simply',
    'certainly',
    'sure',
    'of',
    'course',
    'happy',
    'to'
  ])

  return {
    name: 'responseBrevityCheck',
    run: (transcript) => {
      const text = getAssistantText(transcript)
      const words = text.split(/\s+/).filter(Boolean)
      if (words.length === 0) {
        return { name: 'responseBrevityCheck', passed: false, reason: 'No words in response' }
      }

      // Sentence count (split on .!?)
      const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0)
      const avgWordsPerSentence = words.length / Math.max(sentences.length, 1)

      // Filler ratio
      const fillerCount = words.filter((w) => FILLER_WORDS.has(w.toLowerCase())).length
      const fillerRatio = fillerCount / words.length

      const issues: string[] = []
      if (avgWordsPerSentence > maxAvg) {
        issues.push(`avgWords/sentence=${avgWordsPerSentence.toFixed(1)} > ${maxAvg}`)
      }
      if (fillerRatio > maxFiller) {
        issues.push(
          `fillerRatio=${(fillerRatio * 100).toFixed(1)}% > ${(maxFiller * 100).toFixed(0)}%`
        )
      }
      if (words.length > maxWords) {
        issues.push(`totalWords=${words.length} > ${maxWords}`)
      }

      const passed = issues.length === 0
      return {
        name: 'responseBrevityCheck',
        passed,
        reason: passed ? undefined : `Response not brief enough: ${issues.join(', ')}`
      }
    }
  }
}

/** Assert at least N status entries match the given regex (count check). */
export function statusEntryMatchesAtLeast(pattern: RegExp, minCount: number): E2EAssertion {
  return {
    name: `statusEntryMatchesAtLeast(${pattern.source}, ${minCount})`,
    run: (transcript) => {
      const statusEntries = transcript.filter((e) => e.type === 'status' && e.content)
      const matchCount = statusEntries.filter((e) => pattern.test(e.content!)).length
      const passed = matchCount >= minCount
      return {
        name: `statusEntryMatchesAtLeast(${pattern.source}, ${minCount})`,
        passed,
        reason: passed
          ? undefined
          : `Only ${matchCount} status entries matched /${pattern.source}/, expected at least ${minCount}`
      }
    }
  }
}

// ── Runner Helper ──

/** Run all assertions against a transcript and return results */
export function runAssertions(
  assertions: E2EAssertion[],
  transcript: E2ETranscriptEntry[]
): E2EAssertionResult[] {
  return assertions.map((a) => {
    try {
      return a.run(transcript)
    } catch (err) {
      return {
        name: a.name,
        passed: false,
        reason: `Assertion threw: ${(err as Error).message}`
      }
    }
  })
}
