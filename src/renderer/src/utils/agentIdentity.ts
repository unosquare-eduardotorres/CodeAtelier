/**
 * Default identity map for core agents (generalist & orchestrator).
 * These are NOT in the specialists table, so we define fallback defaults here.
 * Users can override these via core_agent_aliases table.
 */
export const CORE_AGENT_DEFAULTS: Record<
  string,
  { displayName: string; avatarKey: string; color: string }
> = {
  generalist: { displayName: 'Generalist', avatarKey: 'scholar', color: '#10B981' },
  coordinator: { displayName: 'Orchestrator', avatarKey: 'architect', color: '#6366F1' }
}

/**
 * Map of specialist agentId to a default avatar key.
 * Used when no custom avatar_url is set on the specialist.
 */
export const SPECIALIST_DEFAULT_AVATARS: Record<string, string> = {
  'react-architect': 'cyborg',
  'dotnet-architect': 'robot',
  'electron-architect': 'hacker',
  'agentic-architect': 'robot',
  'db-architect': 'alchemist',
  'ux-ui-specialist': 'artist',
  'git-github-specialist': 'detective',
  'requirements-specialist': 'writer',
  'code-planner': 'scholar',
  'execution-planner': 'architect',
  'cicd-devops': 'rocket-pilot',
  'cloud-infrastructure': 'explorer',
  'docs-diagrams-specialist': 'writer'
}

/**
 * Get the default avatar key for a given agent role or agentId.
 */
export function getDefaultAvatarForRole(role: string): string {
  if (role in CORE_AGENT_DEFAULTS) {
    return CORE_AGENT_DEFAULTS[role].avatarKey
  }
  return SPECIALIST_DEFAULT_AVATARS[role] ?? 'robot'
}
