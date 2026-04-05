/**
 * PixelOfficeEngine interface — the contract between React and the Phaser engine.
 * Both PhaserOfficeCanvas and usePixelOfficeBridge import from this shared source.
 */

export interface PixelOfficeEngine {
  addAgent(
    id: string,
    numericId: number,
    spriteIndex: number,
    hueShift: number,
    seatIndex: number,
    displayName?: string,
    pixelSpriteId?: string
  ): void
  removeAgent(numericId: number): void
  setAgentActive(numericId: number, active: boolean): void
  setAgentTool(numericId: number, toolName: string | null): void
  showPermissionBubble(numericId: number, text: string): void
  clearPermissionBubble(numericId: number): void
  getTotalSeats(): number
  getAgentNumericId(agentId: string): number | undefined
  /** Get placeholder numeric ID for an agent type, if one exists */
  getPlaceholderNumericId(agentType: string): number | undefined
  /** Remove a placeholder agent to make room for a real session */
  removePlaceholder(agentType: string): void
  /** Restore a placeholder idle agent when a real session ends */
  restorePlaceholder(agentType: string): void
  /** Set the thought/activity text bubble for an agent */
  setAgentThought(numericId: number, thought: string | null): void
  /** Update an agent display name label */
  updateDisplayName(numericId: number, name: string): void
}

/**
 * Simple hash to generate a stable numeric ID from a string agent ID.
 */
export function agentIdToNumeric(agentId: string): number {
  let hash = 0
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash << 5) - hash + agentId.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash) % 100000
}

/** Known agent types for placeholder management */
export const KNOWN_AGENT_TYPES = [
  'coordinator',
  'generalist',
  'react-architect',
  'dotnet-architect',
  'electron-architect',
  'agentic-architect',
  'db-architect',
  'ux-ui-specialist',
  'git-github-specialist',
  'requirements-specialist',
  'code-planner',
  'execution-planner',
  'cicd-devops',
  'cloud-infrastructure'
] as const

/**
 * Resolve the display name for an agent using alias, specialist name, or ID derivation.
 */
export function resolveDisplayName(
  agentType: string,
  coreAgentAliases: Array<{ agentRole: string; alias: string | null }>,
  specialistName?: string
): string {
  if (agentType === 'generalist') {
    const alias = coreAgentAliases.find((a) => a.agentRole === 'generalist')?.alias
    if (alias) return alias
  }
  if (agentType === 'coordinator') {
    const alias = coreAgentAliases.find((a) => a.agentRole === 'coordinator')?.alias
    if (alias) return alias
  }
  if (specialistName) return specialistName
  return agentType
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Try to find the agent type from a tracked agent ID.
 */
export function findAgentTypeForId(agentId: string): string | null {
  for (const type of KNOWN_AGENT_TYPES) {
    if (agentId === type || agentId.startsWith(type + '-') || agentId.startsWith(type + ':')) {
      return type
    }
  }
  return null
}
