/**
 * Structured Output Repair — retry-with-repair loop for local LLMs.
 *
 * Local models (unlike Claude) don't have native structured output guarantees.
 * When we need JSON conforming to a specific schema, this module:
 *
 *   1. Attempts to extract JSON from the model's raw text response
 *   2. Validates against the expected schema (simplified validation)
 *   3. If invalid, sends a repair prompt asking the model to fix the JSON
 *   4. Retries up to maxRetries times before returning a best-effort result
 *
 * Common issues with local model JSON output:
 *   - Markdown code fences around JSON (```json ... ```)
 *   - Trailing commas in arrays/objects
 *   - Single quotes instead of double quotes
 *   - Comments in JSON
 *   - Incomplete JSON (model hit token limit)
 *   - Extra text before/after JSON block
 *
 * Phase 4A — Local-First: Structured output enforcement for local LLMs.
 */

import log from 'electron-log/main'

const repairLog = log.scope('StructuredOutputRepair')

// ── Types ──

export interface JsonSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean'
  properties?: Record<string, JsonSchema & { description?: string }>
  required?: string[]
  items?: JsonSchema
}

export interface RepairResult<T = unknown> {
  /** Parsed and validated data (null if all retries failed) */
  data: T | null
  /** Whether the output was valid on the first attempt */
  validOnFirstAttempt: boolean
  /** Number of repair attempts made */
  repairAttempts: number
  /** Raw text from the last attempt */
  rawText: string
  /** Validation errors from the last failed attempt */
  lastErrors: string[]
}

/**
 * Callback to send a repair prompt to the model and get the response text.
 * This is injected by the caller to decouple from any specific LLM executor.
 */
export type RepairCallback = (repairPrompt: string) => Promise<string>

// ── JSON Extraction ──

/**
 * Extract JSON from raw model text, handling common formatting issues.
 *
 * Tries these strategies in order:
 *   1. Direct JSON.parse on the full text
 *   2. Extract from ```json code fences
 *   3. Extract from generic ``` code fences
 *   4. Find the first { or [ and parse from there
 *   5. Clean up common syntax errors and retry
 */
export function extractJson(rawText: string): { json: unknown; error?: string } {
  const text = rawText.trim()

  // Strategy 1: Direct parse
  try {
    return { json: JSON.parse(text) }
  } catch {
    // continue to next strategy
  }

  // Strategy 2: Extract from ```json ... ``` code fence
  const jsonFenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (jsonFenceMatch) {
    try {
      return { json: JSON.parse(jsonFenceMatch[1].trim()) }
    } catch {
      // Try cleaning the fenced content
      const cleaned = cleanJsonString(jsonFenceMatch[1].trim())
      try {
        return { json: JSON.parse(cleaned) }
      } catch {
        // continue
      }
    }
  }

  // Strategy 3: Find first { or [ and parse from there
  const firstBrace = text.indexOf('{')
  const firstBracket = text.indexOf('[')
  const startIdx = Math.min(
    firstBrace === -1 ? Infinity : firstBrace,
    firstBracket === -1 ? Infinity : firstBracket
  )

  if (startIdx !== Infinity) {
    const isObject = text[startIdx] === '{'
    const closer = isObject ? '}' : ']'

    // Find the matching closing brace/bracket
    let depth = 0
    let inString = false
    let escaped = false
    let endIdx = -1

    for (let i = startIdx; i < text.length; i++) {
      const char = text[i]

      if (escaped) {
        escaped = false
        continue
      }

      if (char === '\\' && inString) {
        escaped = true
        continue
      }

      if (char === '"') {
        inString = !inString
        continue
      }

      if (inString) continue

      if (char === text[startIdx]) depth++
      if (char === closer) {
        depth--
        if (depth === 0) {
          endIdx = i
          break
        }
      }
    }

    if (endIdx !== -1) {
      const jsonStr = text.slice(startIdx, endIdx + 1)
      try {
        return { json: JSON.parse(jsonStr) }
      } catch {
        const cleaned = cleanJsonString(jsonStr)
        try {
          return { json: JSON.parse(cleaned) }
        } catch {
          // continue
        }
      }
    }
  }

  // Strategy 4: Clean up common syntax errors on the whole text and retry
  const cleaned = cleanJsonString(text)
  try {
    return { json: JSON.parse(cleaned) }
  } catch (err) {
    return { json: null, error: `Failed to extract JSON: ${(err as Error).message}` }
  }
}

/**
 * Clean common JSON syntax errors from local model output.
 */
function cleanJsonString(text: string): string {
  let cleaned = text
    // Remove single-line comments (// ...)
    .replace(/\/\/[^\n]*$/gm, '')
    // Remove multi-line comments (/* ... */)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Remove trailing commas before } or ]
    .replace(/,\s*([}\]])/g, '$1')
  // Replace single quotes with double quotes (naive — doesn't handle escaped quotes)
  // Only do this if there are no double quotes (model used single quotes throughout)

  if (!cleaned.includes('"') && cleaned.includes("'")) {
    cleaned = cleaned.replace(/'/g, '"')
  }

  return cleaned.trim()
}

// ── Schema Validation ──

/**
 * Simplified schema validation for JSON objects.
 * Checks required fields and basic type constraints.
 * Returns an array of error messages (empty = valid).
 */
export function validateAgainstSchema(data: unknown, schema: JsonSchema): string[] {
  const errors: string[] = []

  if (schema.type === 'object') {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return ['Expected an object']
    }

    const obj = data as Record<string, unknown>

    // Check required fields
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in obj)) {
          errors.push(`Missing required field: ${field}`)
        }
      }
    }

    // Check property types
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj && obj[key] !== null && obj[key] !== undefined) {
          const propErrors = validateAgainstSchema(obj[key], propSchema)
          errors.push(...propErrors.map((e) => `${key}: ${e}`))
        }
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(data)) {
      return ['Expected an array']
    }

    if (schema.items) {
      for (let i = 0; i < (data as unknown[]).length; i++) {
        const itemErrors = validateAgainstSchema((data as unknown[])[i], schema.items)
        errors.push(...itemErrors.map((e) => `[${i}]: ${e}`))
      }
    }
  } else if (schema.type === 'string' && typeof data !== 'string') {
    errors.push(`Expected a string, got ${typeof data}`)
  } else if (schema.type === 'number' && typeof data !== 'number') {
    errors.push(`Expected a number, got ${typeof data}`)
  } else if (schema.type === 'boolean' && typeof data !== 'boolean') {
    errors.push(`Expected a boolean, got ${typeof data}`)
  }

  return errors
}

// ── Retry-with-Repair Loop ──

/**
 * Attempt to get structured JSON output from a local LLM with automatic repair.
 *
 * @param rawText - The initial model response text
 * @param schema - Expected JSON schema
 * @param repairFn - Callback to send repair prompts to the model
 * @param maxRetries - Maximum number of repair attempts (default: 2)
 */
export async function retryWithRepair<T = unknown>(
  rawText: string,
  schema: JsonSchema,
  repairFn: RepairCallback,
  maxRetries = 2
): Promise<RepairResult<T>> {
  let currentText = rawText
  let repairAttempts = 0
  let lastErrors: string[] = []

  // First attempt — extract and validate
  const firstResult = extractJson(currentText)
  if (firstResult.json !== null) {
    const errors = validateAgainstSchema(firstResult.json, schema)
    if (errors.length === 0) {
      return {
        data: firstResult.json as T,
        validOnFirstAttempt: true,
        repairAttempts: 0,
        rawText: currentText,
        lastErrors: []
      }
    }
    lastErrors = errors
  } else {
    lastErrors = [firstResult.error ?? 'Failed to extract JSON']
  }

  // Repair loop
  while (repairAttempts < maxRetries) {
    repairAttempts++
    repairLog.info(
      `[repair] Attempt ${repairAttempts}/${maxRetries} — errors: ${lastErrors.join('; ')}`
    )

    const repairPrompt = buildRepairPrompt(currentText, schema, lastErrors)

    try {
      currentText = await repairFn(repairPrompt)
    } catch (err) {
      repairLog.warn(`[repair] Repair callback failed: ${(err as Error).message}`)
      continue
    }

    const repairResult = extractJson(currentText)
    if (repairResult.json !== null) {
      const errors = validateAgainstSchema(repairResult.json, schema)
      if (errors.length === 0) {
        repairLog.info(`[repair] Successfully repaired on attempt ${repairAttempts}`)
        return {
          data: repairResult.json as T,
          validOnFirstAttempt: false,
          repairAttempts,
          rawText: currentText,
          lastErrors: []
        }
      }
      lastErrors = errors
    } else {
      lastErrors = [repairResult.error ?? 'Failed to extract JSON']
    }
  }

  // All retries exhausted — return best-effort parse
  repairLog.warn(`[repair] All ${maxRetries} repair attempts exhausted`)
  const finalResult = extractJson(currentText)
  return {
    data: (finalResult.json as T) ?? null,
    validOnFirstAttempt: false,
    repairAttempts,
    rawText: currentText,
    lastErrors
  }
}

/**
 * Build a repair prompt that includes the original output, errors, and expected schema.
 */
function buildRepairPrompt(brokenOutput: string, schema: JsonSchema, errors: string[]): string {
  const schemaDescription = formatSchemaForPrompt(schema)

  return [
    'Your previous response contained invalid JSON. Please fix it.',
    '',
    '## Expected Format',
    schemaDescription,
    '',
    '## Errors Found',
    errors.map((e) => `- ${e}`).join('\n'),
    '',
    '## Your Previous Output (first 2000 chars)',
    brokenOutput.slice(0, 2000),
    '',
    '## Instructions',
    'Respond with ONLY the corrected JSON — no markdown fences, no explanation.',
    'Ensure all required fields are present and types are correct.'
  ].join('\n')
}

/**
 * Format a JSON schema into a human-readable description for repair prompts.
 */
function formatSchemaForPrompt(schema: JsonSchema, indent = 0): string {
  const pad = '  '.repeat(indent)

  if (schema.type === 'object' && schema.properties) {
    const fields = Object.entries(schema.properties).map(([key, prop]) => {
      const required = schema.required?.includes(key) ? ' (required)' : ''
      const desc = prop.description ? ` — ${prop.description}` : ''
      const typeStr =
        prop.type === 'object' || prop.type === 'array'
          ? `\n${formatSchemaForPrompt(prop, indent + 1)}`
          : ''
      return `${pad}  "${key}": ${prop.type}${required}${desc}${typeStr}`
    })
    return `${pad}{\n${fields.join(',\n')}\n${pad}}`
  }

  if (schema.type === 'array' && schema.items) {
    return `${pad}[${formatSchemaForPrompt(schema.items, indent + 1)}]`
  }

  return `${pad}${schema.type}`
}
