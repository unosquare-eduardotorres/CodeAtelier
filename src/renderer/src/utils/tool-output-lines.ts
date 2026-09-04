/**
 * Pure parser for tool-output line prefixes (chat tool-activity highlighting).
 *
 * Tool outputs decorate every line with a prefix identifying its origin —
 * Claude Read results use `  123→content` line gutters, grep results use
 * `path/to/file.ts:12:content` locators. The highlight pane renders those
 * prefixes as muted spans and prism-tokenizes only the content, so the parser
 * splits them apart. Pure string logic — no DOM, no React — testable from the
 * main-process harness.
 */

export interface ParsedLine {
  /** Claude Read line gutter, e.g. `  42` (leading whitespace preserved). */
  gutter?: string
  /** Grep locator, e.g. `src/app.ts:12`. */
  path?: string
  /** The remainder of the line after the prefix + separator. */
  content: string
}

/** `  123→rest` — Claude Read output gutter. */
const READ_GUTTER_RE = /^(\s*\d+)→(.*)$/
/** `path/file.ext:12:rest` — grep match locator (no leading whitespace). */
const GREP_PATH_RE = /^(\S+:\d+):(.*)$/

/** Split one output line into its prefix (if any) and highlightable content. */
export function parseToolOutputLine(line: string): ParsedLine {
  const read = READ_GUTTER_RE.exec(line)
  if (read) return { gutter: read[1], content: read[2] }

  const grep = GREP_PATH_RE.exec(line)
  if (grep) return { path: grep[1], content: grep[2] }

  return { content: line }
}
