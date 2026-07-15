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
import type {
  BlueprintPhaseType,
  PhaseContext,
  BlueprintArtifact
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
  'summary', 'techStack', 'mustHaves', 'existingPatterns', 'keyLinks',
  'phases', 'items', 'id', 'title', 'name', 'files', 'scope'
])

// Fields to keep when projecting tasks JSON
const TASKS_PROJECTION_KEYS = new Set([
  'id', 'title', 'wave', 'files', 'scope', 'status', 'taskId',
  'userStory', 'filePathsJson', 'description'
])

/** Per-phase char budget for the formatted artifacts block. */
export const ARTIFACT_BUDGET_CHARS = 30_000

/** Max number of consolidated discovery entries before truncation. */
const MAX_DISCOVERY_ENTRIES = 30

/**
 * Project only the allowed keys from an object (shallow, one level + recurse into arrays).
 * Returns a new object with only the allowed fields.
 */
function projectFields(obj: Record<string, unknown>, allowed: Set<string>): Record<string, unknown> {
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
    const entries = capped
      ? allDiscoveryEntries.slice(-MAX_DISCOVERY_ENTRIES)
      : allDiscoveryEntries
    const bullets = entries.map((e) => `- ${e}`).join('\n')
    const omitted = allDiscoveryEntries.length - entries.length
    const suffix = capped
      ? `\n\n_(${omitted} older discoveries omitted — use memory_search to retrieve)_`
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
        `_(${remaining} artifact(s) truncated to stay within context budget — use Read or memory_search for full content)_`
      )
      break
    }
    budgeted.push(entry)
    total += entry.length
  }

  return budgeted.join('\n\n---\n\n')
}

/** Render a single non-discovery artifact to markdown. */
function renderSingleArtifact(a: BlueprintArtifact): string {
  const parts: string[] = [`### Artifact: ${a.type}`]
  if (a.filePath) parts.push(`**Path**: ${a.filePath}`)

  // Prefer contentMd — skip JSON dump when markdown summary exists
  if (a.contentMd) {
    parts.push(a.contentMd)
  } else if (a.contentJson) {
    // Field projection for known large artifact types
    let json = a.contentJson
    if (a.type === 'plan') {
      json = projectFields(json, PLAN_PROJECTION_KEYS)
    } else if (a.type === 'tasks') {
      json = projectFields(json, TASKS_PROJECTION_KEYS)
    }
    // Compact JSON (no pretty-printing) for ~30-40% savings
    parts.push('```json\n' + JSON.stringify(json) + '\n```')
  }
  return parts.join('\n')
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

// ── Variable Replacement ──

function replaceVariables(
  prompt: string,
  context: PhaseContext,
  template: string,
  enhancement: string
): string {
  return (
    prompt
      // Blueprint context JSON (injected as structured data)
      .replace('{{BLUEPRINT_CONTEXT_JSON}}', JSON.stringify(context.blueprint, null, 2))
      // Constitution content
      .replace('{{CONSTITUTION_CONTENT}}', context.constitution || '(No constitution defined.)')
      // Previous phase artifacts
      .replace('{{PREVIOUS_PHASE_ARTIFACTS}}', formatArtifacts(context.previousArtifacts))
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
