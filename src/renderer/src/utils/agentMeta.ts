import type { Specialist } from '../../../shared/types'

/** Default fallback metadata when a specialist isn't found in the DB store */
const FALLBACK_META = { icon: '🤖', color: '#B8976A', displayName: '' }

/**
 * Resolves agent metadata from the specialist store array.
 * Replaces the deprecated AGENT_META constant with DB-backed lookups.
 *
 * @param agentId - The agent_id to look up (e.g. 'react-architect')
 * @param specialists - The specialists array from useSpecialistStore
 * @returns Metadata object with icon, color, and displayName
 */
export function getAgentMeta(
  agentId: string,
  specialists: Specialist[]
): { icon: string; color: string; displayName: string } {
  const specialist = specialists.find((s) => s.agentId === agentId)
  if (specialist) {
    return {
      icon: specialist.icon,
      color: specialist.color,
      displayName: specialist.displayName
    }
  }
  return { ...FALLBACK_META, displayName: agentId }
}
