/**
 * Sanitizes user-provided values before interpolation into prompt template literals.
 *
 * Defense-in-depth against prompt injection via user-facing fields
 * (idea titles, descriptions, project names, workspace names, goals).
 * The actual threat model is low (desktop app, user is the prompt author),
 * but this prevents accidental markdown heading patterns from being
 * interpreted as structural prompt elements.
 *
 * Strips:
 * - Markdown heading patterns (`#+ `) that could override prompt sections
 * - Code fence markers (```) that could inject fake structured blocks
 * - XML-like system tags that could mimic system-level instructions
 */
export function sanitizePromptInput(value: string): string {
  return (
    value
      // Strip markdown headings (## System Override, etc.)
      .replace(/^#{1,6}\s+/gm, '')
      // Strip code fence openers/closers that could inject fake structured blocks
      // (e.g., ```grill-evaluation or ```goal-plan)
      .replace(/^`{3,}[\w-]*$/gm, '')
      // Strip XML-like system tags that could mimic internal instructions
      .replace(/<\/?(?:system|mode-context|instructions)[^>]*>/gi, '')
  )
}
