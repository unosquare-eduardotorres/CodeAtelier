/**
 * PlaceholderManager — Manages idle placeholder agents in the pixel office.
 *
 * Extracted from PhaserOfficeScene to reduce god-class complexity.
 * Handles populating all known agent slots with idle wandering characters,
 * removing placeholders when real agents connect, and restoring them when
 * agent sessions end.
 */

import type { OfficeState } from '../engine/officeState'
import type { PhaserAgentManager } from './PhaserAgentManager'
import { SPRITE_ASSIGNMENTS, DEFAULT_SEAT_ASSIGNMENTS } from '../agentMapping'

/** Agent display names for idle placeholder agents */
const AGENT_NAMES: Record<string, string> = {
  coordinator: 'Coordinator',
  generalist: 'Generalist',
  'react-architect': 'React Architect',
  'dotnet-architect': '.NET Architect',
  'electron-architect': 'Electron Architect',
  'agentic-architect': 'Agentic Architect',
  'db-architect': 'DB Architect',
  'ux-ui-specialist': 'UX/UI Specialist',
  'git-github-specialist': 'Git Specialist',
  'requirements-specialist': 'Requirements',
  'code-planner': 'Code Planner',
  'execution-planner': 'Exec Planner',
  'cicd-devops': 'CI/CD DevOps',
  'cloud-infrastructure': 'Cloud Infra'
}

export { AGENT_NAMES }

export class PlaceholderManager {
  /** Maps agentType → placeholder numericId */
  private placeholders = new Map<string, number>()
  private idCounter = 50000

  /**
   * Get the placeholder (idle) numeric ID for an agent type.
   */
  getNumericId(agentType: string): number | undefined {
    return this.placeholders.get(agentType)
  }

  /**
   * Get the next unique placeholder ID.
   */
  nextId(): number {
    return this.idCounter++
  }

  /**
   * Populate all known agents as idle placeholders.
   * Only adds agents that haven't been added yet.
   *
   * @param addAgentFn - Callback to add agent to scene (delegates back to PhaserOfficeScene.addAgent)
   */
  populate(
    officeState: OfficeState,
    agentManager: PhaserAgentManager,
    createRpgTextureFn: (spriteId: string, numericId: number) => void
  ): void {
    const totalSeats = officeState.seats.size

    for (const [agentType, assignment] of Object.entries(SPRITE_ASSIGNMENTS)) {
      const seatIdx = DEFAULT_SEAT_ASSIGNMENTS[agentType]
      if (seatIdx !== undefined && seatIdx >= totalSeats) continue

      const numericId = this.nextId()
      this.placeholders.set(agentType, numericId)

      officeState.addAgent(numericId, assignment.spriteIndex, assignment.hueShift, undefined, true)

      const seatEntries = Array.from(officeState.seats.values())
      if (seatIdx !== undefined && seatIdx < seatEntries.length) {
        officeState.reassignSeat(numericId, seatEntries[seatIdx].uid)
      }

      const ch = officeState.characters.get(numericId)
      if (!ch) continue
      ch.displayName = AGENT_NAMES[agentType]
      ch.isActive = false

      agentManager.createAgent(
        numericId,
        assignment.spriteIndex,
        assignment.hueShift,
        ch.x,
        ch.y,
        AGENT_NAMES[agentType]
      )

      // Load RPG sprite if available
      if (assignment.pixelSpriteId) {
        createRpgTextureFn(assignment.pixelSpriteId, numericId)
      }
    }
  }

  /**
   * Remove a placeholder to make room for a real agent.
   */
  remove(
    agentType: string,
    officeState: OfficeState | null,
    agentManager: PhaserAgentManager | null
  ): void {
    const numericId = this.placeholders.get(agentType)
    if (numericId === undefined) return
    this.placeholders.delete(agentType)
    if (!officeState || !agentManager) return
    officeState.removeAgent(numericId)
    agentManager.removeAgent(numericId, false)
  }

  /**
   * Restore a placeholder when a real agent session ends.
   * Returns the info needed to call addAgent, or null if already exists.
   */
  restore(agentType: string): {
    numericId: number
    spriteIndex: number
    hueShift: number
    seatIdx: number | undefined
    displayName: string
  } | null {
    if (this.placeholders.has(agentType)) return null
    const assignment = SPRITE_ASSIGNMENTS[agentType]
    if (!assignment) return null
    const seatIdx = DEFAULT_SEAT_ASSIGNMENTS[agentType]
    const numericId = this.nextId()
    this.placeholders.set(agentType, numericId)
    return {
      numericId,
      spriteIndex: assignment.spriteIndex,
      hueShift: assignment.hueShift,
      seatIdx,
      displayName: AGENT_NAMES[agentType] || agentType
    }
  }
}
