/**
 * Blueprint Prompt Loader — reads .md prompt/template files and injects context variables.
 *
 * Each Blueprint phase has:
 *  - A system prompt file (`prompts/<phase>-phase.md`)
 *  - An optional template file (`templates/<templateName>.md`)
 *  - Optional agent enhancement files (`agents/<role>-enhancement.md`)
 *
 * The loader reads these files, replaces {{VARIABLE}} placeholders with actual content,
 * and assembles the full system prompt for the agent session.
 */

import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import log from 'electron-log'
import { resolveContextTier } from './context-management'
import type { ContextWindowTier } from './context-management'
import type {
  BlueprintPhaseType,
  PhaseContext,
  BlueprintArtifact,
  BlueprintRevisionRequest
} from '../../shared/blueprint-types'

const promptLog = log.scope('blueprint-prompt-loader')

// ── Path Resolution ──

/** Root of the blueprints directory (relative to compiled output). */
function getBlueprintsDir(): string {
  // In dev: src/main/blueprints/
  // In prod: out/main/blueprints/ (copied by Vite)
  const candidates = [
    join(__dirname, '..', 'blueprints'), // out/main/blueprints (prod)
    join(__dirname, 'blueprints'), // alternate structure
    join(__dirname, '..', '..', 'src', 'main', 'blueprints') // dev fallback
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  // Default — will error on read if not found
  return join(__dirname, '..', 'blueprints')
}

/** Read a file from the blueprints directory. Returns empty string if not found. */
function readBlueprintFile(relativePath: string): string {
  const fullPath = join(getBlueprintsDir(), relativePath)
  try {
    return readFileSync(fullPath, 'utf-8')
  } catch (err) {
    promptLog.warn(`Blueprint file not found: ${relativePath}`, err)
    return ''
  }
}

// ── Phase → Prompt/Template Mapping ──

const PHASE_PROMPT_FILES: Record<BlueprintPhaseType, string> = {
  specify: 'prompts/specify-phase.md',
  clarify: 'prompts/clarify-phase.md',
  plan: 'prompts/plan-phase.md',
  tasks: 'prompts/tasks-phase.md',
  review: 'prompts/review-phase.md',
  build: 'prompts/build-phase.md',
  'code-review': 'prompts/code-review-phase.md',
  verify: 'prompts/verify-phase.md'
}

/** Templates are optional per-phase — some phases don't have output templates. */
const PHASE_TEMPLATE_FILES: Partial<Record<BlueprintPhaseType, string>> = {
  specify: 'templates/spec.md',
  plan: 'templates/plan.md',
  tasks: 'templates/tasks.md'
}

/** Agent enhancement files (injected into BUILD/VERIFY phases). */
const AGENT_ENHANCEMENT_FILES: Partial<Record<BlueprintPhaseType, string>> = {
  plan: 'agents/planner-enhancement.md',
  build: 'agents/executor-enhancement.md',
  verify: 'agents/verifier-enhancement.md'
}

// ── Artifact Formatting ──

// Fields to keep when projecting plan JSON (drops verbose description prose)
const PLAN_PROJECTION_KEYS = new Set([
  'summary',
  'techStack',
  'mustHaves',
  'existingPatterns',
  'keyLinks',
  'phases',
  'items',
  'id',
  'title',
  'name',
  'files',
  'scope'
])

/**
 * Fields kept when projecting tasks JSON.
 *
 * MUST mirror the shape TASKS actually emits (tasks-phase.md:145):
 *   {totalTasks, waves: [{wave, name, tasks: [...]}], userStoryPhases, mvpScope}
 * The previous set listed only per-task leaf keys, so projectFields matched NO
 * top-level key and returned `{}` — REVIEW was asked for a task-coverage matrix
 * (review-phase.md:121) while receiving an empty object.
 *
 * `packet` is excluded deliberately: it is BUILD's execution contract
 * (interfaces, allowedFiles, conventions, testCommand), it is the bulk of the
 * JSON by size, and BUILD receives it per task from the DB. Same for the
 * scheduler hints `isParallel` / `includesTests` / `parallelOpportunities`.
 */
const TASKS_PROJECTION_KEYS = new Set([
  // containers
  'totalTasks',
  'waves',
  'wave',
  'name',
  'tasks',
  'userStoryPhases',
  'story',
  'priority',
  'taskIds',
  'mvpScope',
  // per task — what REVIEW judges coverage with
  'taskId',
  'description',
  'files',
  'userStory',
  'dependsOn',
  // pre-existing keys, kept for older artifacts
  'id',
  'title',
  'scope',
  'status',
  'filePathsJson'
])

/**
 * Cap on tasks rendered inside the projected tasks JSON.
 *
 * formatArtifacts Stage 4 truncates whole artifacts from the tail and `tasks`
 * renders last, so an oversized list is dropped in its entirety rather than
 * trimmed. Keeping the head of the list is strictly better than losing all of
 * it.
 *
 * Measured, at ~250 rendered chars per task: 40 tasks ≈ 10.0K chars, 60 ≈ 14.9K,
 * 120 ≈ 29.7K. So this cap is what keeps the artifact inside the MEDIUM (50K)
 * and LARGE (100K) tier budgets. It does NOT rescue the small tier — 25K is
 * already exceeded at the cap itself, so a 100+ task blueprint on a small-window
 * model still loses the whole block to Stage 4. That is not a regression (the
 * artifact rendered as `{}` before this projection was fixed at all) and the
 * agent at least gets a truncation marker naming the file, but if small-tier
 * REVIEW coverage matters later, the fix is a tier-aware cap here, not a
 * larger budget.
 */
const MAX_TASKS_RENDERED = 120

/** Per-phase char budget for the formatted artifacts block. */
export const ARTIFACT_BUDGET_CHARS = 50_000

/**
 * Tier-scaled artifact budgets (chars) for the formatted artifacts block.
 *
 * A 32K local model and a 1M-context Claude used to get the identical 50K
 * budget — half the small model's window, a rounding error for the large one.
 * `medium` matches the historical static values so existing behavior is the
 * midpoint, not a cliff.
 */
export const ARTIFACT_BUDGETS_BY_TIER: Record<ContextWindowTier, number> = {
  small: 25_000,
  medium: 50_000, // = ARTIFACT_BUDGET_CHARS (today's static value)
  large: 100_000
}

/** Resolve the artifacts-block char budget for a context window (in tokens). */
export function artifactBudgetForTier(contextWindowTokens: number): number {
  return ARTIFACT_BUDGETS_BY_TIER[resolveContextTier(contextWindowTokens)]
}

/** Max number of consolidated discovery entries before truncation. */
const MAX_DISCOVERY_ENTRIES = 30

// ── Blueprint context JSON projection (E7) ──

/**
 * E7 — keys of `blueprint.settings` that may be serialised into
 * {{BLUEPRINT_CONTEXT_JSON}}.
 *
 * `settingsJson` is a free-form bag, and it accumulated two LEDGERS:
 * `grillDecisions` and `revisionRequests`. Both already have purpose-built
 * formatters ({{GRILL_DECISIONS}}, {{REVISION_FEEDBACK}}) that render them with
 * the framing the agent needs — so the raw JSON copy was the same content a
 * second time, at full pretty-printed width, in a block the agent is told to
 * treat as metadata. Grill decisions reached the specify prompt a THIRD time
 * via blueprint-specify.adapter.ts.
 *
 * A whitelist rather than a denylist: this block sits in the task-invariant
 * prefix of every phase, so an unrecognised future setting must stay OUT by
 * default and be added here deliberately. If you add a setting the AGENT needs
 * to reason about, add it here; if a formatter already renders it, do not.
 */
const BLUEPRINT_SETTINGS_PROMPT_KEYS = new Set([
  'branchName',
  'branchChoice',
  'jiraIssueKey',
  'jiraIssueKeys'
])

/**
 * Settings deliberately kept out of the prompt — pipeline bookkeeping, or
 * ledgers with their own formatter. Listed only so the drop-diagnostic below
 * stays quiet about them and loud about everything else.
 */
const KNOWN_NON_PROMPT_SETTINGS = new Set([
  'grillDecisions', // rendered by {{GRILL_DECISIONS}}
  'revisionRequests', // rendered by {{REVISION_FEEDBACK}}
  'baselineCommit',
  'referenceDocuments'
])

/**
 * Project the blueprint header down to what belongs in the prompt.
 * Returns the header unchanged when it carries no settings.
 */
export function projectBlueprintForPrompt(
  blueprint: PhaseContext['blueprint']
): PhaseContext['blueprint'] {
  const settings = blueprint.settings
  if (!settings || typeof settings !== 'object') return blueprint

  const projected: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const key of Object.keys(settings)) {
    if (BLUEPRINT_SETTINGS_PROMPT_KEYS.has(key)) projected[key] = settings[key]
    else if (!KNOWN_NON_PROMPT_SETTINGS.has(key)) dropped.push(key)
  }
  // A whitelist fails SILENTLY by design, which is the right default and the
  // wrong debugging experience: a future settingsJson.targetBranch would simply
  // never reach the agent, with nothing anywhere saying so. Name the keys that
  // are neither whitelisted nor knowingly excluded.
  if (dropped.length > 0) {
    promptLog.debug(
      `[projectBlueprintForPrompt] settings not in the prompt whitelist, dropped: ${dropped.join(', ')} ` +
        `— add to BLUEPRINT_SETTINGS_PROMPT_KEYS if the agent must reason about them`
    )
  }
  return { ...blueprint, settings: projected }
}

// ── Constitution cap (E7) ──

/**
 * Tier-scaled cap for {{CONSTITUTION_CONTENT}}.
 *
 * The constitution was the last uncapped block in the prefix: it is injected
 * into every phase, is fully task-invariant, and is authored by hand — nothing
 * bounded its growth. Caps are generous because a constitution the agent must
 * obey is the worst thing to truncate; the point is a ceiling, not compression.
 */
export const CONSTITUTION_CAPS_BY_TIER: Record<ContextWindowTier, number> = {
  small: 8_000,
  medium: 20_000,
  large: 40_000
}

/** Cap the constitution for a tier, appending a marker when it was cut. */
export function capConstitution(
  constitution: string,
  tier: ContextWindowTier = 'medium'
): string {
  const cap = CONSTITUTION_CAPS_BY_TIER[tier]
  if (constitution.length <= cap) return constitution
  return (
    constitution.slice(0, cap) +
    `\n\n[… constitution truncated at ${cap.toLocaleString()} chars — ` +
    `the remainder is in the workspace constitution, use Read if you need it]`
  )
}

/**
 * Project only the allowed keys from an object (shallow, one level + recurse into arrays).
 * Returns a new object with only the allowed fields.
 */
function projectFields(
  obj: Record<string, unknown>,
  allowed: Set<string>
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(obj)) {
    if (allowed.has(key)) {
      const val = obj[key]
      // Recurse into arrays of objects (e.g. plan.items[], tasks[])
      if (Array.isArray(val)) {
        result[key] = val.map((item) =>
          typeof item === 'object' && item !== null && !Array.isArray(item)
            ? projectFields(item as Record<string, unknown>, allowed)
            : item
        )
      } else {
        result[key] = val
      }
    }
  }
  return result
}

/**
 * Format a list of artifacts into a markdown string for prompt injection.
 *
 * Design principles (context compaction):
 *   1. Prefer contentMd over contentJson — skip JSON dump when markdown exists
 *   2. Use compact JSON (no pretty-printing) for ~30-40% savings
 *   3. Project only needed fields for plan/tasks JSON
 *   4. Consolidate all discovery entries into one deduplicated list
 *   5. Enforce a char budget with graceful truncation
 */
export function formatArtifacts(
  artifacts: BlueprintArtifact[],
  budgetChars: number = ARTIFACT_BUDGET_CHARS
): string {
  if (!artifacts.length) return '(No previous artifacts available.)'

  // Stage 3: Consolidate all discovery entries into one merged block
  const nonDiscoveryArtifacts: BlueprintArtifact[] = []
  const allDiscoveryEntries: string[] = []

  for (const a of artifacts) {
    if (a.type === 'discoveries' && a.contentJson) {
      const { entries } = a.contentJson as { entries?: string[] }
      if (Array.isArray(entries)) {
        for (const e of entries) {
          if (!allDiscoveryEntries.includes(e)) {
            allDiscoveryEntries.push(e)
          }
        }
      }
    } else {
      nonDiscoveryArtifacts.push(a)
    }
  }

  // Render non-discovery artifacts
  const rendered: string[] = []
  for (const a of nonDiscoveryArtifacts) {
    rendered.push(renderSingleArtifact(a))
  }

  // Render consolidated discoveries block
  if (allDiscoveryEntries.length > 0) {
    const capped = allDiscoveryEntries.length > MAX_DISCOVERY_ENTRIES
    const entries = capped ? allDiscoveryEntries.slice(-MAX_DISCOVERY_ENTRIES) : allDiscoveryEntries
    const bullets = entries.map((e) => `- ${e}`).join('\n')
    const omitted = allDiscoveryEntries.length - entries.length
    const suffix = capped
      ? `\n\n_(${omitted} older discoveries omitted — use mcp__memory__memory_search to retrieve)_`
      : ''
    rendered.push(`### Discoveries (consolidated)\n${bullets}${suffix}`)
  }

  const filtered = rendered.filter((s) => s.length > 0)

  // Stage 4: Budget cap with graceful truncation
  let total = 0
  const budgeted: string[] = []
  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i]
    if (total + entry.length > budgetChars && budgeted.length > 0) {
      const remaining = filtered.length - i
      budgeted.push(
        `_(${remaining} artifact(s) truncated to stay within context budget — use Read on the file paths shown above for full content)_`
      )
      break
    }
    budgeted.push(entry)
    total += entry.length
  }

  return budgeted.join('\n\n---\n\n')
}

/**
 * Trim a projected tasks object to at most MAX_TASKS_RENDERED tasks, in wave
 * order. Returns the (possibly new) object and how many tasks were dropped.
 * Never mutates the input — the caller's artifact is shared with other phases.
 */
function capTaskList(json: Record<string, unknown>): {
  json: Record<string, unknown>
  omitted: number
} {
  const waves = Array.isArray(json.waves) ? (json.waves as Record<string, unknown>[]) : null
  const flat = Array.isArray(json.tasks) ? (json.tasks as unknown[]) : null

  const total =
    (waves?.reduce((n, w) => n + (Array.isArray(w?.tasks) ? w.tasks.length : 0), 0) ?? 0) +
    (flat?.length ?? 0)
  if (total <= MAX_TASKS_RENDERED) return { json, omitted: 0 }

  let budget = MAX_TASKS_RENDERED
  const out: Record<string, unknown> = { ...json }

  if (waves) {
    out.waves = waves.map((w) => {
      if (!Array.isArray(w?.tasks)) return w
      const keep = w.tasks.slice(0, Math.max(0, budget))
      budget -= keep.length
      return { ...w, tasks: keep }
    })
  }
  if (flat) {
    const keep = flat.slice(0, Math.max(0, budget))
    budget -= keep.length
    out.tasks = keep
  }

  return { json: out, omitted: total - MAX_TASKS_RENDERED }
}

/** Render a single non-discovery artifact to markdown. */
function renderSingleArtifact(a: BlueprintArtifact): string {
  const parts: string[] = [`### Artifact: ${a.type}`]
  if (a.filePath) parts.push(`**Path**: ${a.filePath}`)

  // For plan/tasks: prefer compact projected JSON when available.
  // The full verbose agent output is on disk at filePath — Read it for details.
  const preferCompactJson = (a.type === 'plan' || a.type === 'tasks') && a.contentJson

  if (preferCompactJson) {
    const { json, omitted } = projectArtifactJson(a.type, a.contentJson!)
    parts.push('```json\n' + JSON.stringify(json) + '\n```')
    // Marker sits OUTSIDE the fence so the JSON block stays parseable.
    if (omitted > 0) pushOmissionMarker(parts, omitted, a.filePath)
    if (a.filePath) {
      parts.push(`_(Full agent output available at ${a.filePath} — use Read for complete details)_`)
    }
  } else if (a.contentMd) {
    parts.push(a.contentMd)
  } else if (a.contentJson) {
    // Field projection for known large artifact types.
    // Compact JSON (no pretty-printing) for ~30-40% savings.
    const { json, omitted } = projectArtifactJson(a.type, a.contentJson)
    parts.push('```json\n' + JSON.stringify(json) + '\n```')
    if (omitted > 0) pushOmissionMarker(parts, omitted, a.filePath)
  }
  return parts.join('\n')
}

/** Project + cap an artifact's JSON for the known large artifact types. */
function projectArtifactJson(
  type: string,
  contentJson: Record<string, unknown>
): { json: Record<string, unknown>; omitted: number } {
  if (type === 'plan') return { json: projectFields(contentJson, PLAN_PROJECTION_KEYS), omitted: 0 }
  if (type === 'tasks') return capTaskList(projectFields(contentJson, TASKS_PROJECTION_KEYS))
  return { json: contentJson, omitted: 0 }
}

function pushOmissionMarker(parts: string[], omitted: number, filePath?: string): void {
  const total = omitted + MAX_TASKS_RENDERED
  const where = filePath ? ` — Read ${filePath} for the full list` : ''
  parts.push(`_(${omitted} of ${total} tasks omitted${where})_`)
}

// ── Main Prompt Builder ──

/**
 * Build the complete system prompt for a Blueprint phase.
 *
 * Reads the phase prompt file, injects context variables, and assembles
 * the full prompt including constitution, previous artifacts, and templates.
 */
export function buildPhaseSystemPrompt(phase: BlueprintPhaseType, context: PhaseContext): string {
  // 1. Load the phase prompt
  const promptFile = PHASE_PROMPT_FILES[phase]
  let prompt = readBlueprintFile(promptFile)

  if (!prompt) {
    promptLog.warn(`No prompt file found for phase: ${phase}, using minimal fallback`)
    prompt = buildFallbackPrompt(phase)
  }

  // 2. Load optional template
  const templateFile = PHASE_TEMPLATE_FILES[phase]
  const template = templateFile ? readBlueprintFile(templateFile) : ''

  // 3. Load optional agent enhancement
  const enhancementFile = AGENT_ENHANCEMENT_FILES[phase]
  const enhancement = enhancementFile ? readBlueprintFile(enhancementFile) : ''

  // 4. Replace context variables
  prompt = replaceVariables(prompt, context, template, enhancement)

  return prompt
}

/**
 * Build the system prompt for the post-verify lead-review pass (M6.1).
 *
 * The pass is not a pipeline phase (no BlueprintPhaseType, no phase record),
 * so it has no PHASE_PROMPT_FILES entry — this loader points at its dedicated
 * prompt file and reuses the same context-variable replacement as the phases.
 */
export function buildLeadReviewPassSystemPrompt(context: PhaseContext): string {
  let prompt = readBlueprintFile('prompts/lead-review-pass.md')
  if (!prompt) {
    promptLog.warn('No prompt file found for lead-review pass, using review fallback')
    prompt = readBlueprintFile('prompts/review-phase.md')
  }
  if (!prompt) {
    prompt = buildFallbackPrompt('review')
  }
  return replaceVariables(prompt, context, '', '')
}

/**
 * Build the system prompt for the per-task peer-review pass (M5).
 *
 * Like the lead-review pass, this is not a pipeline phase — the loader points
 * at its dedicated prompt file and reuses the phase context-variable
 * replacement.
 *
 * FOOTGUN: `context` here is a LITE context (assembleLitePhaseContext) —
 * previousArtifacts is always empty and workspaceDocs always absent, because
 * peer-review-pass.md interpolates NOTHING and the full assembly's disk mirror
 * races the wave-siblings still reading blueprints/<name>/*.md. If you add
 * {{PREVIOUS_PHASE_ARTIFACTS}} or {{WORKSPACE_DOCS}} to that file they will
 * render as their "nothing available" placeholders, not as content. Making them
 * real means changing the CALLER in blueprint-peer-review.service.ts — and
 * paying that race back.
 */
export function buildPeerReviewSystemPrompt(context: PhaseContext): string {
  let prompt = readBlueprintFile('prompts/peer-review-pass.md')
  if (!prompt) {
    promptLog.warn('No prompt file found for peer-review pass, using review fallback')
    prompt = readBlueprintFile('prompts/review-phase.md')
  }
  if (!prompt) {
    prompt = buildFallbackPrompt('review')
  }
  return replaceVariables(prompt, context, '', '')
}

/**
 * Build the system prompt for the Constitution editor.
 */
export function buildConstitutionEditorPrompt(
  existingConstitution: string | null,
  workspaceInfo: { name: string; path: string }
): string {
  let prompt = readBlueprintFile('prompts/constitution-editor.md')

  if (!prompt) {
    prompt = buildFallbackConstitutionPrompt()
  }

  prompt = prompt
    .replace('{{EXISTING_CONSTITUTION}}', existingConstitution || '(No existing constitution.)')
    .replace('{{WORKSPACE_NAME}}', workspaceInfo.name)
    .replace('{{WORKSPACE_PATH}}', workspaceInfo.path)

  return prompt
}

// ── Retry Context Formatter ──

function formatRetryContext(ctx: NonNullable<PhaseContext['retryContext']>): string {
  const lines = [
    `\n<retry_context>`,
    `## ⚠️ This is Retry Attempt #${ctx.attempt}`,
    '',
    `The previous attempt of this ${ctx.previousPhase} phase FAILED.`,
    `**Error:** ${ctx.previousError}`,
    ''
  ]

  if (ctx.filesModified.length > 0) {
    lines.push(`**Files modified before failure:** ${ctx.filesModified.join(', ')}`)
    lines.push(
      '⚠️ These files may be in an inconsistent state — re-read them before making further changes.'
    )
    lines.push('')
  }
  if (ctx.filesCreated.length > 0) {
    lines.push(`**Files created before failure:** ${ctx.filesCreated.join(', ')}`)
    lines.push('')
  }
  if (ctx.totalTasks > 0) {
    lines.push(
      `**Progress:** ${ctx.tasksCompleted}/${ctx.totalTasks} tasks completed before failure`
    )
    lines.push('')
  }

  lines.push(
    'The partial output from the previous attempt is included in <previous_artifacts>.',
    'Build on what was already accomplished — do NOT start from scratch.',
    'Re-read any modified files to verify their current state before continuing.',
    '</retry_context>'
  )

  return lines.join('\n')
}

// ── Revision Feedback Formatter ──

/**
 * Render the human's outstanding change requests.
 *
 * Deliberately separate from {{RETRY_CONTEXT}}: that block is failure-shaped
 * ("the previous attempt FAILED", "**Error:**"), and telling an agent its work
 * failed when a human simply wants it different produces apology and a rewrite
 * from scratch rather than a targeted edit. A change request is not an error.
 *
 * All rounds are shown, oldest first — the agent must not re-litigate a decision
 * that was settled two rounds ago just because the newest note did not repeat it.
 */
function formatRevisionFeedback(requests: BlueprintRevisionRequest[]): string {
  const lines = [
    `\n<revision_requests>`,
    `## ✍️ The human has requested changes (${requests.length} round${requests.length > 1 ? 's' : ''})`,
    '',
    'These are direct instructions from the person who owns this work. They are',
    'requirements, not suggestions, and they outrank your own earlier choices.',
    'Every round below still applies unless a later round contradicts it.',
    ''
  ]

  for (const r of requests) {
    lines.push(`### Round ${r.round} — on the ${r.phase} output (${r.at})`)
    lines.push(r.feedback)
    lines.push('')
  }

  lines.push(
    'Address every point above. If you believe a request is mistaken or infeasible,',
    'say so explicitly and explain why — do NOT silently ignore it or quietly do',
    'something else, which reads to the human as the feedback having been dropped.',
    '</revision_requests>'
  )

  return lines.join('\n')
}

// ── Variable Replacement ──

function replaceVariables(
  prompt: string,
  context: PhaseContext,
  template: string,
  enhancement: string
): string {
  return (
    prompt
      // Blueprint context JSON (injected as structured data).
      // E7: settings are whitelist-projected — the grill/revision LEDGERS are
      // rendered by their own formatters below and must not ride along here too.
      .replace(
        '{{BLUEPRINT_CONTEXT_JSON}}',
        JSON.stringify(projectBlueprintForPrompt(context.blueprint), null, 2)
      )
      // Constitution content — capped to the same tier as the artifacts block.
      .replace(
        '{{CONSTITUTION_CONTENT}}',
        context.constitution
          ? capConstitution(context.constitution, context.contextTier)
          : '(No constitution defined.)'
      )
      // Previous phase artifacts — budget scales with the phase model's context
      // tier when the assembler knew it, else the static default.
      .replace(
        '{{PREVIOUS_PHASE_ARTIFACTS}}',
        formatArtifacts(context.previousArtifacts, context.artifactBudgetChars)
      )
      // File paths
      .replace(/\{\{SPEC_FILE_PATH\}\}/g, context.specFilePath)
      .replace(/\{\{BLUEPRINT_DIR\}\}/g, context.blueprintDir)
      // Template injection
      .replace('{{TEMPLATE_CONTENT}}', template || '(No template available.)')
      // Agent enhancement injection
      .replace('{{AGENT_ENHANCEMENT}}', enhancement)
      // Grill decisions (if available)
      .replace(
        '{{GRILL_DECISIONS}}',
        context.grillDecisions?.length
          ? context.grillDecisions
              .map((d) => `- **${d.header}**: ${d.selectedOption}\n  _Reason_: ${d.reason}`)
              .join('\n')
          : '(No grill decisions available.)'
      )
      // Pre-loaded workspace documentation (CLAUDE.md, README.md, package.json, PLAN.md)
      .replace(
        '{{WORKSPACE_DOCS}}',
        context.workspaceDocs ||
          '(No workspace documentation found — use Read to check for CLAUDE.md, README.md, package.json)'
      )
      // Retry context (populated only on retry — guides the agent to build on prior work)
      .replace(
        '{{RETRY_CONTEXT}}',
        context.retryContext ? formatRetryContext(context.retryContext) : ''
      )
      // Human change requests — every round, on every re-run of the phase
      .replace(
        '{{REVISION_FEEDBACK}}',
        context.revisionRequests?.length ? formatRevisionFeedback(context.revisionRequests) : ''
      )
  )
}

// ── Fallback Prompts (used when .md files aren't found yet) ──

function buildFallbackPrompt(phase: BlueprintPhaseType): string {
  return `# ${phase.charAt(0).toUpperCase() + phase.slice(1)} Phase — System Prompt

**Role**: You are the ${phase} agent in the Blueprint pipeline.
**Phase**: ${phase}

## Blueprint Context

<blueprint_context>
{{BLUEPRINT_CONTEXT_JSON}}
</blueprint_context>

<constitution>
{{CONSTITUTION_CONTENT}}
</constitution>

<previous_artifacts>
{{PREVIOUS_PHASE_ARTIFACTS}}
</previous_artifacts>

{{RETRY_CONTEXT}}

## Instructions

Execute the ${phase} phase of the Blueprint pipeline. Review all provided context
and previous artifacts carefully before proceeding.

When complete, emit a completion block:

\`\`\`blueprint-phase-complete
{
  "phase": "${phase}",
  "status": "complete"
}
\`\`\`
`
}

function buildFallbackConstitutionPrompt(): string {
  return `# Constitution Editor — System Prompt

**Role**: You are the Constitution editor agent.

## Existing Constitution

<existing_constitution>
{{EXISTING_CONSTITUTION}}
</existing_constitution>

## Workspace

- **Name**: {{WORKSPACE_NAME}}
- **Path**: {{WORKSPACE_PATH}}

## Instructions

Help the user create or edit their project constitution. The constitution defines
the project's coding standards, architectural decisions, technology preferences,
and constraints that all Blueprint phases must respect.

Guide the user through defining:
1. Project overview and goals
2. Technology stack and versions
3. Coding standards and conventions
4. Architectural patterns and constraints
5. Testing requirements
6. Security requirements
7. Performance targets
`
}

// ── Utility: Check if prompts are available ──

export function arePromptsAvailable(): boolean {
  const dir = getBlueprintsDir()
  return existsSync(join(dir, 'prompts'))
}

/** List all available prompt files (for diagnostics). */
export function listAvailablePrompts(): string[] {
  const dir = getBlueprintsDir()
  const promptsDir = join(dir, 'prompts')
  if (!existsSync(promptsDir)) return []

  try {
    return readdirSync(promptsDir).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
}
