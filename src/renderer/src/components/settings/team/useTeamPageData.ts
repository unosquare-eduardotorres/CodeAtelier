/**
 * useTeamPageData — shared computed data for the TeamPage decomposition.
 * Provides sorted/filtered agent/skill lists and the skill→agent map.
 */

import { useMemo } from 'react'
import { getAgentMeta } from '@renderer/utils/agentMeta'
import type { DiscoveredAgent, DiscoveredSkill, Specialist } from '../../../../../shared/types'

// ── Helpers ──

export function isStale(lastUpdated: string | null): boolean {
  if (!lastUpdated) return false
  const date = new Date(lastUpdated)
  const sixMonthsAgo = new Date()
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
  return date < sixMonthsAgo
}

export function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'Unknown'
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  } catch {
    return dateStr
  }
}

/** Build a map: skillName → list of agent display names that reference it */
function buildSkillAgentMap(
  agents: DiscoveredAgent[],
  specialists: Specialist[]
): Map<string, { name: string; icon: string }[]> {
  const map = new Map<string, { name: string; icon: string }[]>()
  for (const agent of agents) {
    const meta = getAgentMeta(agent.parsed.name, specialists)
    const displayName = meta?.displayName ?? agent.parsed.name
    const icon = meta?.icon ?? '🤖'
    for (const skillName of agent.parsed.skills) {
      const list = map.get(skillName) ?? []
      list.push({ name: displayName, icon })
      map.set(skillName, list)
    }
  }
  return map
}

// ── Hook ──

export interface TeamPageData {
  skillAgentMap: Map<string, { name: string; icon: string }[]>
  sortedAgents: DiscoveredAgent[]
  sortedSkills: DiscoveredSkill[]
  activeAgents: DiscoveredAgent[]
  inactiveAgents: DiscoveredAgent[]
}

export function useTeamPageData(
  agents: DiscoveredAgent[],
  skills: DiscoveredSkill[],
  specialists: Specialist[]
): TeamPageData {
  const skillAgentMap = useMemo(
    () => buildSkillAgentMap(agents, specialists),
    [agents, specialists]
  )

  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
      if (a.isDeployed !== b.isDeployed) return a.isDeployed ? -1 : 1
      return a.parsed.name.localeCompare(b.parsed.name)
    })
  }, [agents])

  const sortedSkills = useMemo(() => {
    return [...skills].sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [skills])

  const activeAgents = useMemo(() => sortedAgents.filter((a) => a.isActive), [sortedAgents])
  const inactiveAgents = useMemo(() => sortedAgents.filter((a) => !a.isActive), [sortedAgents])

  return { skillAgentMap, sortedAgents, sortedSkills, activeAgents, inactiveAgents }
}
