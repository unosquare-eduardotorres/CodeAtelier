/**
 * Fixed role identities. Avatars are now image-only:
 *  - 'specialist' → Agent portrait (uses da-vinci avatar assets)
 *  - 'user'        → User portrait
 *  - specialists resolve to the workspace's mannequin at the call-site
 *    (see getWorkspaceMannequin)
 */
export const CORE_AGENT_DEFAULTS: Record<
  string,
  { displayName: string; avatarKey: string; color: string }
> = {
  specialist: { displayName: 'Agent', avatarKey: 'da-vinci', color: '#D97706' }
}

/** Avatar key for the user role. */
export const USER_AVATAR_KEY = 'user'

/** A trailing opaque id (uuid or 32-char hex), as used by `workspace-specialist-<id>`. */
const TRAILING_ID_RE =
  /-(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i

/**
 * Turn an agent id into something a person can read.
 *
 * This is the last resort in message identity resolution: when no specialist row
 * matches, the id itself is all we have. Printing it raw leaked strings like
 * `workspace-specialist-62e0180c91c4af14c3ff127d561a3b55` into the chat header,
 * so the opaque suffix is dropped and the remaining slug is title-cased.
 *
 * Returns null when nothing readable survives, so the caller can fall back to
 * the message role rather than render an empty name.
 */
export function humaniseAgentId(agentId: string): string | null {
  const words = agentId
    .replace(TRAILING_ID_RE, '')
    .split(/[-_\s]+/)
    .filter((w) => w.length > 0)

  if (words.length === 0) return null
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}
