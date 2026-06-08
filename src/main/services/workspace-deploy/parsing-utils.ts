/**
 * parsing-utils.ts — Pure parsing functions extracted from workspace-deploy.service.ts.
 *
 * These are stateless string/YAML parsers with zero class dependencies,
 * ideal for independent unit testing.
 */

/**
 * Simple YAML frontmatter parser for agent YAML files.
 * Handles key-value pairs, multiline values (| and >), and inline arrays.
 */
export function parseAgentYaml(content: string): {
  frontmatter: Record<string, unknown>
  body: string
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return { frontmatter: {}, body: content }
  }

  const frontmatterRaw = match[1]
  const body = match[2].trim()
  const frontmatter: Record<string, unknown> = {}

  // Parse simple YAML key-value pairs
  let currentKey = ''
  let currentValue = ''
  let isMultiline = false

  for (const line of frontmatterRaw.split('\n')) {
    if (isMultiline) {
      if (line.startsWith('  ') || line.startsWith('\t')) {
        currentValue += ' ' + line.trim()
        continue
      } else {
        frontmatter[currentKey] = currentValue.trim()
        isMultiline = false
      }
    }

    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (kvMatch) {
      currentKey = kvMatch[1]
      const val = kvMatch[2].trim()

      if (val === '>' || val === '|') {
        isMultiline = true
        currentValue = ''
      } else if (val.startsWith('[') && val.endsWith(']')) {
        // Parse inline array: [item1, item2, ...]
        frontmatter[currentKey] = val
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      } else {
        frontmatter[currentKey] = val
      }
    }
  }

  if (isMultiline) {
    frontmatter[currentKey] = currentValue.trim()
  }

  return { frontmatter, body }
}

/**
 * Parse SKILL.md frontmatter for name/description.
 * Returns null if no frontmatter block is found.
 */
export function parseSkillMdFrontmatter(
  content: string
): { name?: string; description?: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null

  const result: { name?: string; description?: string } = {}
  let currentKey = ''
  let currentValue = ''
  let isMultiline = false

  for (const line of match[1].split('\n')) {
    if (isMultiline) {
      if (line.startsWith('  ') || line.startsWith('\t')) {
        currentValue += ' ' + line.trim()
        continue
      } else {
        if (currentKey === 'name') result.name = currentValue.trim()
        if (currentKey === 'description') result.description = currentValue.trim()
        isMultiline = false
      }
    }

    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (kvMatch) {
      currentKey = kvMatch[1]
      const val = kvMatch[2].trim()
      if (val === '>' || val === '|') {
        isMultiline = true
        currentValue = ''
      } else {
        if (currentKey === 'name') result.name = val
        if (currentKey === 'description') result.description = val
      }
    }
  }

  if (isMultiline) {
    if (currentKey === 'name') result.name = currentValue.trim()
    if (currentKey === 'description') result.description = currentValue.trim()
  }

  return result
}

/**
 * Extract "Last updated: YYYY-MM-DD" from SKILL.md content.
 * Returns null if no match is found.
 */
export function extractLastUpdated(content: string): string | null {
  const match = content.match(/Last updated:\s*(\d{4}-\d{2}-\d{2})/i)
  return match ? match[1] : null
}
