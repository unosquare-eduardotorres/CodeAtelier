export function formatTimeAgo(date: Date): string {
  const now = Date.now()
  const diffMs = now - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}

/**
 * Strip markdown syntax to produce a clean plain-text preview.
 * Removes headings (#), bold/italic (** / _), backticks, links [text](url) to text,
 * and collapses whitespace.
 */
export function stripMarkdownInline(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')       // headings
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // links → text
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')  // bold/italic
    .replace(/`([^`]+)`/g, '$1')        // inline code
    .replace(/```[\s\S]*?```/g, '')     // code blocks
    .replace(/\n{2,}/g, ' — ')          // paragraph breaks → dash
    .replace(/\n/g, ' ')                // remaining newlines
    .replace(/\s{2,}/g, ' ')            // collapse spaces
    .trim()
}
