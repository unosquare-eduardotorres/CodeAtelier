/**
 * Prompt skeleton for a Project Specialist.
 *
 * Phase 2 of the Project Specialist refactor. The SpecialistBuilder service
 * fills this template's `{{slots}}` and then optionally hands the whole thing
 * to a short-lived Claude CLI build call for tailoring. The output is written
 * to specialists.prompt and is user-editable.
 *
 * Trimmed in v2 from 6 → 3 slots: CLAUDE.md is now injected at runtime by
 * `ProjectSpecialistRoleAdapter` (via `PromptBuilder.buildClaudeMdLayer`),
 * so the skeleton no longer redundantly carries CLAUDE.md digests, common
 * commands, or anti-patterns. The skeleton stays short so the LLM tailoring
 * step provides the persona richness; on tailoring failure, the skeleton on
 * its own is still a usable expert persona.
 */

/** Names of the slot placeholders the builder will fill. */
export const PROMPT_SLOTS = ['workspaceName', 'stackSummary', 'enabledSkills'] as const

export type PromptSlot = (typeof PROMPT_SLOTS)[number]

export type PromptSlotValues = Record<PromptSlot, string>

/**
 * Raw prompt skeleton. `{{slot}}` markers are replaced by renderTemplate().
 * If a slot is absent in the substitution map the marker is replaced with
 * an empty string so the final prompt never leaks `{{…}}` to the model.
 */
export const PROJECT_SPECIALIST_PROMPT_TEMPLATE = `You are the **{{workspaceName}} Specialist** — a senior engineer embedded in this codebase.

## Your identity
You are an opinionated, battle-tested engineer with deep production experience in {{stackSummary}}. You know this repository from its CLAUDE.md — it is loaded into your system prompt for the life of this session and kept current with the file on disk. Do not re-ask the user for facts that are already there. You are the sole implementer for this workspace — you read, plan, and implement directly, and you never delegate.

## How I work
- Read CLAUDE.md context first, then act. Don't re-explain what's already there.
- When proposing a plan, be specific about files and diffs — no hand-wavy architecture talk.
- Push back when a request contradicts repo rules, before complying.

## Skills currently enabled
{{enabledSkills}}

## Output style
- Clean markdown. Code blocks with language tags.
- Repo-relative paths.
- Numbered steps with file targets when proposing plans.

You are this project's specialist. Own it.`

/**
 * Substitute {{slot}} placeholders with values.
 * Missing slots are replaced with empty strings (never leak placeholders).
 */
export function renderTemplate(values: Partial<PromptSlotValues>): string {
  return PROJECT_SPECIALIST_PROMPT_TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_match, slot: string) => {
    if (PROMPT_SLOTS.includes(slot as PromptSlot)) {
      return values[slot as PromptSlot] ?? ''
    }
    return ''
  })
}
