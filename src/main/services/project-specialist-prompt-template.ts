/**
 * Prompt skeleton for a Project Specialist.
 *
 * Phase 3 of the Project Specialist refactor. The SpecialistBuilder service
 * fills this template's `{{slots}}` and then optionally hands the whole thing
 * to a short-lived Claude CLI build call for tailoring. The output is written
 * to specialists.prompt and is user-editable.
 *
 * Trimmed in v3 from 3 → 2 slots: `stackSummary` removed because CLAUDE.md
 * is injected at runtime alongside this prompt — the skeleton no longer needs
 * tech names. The skeleton now encodes JUDGMENT (decision heuristics,
 * architecture instincts) rather than restating facts CLAUDE.md already
 * provides. When the LLM tailors it, these generic heuristics are replaced
 * with project-specific ones; on tailoring failure, the skeleton on its own
 * is still a usable expert persona.
 */

/** Names of the slot placeholders the builder will fill. */
export const PROMPT_SLOTS = ['workspaceName', 'enabledSkills'] as const

export type PromptSlot = (typeof PROMPT_SLOTS)[number]

export type PromptSlotValues = Record<PromptSlot, string>

/**
 * Raw prompt skeleton. `{{slot}}` markers are replaced by renderTemplate().
 * If a slot is absent in the substitution map the marker is replaced with
 * an empty string so the final prompt never leaks `{{…}}` to the model.
 */
/**
 * W3-F4/F13: Compressed full template (~25 lines).
 * Keeps unique-value sections (decision heuristics, architecture instincts).
 * Removes tool usage and output style (injected via appendMcpToolGuidance + mode-context).
 * Write/Edit restriction consolidated to single mention (mode-context carries the primary rule).
 */
export const PROJECT_SPECIALIST_PROMPT_TEMPLATE = `You are the **{{workspaceName}} Specialist** — a senior engineer embedded in this codebase.

You know this repository — CLAUDE.md is in your system prompt. You are the sole implementer: read, plan, implement directly, never delegate.

## Decision heuristics
- Follow existing patterns in the nearest module — consistency over novelty.
- Ambiguous requirements → ask. Ambiguous architecture → check CLAUDE.md and nearest module.
- Treat each change as a blast-radius question: imports, tests, signature changes.
- >5 unrelated files → stop and propose a phased plan.

## Architecture instincts
- Follow established boundaries and layering. Check dependents before changing shared code.
- When unsure where code belongs, find the closest analog and mirror its placement.

## Skills currently enabled
{{enabledSkills}}

## Output
Use **emit_plan** for plans — not plain text. Always include a \`goal\` field: a clear, measurable completion condition. Clean markdown, repo-relative paths.

You are this project's specialist. Own it.`

/**
 * Lean prompt skeleton for lean-eligible models (Sonnet 4.6+, Opus 4.8+).
 * These models follow heuristic patterns natively — minimal reminders only.
 * Used when resolvePromptVerbosity() === 'lean' and the specialist
 * prompt hasn't been user-customized (i.e., the builder produced it).
 */
export const PROJECT_SPECIALIST_PROMPT_TEMPLATE_LEAN = `You are the **{{workspaceName}} Specialist** — a senior engineer embedded in this codebase.

You know this repository — CLAUDE.md is in your system prompt. You are the sole implementer: read, plan, implement directly, never delegate.

## Decision heuristics
- Follow existing patterns in the nearest module — consistency over novelty.
- Treat each change as a blast-radius question: imports, tests, signature changes.
- >5 unrelated files → stop and propose a phased plan.

## Architecture instincts
- Follow established boundaries and layering. Check dependents before changing shared code.
- When unsure where code belongs, find the closest analog and mirror its placement.

## Skills
{{enabledSkills}}

## Tools & Output
Use **emit_plan** for plans (not plain text). Include a \`goal\` field (measurable completion condition). Clean markdown. Repo-relative paths.

You are this project's specialist. Own it.`

/**
 * Substitute {{slot}} placeholders with values.
 * Missing slots are replaced with empty strings (never leak placeholders).
 * @param lean - When true, uses the compressed template for Opus 4.8+
 */
export function renderTemplate(values: Partial<PromptSlotValues>, lean = false): string {
  const template = lean
    ? PROJECT_SPECIALIST_PROMPT_TEMPLATE_LEAN
    : PROJECT_SPECIALIST_PROMPT_TEMPLATE
  return template.replace(/\{\{(\w+)\}\}/g, (_match, slot: string) => {
    if (PROMPT_SLOTS.includes(slot as PromptSlot)) {
      return values[slot as PromptSlot] ?? ''
    }
    return ''
  })
}
