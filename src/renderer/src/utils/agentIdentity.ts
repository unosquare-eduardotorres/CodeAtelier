/**
 * Default identity map for core agents (generalist & orchestrator).
 * These are NOT in the specialists table, so we define fallback defaults here.
 * Users can override these via core_agent_aliases table.
 */
export const CORE_AGENT_DEFAULTS: Record<
  string,
  { displayName: string; avatarKey: string; color: string }
> = {
  generalist: { displayName: 'Da Vinci', avatarKey: 'renaissance-painter', color: '#D97706' },
  coordinator: { displayName: 'Stravinsky', avatarKey: 'renaissance-astronomer', color: '#8B5CF6' }
}

/**
 * Map of specialist agentId to a default avatar key.
 * Used when no custom avatar_url is set on the specialist.
 */
export const SPECIALIST_DEFAULT_AVATARS: Record<string, string> = {
  'react-architect': 'renaissance-architect',
  'dotnet-architect': 'renaissance-scribe',
  'electron-architect': 'renaissance-scholar',
  'agentic-architect': 'renaissance-alchemist',
  'db-architect': 'renaissance-alchemist',
  'ux-ui-specialist': 'renaissance-painter',
  'git-github-specialist': 'renaissance-navigator',
  'requirements-specialist': 'renaissance-diplomat',
  'code-planner': 'renaissance-architect',
  'execution-planner': 'renaissance-knight',
  'cicd-devops': 'renaissance-explorer',
  'cloud-infrastructure': 'renaissance-astronomer',
  'docs-diagrams-specialist': 'renaissance-scribe'
}

/**
 * Get the default avatar key for a given agent role or agentId.
 */
export function getDefaultAvatarForRole(role: string): string {
  if (role in CORE_AGENT_DEFAULTS) {
    return CORE_AGENT_DEFAULTS[role].avatarKey
  }
  return SPECIALIST_DEFAULT_AVATARS[role] ?? 'renaissance-scholar'
}
