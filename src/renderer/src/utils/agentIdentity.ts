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
