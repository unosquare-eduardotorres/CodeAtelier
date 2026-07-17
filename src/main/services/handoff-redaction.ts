/**
 * handoff-redaction — Three-tier redaction pipeline applied to HandoffEnvelope
 * before persisting or transmitting.
 *
 * 1. redactSecrets   — API keys, tokens, credentials
 * 2. redactPII       — Email addresses, phone numbers
 * 3. normalizePaths  — Absolute paths → workspace-relative
 */

import type { HandoffEnvelope } from '../../shared/handoff-types'
import log from 'electron-log'

const redactionLog = log.scope('handoff-redaction')

// ── Patterns ─────────────────────────────────────────────────────────

/** API key patterns — precise enough to avoid false positives like `sk_color` */
const SECRET_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  { name: 'anthropic-key', regex: /sk-ant-[a-zA-Z0-9_-]{20,}/g, replacement: '[REDACTED:anthropic-key]' },
  { name: 'openai-key', regex: /sk-[a-zA-Z0-9]{20,}/g, replacement: '[REDACTED:openai-key]' },
  { name: 'github-token', regex: /ghp_[a-zA-Z0-9]{36,}/g, replacement: '[REDACTED:github-token]' },
  { name: 'github-token-fine', regex: /github_pat_[a-zA-Z0-9_]{22,}/g, replacement: '[REDACTED:github-pat]' },
  { name: 'bearer-token', regex: /Bearer\s+[a-zA-Z0-9._\-/+=]{20,}/g, replacement: 'Bearer [REDACTED]' },
  { name: 'env-api-key', regex: /(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|API_KEY)\s*=\s*["']?[^\s"']+/g, replacement: '[REDACTED:env-key]' },
]

/** PII patterns */
const PII_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  { name: 'email', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[REDACTED:email]' },
  { name: 'phone', regex: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, replacement: '[REDACTED:phone]' },
]

/** Absolute path pattern — /Users/*, /home/*, C:\Users\* */
const ABS_PATH_RE = /(?:\/(?:Users|home)\/[^\s/]+|[A-Z]:\\Users\\[^\s\\]+)/g

// ── Redaction Functions ──────────────────────────────────────────────

function redactString(input: string, patterns: Array<{ name: string; regex: RegExp; replacement: string }>): { output: string; redactedCount: number } {
  let output = input
  let redactedCount = 0
  for (const { regex, replacement } of patterns) {
    // Reset regex lastIndex for global patterns
    regex.lastIndex = 0
    const matches = output.match(regex)
    if (matches) {
      redactedCount += matches.length
      output = output.replace(regex, replacement)
    }
  }
  return { output, redactedCount }
}

function redactSecrets(text: string): string {
  const { output, redactedCount } = redactString(text, SECRET_PATTERNS)
  if (redactedCount > 0) {
    redactionLog.info(`[redact] Removed ${redactedCount} secret(s)`)
  }
  return output
}

function redactPII(text: string): string {
  const { output, redactedCount } = redactString(text, PII_PATTERNS)
  if (redactedCount > 0) {
    redactionLog.info(`[redact] Removed ${redactedCount} PII item(s)`)
  }
  return output
}

function normalizePaths(text: string): string {
  return text.replace(ABS_PATH_RE, (match) => {
    // Replace /Users/username or /home/username with ~
    return match.replace(/^(?:\/(?:Users|home)\/[^/]+|[A-Z]:\\Users\\[^\\]+)/, '~')
  })
}

// ── Envelope-Level Redaction ─────────────────────────────────────────

function redactTextField(text: string): string {
  let result = text
  result = redactSecrets(result)
  result = redactPII(result)
  result = normalizePaths(result)
  return result
}

/**
 * Apply the full redaction pipeline to a HandoffEnvelope.
 * Returns a new envelope with sensitive data removed.
 *
 * Redaction replaces (not deletes) so context is preserved:
 *   sk-ant-abc123...xyz → [REDACTED:anthropic-key]
 *   /Users/john/project → ~/project
 */
export function redactEnvelope(envelope: HandoffEnvelope): HandoffEnvelope {
  return {
    ...envelope,

    // Text fields
    intent: redactTextField(envelope.intent),
    originalGoal: redactTextField(envelope.originalGoal),
    contextSummary: redactTextField(envelope.contextSummary),

    // Array fields
    constraints: envelope.constraints.map(redactTextField),

    completedWork: envelope.completedWork.map((step) => ({
      ...step,
      title: redactTextField(step.title),
      outcome: redactTextField(step.outcome),
      filesModified: step.filesModified?.map(normalizePaths),
    })),

    remainingWork: envelope.remainingWork.map((step) => ({
      ...step,
      title: redactTextField(step.title),
      description: redactTextField(step.description),
    })),

    decisions: envelope.decisions.map((d) => ({
      ...d,
      what: redactTextField(d.what),
      why: redactTextField(d.why),
      alternatives: d.alternatives?.map(redactTextField),
    })),

    risks: envelope.risks.map((r) => ({
      ...r,
      risk: redactTextField(r.risk),
      mitigation: r.mitigation ? redactTextField(r.mitigation) : undefined,
    })),

    artifacts: envelope.artifacts.map((a) => ({
      ...a,
      path: normalizePaths(a.path),
      description: redactTextField(a.description),
    })),

    codeAnchors: envelope.codeAnchors?.map((anchor) => ({
      ...anchor,
      file: normalizePaths(anchor.file),
      title: redactTextField(anchor.title),
    })),

    filesToReadFirst: envelope.filesToReadFirst.map(normalizePaths),
    commandsToRunFirst: envelope.commandsToRunFirst.map(redactTextField),

    // Suggested tools & skills
    suggestedTools: envelope.suggestedTools.map(redactTextField),
    suggestedSkills: envelope.suggestedSkills.map(redactTextField),

    // Extensions — deep-redact string values
    extensions: envelope.extensions
      ? redactExtensions(envelope.extensions) as Record<string, unknown>
      : undefined,
  }
}

function redactExtensions(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactTextField(value)
  }
  if (Array.isArray(value)) {
    return value.map(redactExtensions)
  }
  if (value !== null && typeof value === 'object') {
    const redacted: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      redacted[key] = redactExtensions(v)
    }
    return redacted
  }
  return value // numbers, booleans, null
}
