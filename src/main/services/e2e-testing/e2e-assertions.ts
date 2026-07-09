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
        reason: passed
          ? undefined
          : `Response length ${text.length} < minimum ${n}`
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
          t.toolName === toolName ||
          t.toolName.toLowerCase().includes(toolName.toLowerCase())
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

      // Try to find JSON object/array boundaries
      if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) {
        const objStart = jsonStr.indexOf('{')
        const arrStart = jsonStr.indexOf('[')
        const start = objStart >= 0 && arrStart >= 0
          ? Math.min(objStart, arrStart)
          : Math.max(objStart, arrStart)
        if (start >= 0) {
          jsonStr = jsonStr.slice(start)
        }
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
        return (
          t.toolName === toolName ||
          t.toolName.toLowerCase().includes(toolName.toLowerCase())
        )
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
          (t) =>
            t.toolName === name ||
            t.toolName?.toLowerCase().includes(name.toLowerCase())
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
      // Check for Write tool calls that target this path
      const writeTools = getToolUses(transcript).filter(
        (t) =>
          t.toolName?.toLowerCase().includes('write') &&
          t.toolArgs?.file_path &&
          String(t.toolArgs.file_path).includes(relPath)
      )

      if (writeTools.length === 0) {
        return {
          name: `fileExistsInFixture(${relPath})`,
          passed: false,
          reason: `No Write tool call found targeting "${relPath}"`
        }
      }

      if (contentRegex) {
        const content = String(writeTools[0].toolArgs?.content ?? '')
        const passed = contentRegex.test(content)
        return {
          name: `fileExistsInFixture(${relPath})`,
          passed,
          reason: passed ? undefined : `File content did not match /${contentRegex.source}/`
        }
      }

      return { name: `fileExistsInFixture(${relPath})`, passed: true }
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
