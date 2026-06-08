import { MCP_DISPLAY_NAMES } from '../../../../shared/constants'

/**
 * Shortens an absolute path to its last 2 meaningful segments.
 * e.g., "/Users/eduardo/Downloads/COE Operation Nexus/src/App.tsx" → "…/src/App.tsx"
 */
function shortenPath(fullPath: string): string {
  const segments = fullPath.split('/').filter(Boolean)
  if (segments.length <= 2) return fullPath
  return '…/' + segments.slice(-2).join('/')
}

/**
 * Shortens long absolute paths to show `…/parentFolder/file.ext`.
 * Handles paths with spaces, command strings containing paths, and Grep summaries.
 */
export function shortenInput(input: string): string {
  // If already short enough, return as-is
  if (input.length <= 50) return input

  // For Grep-style inputs like `/pattern/ in /some/long/path`, shorten the path part
  const grepMatch = input.match(/^(\/.*?\/)\s+in\s+(.+)$/)
  if (grepMatch) {
    const pattern = grepMatch[1]
    const pathPart = shortenPath(grepMatch[2])
    return `${pattern} in ${pathPart}`
  }

  // For command strings, try to extract and shorten any embedded absolute path
  const cmdPathMatch = input.match(/^(.+?\s)(\/\S.*?)(\s+.*)?$/)
  if (cmdPathMatch) {
    const prefix = cmdPathMatch[1]
    const rawPath = cmdPathMatch[2]
    const suffix = cmdPathMatch[3] || ''
    const shortened = shortenPath(rawPath)
    const result = prefix + shortened + suffix
    return result.length <= 65 ? result : prefix + shortened
  }

  // For pure paths (starts with /)
  if (input.startsWith('/')) {
    return shortenPath(input)
  }

  return input
}

/** Maps raw MCP tool names (mcp__server__tool) to human-readable display names. */
export function getToolDisplayName(toolName: string): string {
  if (MCP_DISPLAY_NAMES[toolName]) return MCP_DISPLAY_NAMES[toolName]
  // Generic MCP fallback — e.g. "mcp__server__tool" → "server · tool"
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__')
    return parts.length >= 3 ? `${parts[1]} · ${parts[2]}` : toolName
  }
  return toolName
}
