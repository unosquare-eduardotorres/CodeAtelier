/**
 * Fenced-block location, shared by the main and renderer processes.
 *
 * The lazy regex this replaces — /`{3,4}plan\n([\s\S]*?)`{3,4}/ — stopped at the
 * FIRST run of backticks anywhere after the opening fence. A structured plan
 * whose JSON contains a code sample ("```csharp\n…" inside a string value) was
 * therefore truncated mid-string: the plan card fell back to dumping raw JSON
 * and the leftover tail leaked into the chat bubble.
 *
 * The rule here: the closing fence is a run of backticks ALONE on its own line.
 * A fence embedded in a JSON string value is always preceded by escaped `\n`
 * characters on the same physical line, so it can never sit at column 0 and can
 * never be mistaken for the end of the block.
 */

export interface FencedBlock {
  /** Block body, exactly as written between the fences (no trim). */
  content: string
  /** Index of the opening backtick in the source text. */
  start: number
  /** Index one past the closing fence — `text.slice(end)` is the trailing prose. */
  end: number
}

/** Escape a language tag for use inside a RegExp. */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Locate the first ```<lang> block in `text`.
 *
 * Closing-fence resolution, in order:
 *   1. a run of backticks (at least as long as the opening fence) alone on its
 *      own line — the nesting-safe rule;
 *   2. failing that, the legacy "next run of backticks anywhere" rule, so
 *      hand-written inline-terminated blocks still resolve.
 *
 * Returns null when there is no opening fence or no closing fence at all —
 * matching the previous "no block" semantics for unterminated/streaming text.
 */
export function findFencedBlock(text: string, lang: string): FencedBlock | null {
  if (!text) return null

  const open = new RegExp('(`{3,4})' + escapeRe(lang) + '[ \\t]*\\r?\\n').exec(text)
  if (!open) return null

  const fenceLen = open[1].length
  const bodyStart = open.index + open[0].length

  // 1. Closing fence alone on its own line. Search starts one character early,
  //    on the newline that ended the opening fence, so an empty body resolves.
  const ownLineRe = new RegExp('\\n(`{' + fenceLen + ',})[ \\t]*(?=\\r?\\n|$)', 'g')
  ownLineRe.lastIndex = bodyStart - 1
  const ownLine = ownLineRe.exec(text)
  if (ownLine) {
    const fenceStart = ownLine.index + 1
    return {
      // Drop the newline that separates the last body line from the fence.
      content: text.slice(bodyStart, Math.max(bodyStart, fenceStart - crlfLen(text, fenceStart))),
      start: open.index,
      end: ownLine.index + ownLine[0].length
    }
  }

  // 2. Legacy fallback — next run of backticks anywhere.
  const tail = text.slice(bodyStart)
  const inline = new RegExp('`{' + fenceLen + ',}').exec(tail)
  if (!inline) return null

  return {
    content: tail.slice(0, inline.index),
    start: open.index,
    end: bodyStart + inline.index + inline[0].length
  }
}

/** 1 for the LF before the fence, 2 when it is a CRLF, 0 when the body is empty. */
function crlfLen(text: string, fenceStart: number): number {
  if (text[fenceStart - 1] !== '\n') return 0
  return text[fenceStart - 2] === '\r' ? 2 : 1
}

/** Body of the first ```<lang> block, or null when there is none. */
export function extractFencedContent(text: string, lang: string): string | null {
  return findFencedBlock(text, lang)?.content ?? null
}

/** Whether `text` contains a complete ```<lang> block. */
export function hasFencedBlock(text: string, lang: string): boolean {
  return findFencedBlock(text, lang) !== null
}
