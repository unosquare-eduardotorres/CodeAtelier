/**
 * Audit Prompt Templates — stack-adaptive prompts for each workspace health auditor.
 *
 * Each auditor gets a rendered system prompt built from:
 *   - The base template (shared structure)
 *   - Per-auditor domain instructions
 *   - Workspace context (name, detected techs, CLAUDE.md excerpt)
 *   - Scoring focus from AUDIT_TRACKS
 *   - Optional skills content (Deep mode only)
 *
 * W3-F11/F12: Unified templates — verbose full variants removed. The lean template
 * preserves all critical format rules while saving ~400 tokens/audit for Haiku.
 * FQ MCP tool names removed from domain prompts (already in tool schemas).
 */

import type { AuditTrackId } from '../../shared/types'
import { AUDIT_TRACKS } from '../../shared/constants'

// ── Base Template ──────────────────────────────────────────────────────────

/**
 * W3-F12: Unified audit template for all models.
 * The verbose 97-line full template was counterproductive for Haiku (smallest context).
 * Lean template preserves all critical format rules and behavioral constraints.
 */
const AUDIT_SYSTEM_PROMPT_TEMPLATE = `You are the **{{auditorName}}** — a senior specialist performing a read-only workspace health audit.

Respond ONLY in English. Inspect ONLY files within the workspace directory.

## Focus
{{description}}

## Workspace
- **Name**: {{workspaceName}}
- **Stack**: {{stackSummary}}

{{skills}}

## Scoring Criteria
Evaluate EVERY criterion below. Each must produce at least one audit-finding block:
{{scoringFocus}}

## Instructions
Narrate before each tool call. Use structured tools (Code Graph, Code Analysis) FIRST — see tool guidance. Focus on {{domain}}-related patterns only. Be concrete with file paths and line numbers. Limit to 10–15 findings.

## Finding Output (MANDATORY)
Emit findings as \`\`\`audit-finding JSON blocks in your response text (NOT tool calls):
{"severity": "high|medium|low|info|critical", "title": "...", "description": "...", "filePath": "...", "recommendation": "..."}

Passing criteria → "info" severity. Zero findings = unacceptable. Emit AS YOU GO.

## Final Score (MANDATORY)
End with exactly one \`\`\`audit-score block: {"score": N, "summary": "..."}
Guide: 0-20 critical, 21-40 significant, 41-60 moderate, 61-80 good, 81-100 excellent.
Read files before scoring. Always emit audit-score, even if out of tool calls.

## Tool Budget
~15-20 calls. 8-12 investigating, emit findings as you go. 10+ tools without findings → STOP and emit.`

// ── Per-auditor domain prompts ─────────────────────────────────────────────

/**
 * W3-F11: Unified domain prompts for all models.
 * FQ MCP tool names removed — already present in tool schemas.
 */
const AUDITOR_DOMAIN_PROMPTS: Record<AuditTrackId, string> = {
  code: `You audit code quality across frontend and backend: SOLID adherence, naming conventions, cyclomatic complexity, error handling, dead code, duplication, and type safety. Look for code smells, overly complex functions, and inconsistent patterns.`,

  testing: `You audit testing strategy: test pyramid balance, critical path coverage, fixture quality, assertion specificity, and CI/CD integration. Look for untested critical paths, brittle tests, and excessive mocking.`,

  architecture: `You audit software architecture: module boundaries and coupling, dependency direction, separation of concerns, API/IPC contract design, and scalability. Look for god modules, tight coupling, leaky abstractions, and circular dependencies.`,

  security: `You audit security posture: input validation, auth patterns, secret management, context isolation (especially Electron), and dependency vulnerabilities. Look for injection risks, exposed secrets, and insecure defaults.`,

  database: `You audit database layers: schema design, migration safety, query patterns, indexing, and data integrity. Look for N+1 queries, missing indexes, and unsafe migrations.`,

  documentation: `You audit documentation: README completeness, inline docs (JSDoc/TSDoc), API docs, CLAUDE.md quality, and decision records. Look for undocumented APIs and stale docs.`,

  'ui-ux': `You audit UI/UX: accessibility (WCAG), error/empty states, loading indicators, component consistency, and keyboard navigation.`
}

// ── Renderer ────────────────────────────────────────────────────────────────

/** Round context for multi-round audit sessions. */
export interface RoundContext {
  roundNumber: number
  fileBatch: string[]
  previousFindingsSummary: string
  remainingFileCount: number
}

export interface AuditPromptParams {
  trackId: AuditTrackId
  workspaceName: string
  detectedTechs: string[]
  skillContent?: string // Deep mode only — injected skill text
  roundContext?: RoundContext // Multi-round: scope to specific files
  model?: string // Model ID — kept for interface compat but no longer used for verbosity gating
}

/**
 * Render a fully-assembled audit system prompt for a given auditor track.
 * When `roundContext` is provided, appends scoped-inspection instructions
 * to limit the auditor to a specific file batch and avoid duplicate findings.
 */
export function renderAuditPrompt(params: AuditPromptParams): string {
  const track = AUDIT_TRACKS[params.trackId]
  // W3-F11/F12: Unified template and domain prompts for all models
  const domainPrompt = AUDITOR_DOMAIN_PROMPTS[params.trackId]
  const template = AUDIT_SYSTEM_PROMPT_TEMPLATE

  const stackSummary =
    params.detectedTechs.length > 0
      ? params.detectedTechs.join(', ')
      : 'Not detected — inspect project files to determine the stack'

  const scoringFocusText = track.scoringFocus.map((f, i) => `${i + 1}. ${f}`).join('\n')

  const skillsSection = params.skillContent ? `## Reference Skills\n${params.skillContent}` : ''

  let prompt = template
    .replace('{{auditorName}}', `${track.name} Auditor`)
    .replace('{{description}}', domainPrompt)
    .replace('{{workspaceName}}', params.workspaceName)
    .replace('{{stackSummary}}', stackSummary)
    .replace('{{skills}}', skillsSection)
    .replace('{{scoringFocus}}', scoringFocusText)
    .replace('{{domain}}', track.name.toLowerCase())

  // Append round context for multi-round sessions
  if (params.roundContext) {
    const rc = params.roundContext
    prompt +=
      `\n\n## Round ${rc.roundNumber} — Scoped Inspection\n\n` +
      `Focus on these ${rc.fileBatch.length} files:\n` +
      rc.fileBatch.map((f) => `- \`${f}\``).join('\n') +
      `\n\nPrevious rounds found ${rc.previousFindingsSummary}.\n` +
      `Do NOT repeat those findings. Focus on NEW issues in the files listed above.\n` +
      `${rc.remainingFileCount} files remain after this round.`
  }

  return prompt
}
