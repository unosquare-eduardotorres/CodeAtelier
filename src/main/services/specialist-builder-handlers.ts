/**
 * Pure-logic helpers extracted from SpecialistBuilderService for testability.
 *
 * These functions are side-effect-free (no DB, no FS) and handle:
 * - Tech-stack fingerprinting (SHA-256 hash)
 * - Enabled-skills list formatting (budget-capped bullet list)
 * - Slot value assembly (pure mapping from workspace data)
 */

import { createHash } from 'node:crypto'

/**
 * Compute a deterministic SHA-256 fingerprint from a list of detected technologies.
 * Sorts the list before hashing so insertion order is irrelevant.
 * Returns the first 16 hex chars (64 bits — sufficient for change detection).
 */
export function fingerprintTechStack(detectedTechs: string[]): string {
  const sorted = [...detectedTechs].sort()
  return createHash('sha256').update(sorted.join('|')).digest('hex').slice(0, 16)
}

/**
 * Format a list of enabled skills as a markdown bullet list, capped at a character budget.
 * Each skill is rendered as `- **name** — description` (description omitted if null).
 * If the budget is exceeded, remaining skills are indicated with a truncation notice.
 *
 * @param skills Array of { name, description } objects (already DB-sorted by name)
 * @param budgetChars Maximum character budget for the output (default 4000)
 * @returns Formatted bullet list or fallback message if no skills
 */
export function formatEnabledSkillsList(
  skills: Array<{ name: string; description: string | null }>,
  budgetChars: number = 4000
): string {
  if (skills.length === 0) {
    return '(no skills enabled yet — enable from the Skills tab)'
  }

  const lines: string[] = []
  let totalChars = 0
  for (const r of skills) {
    const line = `- **${r.name}**${r.description ? ` — ${r.description}` : ''}`
    if (totalChars + line.length > budgetChars && lines.length > 0) {
      lines.push(`_(${skills.length - lines.length} more skills omitted — budget cap reached)_`)
      break
    }
    lines.push(line)
    totalChars += line.length + 1 // +1 for newline
  }
  return lines.join('\n')
}

/**
 * Assemble the pure (non-DB, non-FS) portion of prompt slot values
 * from workspace metadata + pre-formatted enabled skills.
 */
export function buildSlotValues(
  workspaceName: string,
  enabledSkills: string
): { workspaceName: string; enabledSkills: string } {
  return { workspaceName, enabledSkills }
}
