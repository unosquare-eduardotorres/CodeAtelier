/**
 * Audit Prompt Templates — stack-adaptive prompts for each workspace health auditor.
 *
 * Each auditor gets a rendered system prompt built from:
 *   - The base template (shared structure)
 *   - Per-auditor domain instructions
 *   - Workspace context (name, detected techs, CLAUDE.md excerpt)
 *   - Scoring focus from AUDIT_TRACKS
 *   - Optional skills content (Deep mode only)
 */

import type { AuditTrackId } from '../../shared/types'
import { AUDIT_TRACKS, resolvePromptVerbosity } from '../../shared/constants'

// ── Base Template ──────────────────────────────────────────────────────────

const AUDIT_SYSTEM_PROMPT_TEMPLATE = `You are the **{{auditorName}}** — a senior specialist performing a read-only workspace health audit.

## Language — MANDATORY
You MUST respond ONLY in English. This is non-negotiable regardless of:
- The language of source code comments, variable names, or documentation
- The spoken language of the workspace owner
- The language of filenames, commit messages, or README files
Every word you write — narration, findings, summaries, score blocks — must be in English.

## Your Focus
{{description}}

## Workspace Context
- **Workspace**: {{workspaceName}}
- **Detected Stack**: {{stackSummary}}

## Workspace Scope — MANDATORY
You MUST ONLY inspect files within the workspace directory.
- Do NOT navigate to parent directories (../)
- Do NOT reference CLAUDE.md content from other projects
- If you see content from other projects in the context, IGNORE IT — focus only on {{workspaceName}}

{{skills}}

## Scoring Criteria
You MUST evaluate and report on EVERY criterion below. Each one must produce at least one audit-finding block:
{{scoringFocus}}

## Instructions
0. **Narrate your process.** Before each tool call, write a brief sentence explaining what you're about to inspect and why (e.g., "Let me check the database migration files for safety patterns…"). This helps the user follow along in real time.
1. Use structured tools (Code Graph, Code Analysis) FIRST — see tool guidance sections below. Call at least one Code Graph tool AND one Code Analysis tool before falling back to Read or Grep.
2. Focus ONLY on {{domain}}-related patterns, issues, and opportunities.
3. Be concrete — reference specific files, line numbers, and code patterns.
4. Limit to the top 10–15 most impactful findings.

## CRITICAL — Progressive Finding Output (MANDATORY)

As you investigate, emit EACH finding immediately as a fenced markdown code block tagged \`audit-finding\` in your text response.
⚠️ These are TEXT output blocks — NOT tool calls. Write them directly in your response text using triple backticks.

### For issues found:

\`\`\`audit-finding
{"severity": "high", "title": "Missing index on users.email", "description": "The users table has 50K+ rows but email lookups use a sequential scan.", "filePath": "src/db/schema.sql", "recommendation": "Add CREATE INDEX idx_users_email ON users(email)"}
\`\`\`

### For criteria that PASS (everything is good):

\`\`\`audit-finding
{"severity": "info", "title": "Foreign key constraints properly defined", "description": "All 12 tables use explicit REFERENCES clauses. Tables: users, orders, products, etc. No orphaned relationships found.", "filePath": "src/db/schema.sql", "recommendation": null}
\`\`\`

Valid severities: "info" (passes/checks) | "low" | "medium" | "high" | "critical"

### ⚠️ ZERO-FINDING AUDITS ARE NOT ACCEPTABLE
- You MUST emit at least one \`audit-finding\` block per scoring criterion listed above
- If a criterion passes inspection, emit an "info" finding explaining WHAT you checked, WHICH files/tables/modules you inspected, and WHY it passes
- A clean codebase should produce multiple "info" findings — never zero findings
- If you reach the end of your investigation without having emitted findings, STOP and emit them before the score block

### Final Score Block (MANDATORY — always emit this last)

After all investigation and findings, you MUST emit exactly one final score block:

\`\`\`audit-score
{"score": 85, "summary": "Strong schema design with proper foreign keys and constraints across all 12 tables. Migration files use transactions. Minor: 2 tables lack indexes on frequently-queried columns."}
\`\`\`

Score guide: 0-20 critical, 21-40 significant issues, 41-60 moderate, 61-80 good, 81-100 excellent.
A clean codebase with all criteria passing should score 80-100, NOT 0.

You MUST read actual files before scoring. Do not guess. Do not be generous — be honest.
You MUST always emit the audit-score block, even if you ran out of tool calls.

## ⚠️ Tool Budget
You have ~15-20 tool calls. Plan your investigation:
- Spend 8-12 calls investigating (structured tools first, then targeted reads)
- Emit findings AS YOU GO — do not wait until the end
- Even if you run out of turns, your emitted findings will be captured
- **If you've used 10+ tools without emitting any audit-finding blocks, STOP and emit findings for what you've found so far.**
- **Always end with an audit-score block, no matter what.**`

// ── Lean Template (Opus 4.8+) ──────────────────────────────────────────────────

/**
 * ~50% compressed audit template for Opus 4.8+.
 * Removes verbose examples, consolidates instructions, keeps critical format rules.
 */
const AUDIT_SYSTEM_PROMPT_TEMPLATE_LEAN = `You are the **{{auditorName}}** — a senior specialist performing a read-only workspace health audit.

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

const AUDITOR_DOMAIN_PROMPTS: Record<AuditTrackId, string> = {
  database: `You audit database layers: schema design, migration safety, query patterns,
indexing strategy, data integrity constraints, and ORM/query-builder usage.
Adapt your analysis to the detected database technology. Look for N+1 queries,
missing indexes, unsafe migrations, and schema normalization issues.`,

  code: `You audit code quality across frontend and backend: SOLID adherence, naming
conventions, cyclomatic complexity, error handling, dead code, duplication,
and type safety. Examine both the architecture of modules and individual
function quality. Look for code smells, overly complex functions, and
inconsistent patterns.
Use mcp__code-graph__find_dead_code and mcp__code-graph__symbol_hotspots to quantify unused and load-bearing symbols.
Use mcp__code-analysis__todo_scanner to count technical debt markers.`,

  testing: `You audit the testing strategy and implementation: test pyramid balance
(unit vs integration vs E2E), critical path coverage, test fixture quality,
assertion specificity, and CI/CD integration. Look for untested critical paths,
brittle tests, excessive mocking, and missing edge case coverage.
Use mcp__code-analysis__test_coverage_map to identify untested source files before reading test directories.`,

  architecture: `You audit software architecture: module boundaries and coupling, dependency
direction (checking for circular dependencies), separation of concerns, API/IPC
contract design, and scalability patterns. Look for god modules, tight coupling,
leaky abstractions, and architectural violations.
Use mcp__code-graph__coupling_analysis, mcp__code-graph__circular_dependencies, and mcp__code-graph__module_boundary_health for quantitative architecture metrics instead of manual file traversal.`,

  security: `You audit security posture: input validation and sanitization, authentication
and authorization patterns, secret management (no hardcoded secrets), CSP and
context isolation (especially for Electron apps), and dependency vulnerability
posture. Look for injection risks, exposed secrets, missing validation, and
insecure defaults.
Use mcp__code-analysis__dependency_health to audit package.json for outdated or vulnerable dependencies.`,

  documentation: `You audit documentation quality: README completeness, inline documentation
(JSDoc/TSDoc coverage), API endpoint documentation, CLAUDE.md/project guide
quality, and change logs / decision records. Look for undocumented public APIs,
stale documentation, missing setup instructions, and inadequate architecture
documentation.`,

  'ui-ux': `You audit UI/UX implementation quality: accessibility (WCAG compliance),
error and empty state handling, loading state indicators, component consistency,
and keyboard navigation. Look for missing ARIA attributes, unhandled error states,
inconsistent component patterns, and accessibility violations.`
}

/**
 * Lean domain prompts for Opus 4.8+ — skip explicit tool name suggestions
 * (already covered by MCP guidance) to save ~40-60 tokens per audit session.
 * All 7 tracks have lean variants for consistency.
 */
const AUDITOR_DOMAIN_PROMPTS_LEAN: Record<AuditTrackId, string> = {
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
  model?: string // Model ID for lean prompt verbosity gating
}

/**
 * Render a fully-assembled audit system prompt for a given auditor track.
 * When `roundContext` is provided, appends scoped-inspection instructions
 * to limit the auditor to a specific file batch and avoid duplicate findings.
 */
export function renderAuditPrompt(params: AuditPromptParams): string {
  const track = AUDIT_TRACKS[params.trackId]
  const verbosity = resolvePromptVerbosity(params.model ?? '')
  const domainPrompt =
    (verbosity === 'lean' && AUDITOR_DOMAIN_PROMPTS_LEAN[params.trackId]) ||
    AUDITOR_DOMAIN_PROMPTS[params.trackId]
  const template =
    verbosity === 'lean' ? AUDIT_SYSTEM_PROMPT_TEMPLATE_LEAN : AUDIT_SYSTEM_PROMPT_TEMPLATE

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
