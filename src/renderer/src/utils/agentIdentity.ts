/**
 * Default identity map for core agents (generalist & orchestrator).
 * These are NOT in the specialists table, so we define fallback defaults here.
 * Users can override these via core_agent_aliases table.
 */
export const CORE_AGENT_DEFAULTS: Record<
  string,
  { displayName: string; avatarKey: string; color: string }
> = {
  generalist: { displayName: 'Da Vinci', avatarKey: 'da-vinci', color: '#D97706' },
  coordinator: { displayName: 'Stravinsky', avatarKey: 'stravinsky', color: '#8B5CF6' }
}

/**
 * Map of specialist agentId to a default avatar key.
 * Used when no custom avatar_url is set on the specialist.
 */
export const SPECIALIST_DEFAULT_AVATARS: Record<string, string> = {
  'react-architect': 'hoodie-dev',
  'dotnet-architect': 'business-man',
  'electron-architect': 'glasses-guy',
  'agentic-architect': 'robot',
  'db-architect': 'scientist',
  'ux-ui-specialist': 'ponytail-girl',
  'git-github-specialist': 'ninja',
  'requirements-specialist': 'business-woman',
  'code-planner': 'glasses-guy',
  'execution-planner': 'superhero',
  'cicd-devops': 'cap-guy',
  'cloud-infrastructure': 'bearded-man',
  'docs-diagrams-specialist': 'woman-curly'
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
