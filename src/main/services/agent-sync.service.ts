import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dbLogger } from '../logger'
import { specialistRepository } from '../db/repositories/specialist.repository'
import { skillRepository } from '../db/repositories/skill.repository'
import { workspaceDeployService } from './workspace-deploy.service'
import { skillSummaryService } from './skill-summary.service'
import type {
  SyncDiff,
  SyncResult,
  DiscoveredAgent,
  DiscoveredSkill,
  Specialist,
  Skill
} from '../../shared/types'

/**
 * AgentSyncService — bridges workspace YAML files with the SQLite database.
 *
 * The DB is the primary source of truth for specialist definitions.
 * Workspace YAMLs (if present) are synced into the DB on workspace open.
 * Sync is workspace-scoped — triggered on workspace open or via Settings UI.
 */
export class AgentSyncService {
  /** Core agent IDs that are managed via DB prompts, not YAML sync */
  private readonly CORE_AGENT_IDS = new Set(['generalist', 'generalist-agent'])

  /**
   * Compare workspace YAMLs against DB state.
   * Does NOT mutate anything — pure read + diff.
   */
  computeDiff(workspacePath: string): SyncDiff {
    // 1. Scan workspace YAMLs (only deployed agents in the workspace, excluding core agents)
    const yamlAgents = this.getDeployedWorkspaceAgents(workspacePath).filter(
      (a) => !this.CORE_AGENT_IDS.has(a.parsed.name)
    )
    const yamlSkills = this.getDeployedWorkspaceSkills(workspacePath)

    // 2. Load all specialists from DB
    const dbSpecialists = specialistRepository.findAll()
    const dbSkills = skillRepository.findAll()

    // 3. Build lookup maps
    const dbByAgentId = new Map<string, Specialist>()
    for (const sp of dbSpecialists) {
      dbByAgentId.set(sp.agentId, sp)
    }

    const yamlByName = new Map<string, DiscoveredAgent>()
    for (const agent of yamlAgents) {
      yamlByName.set(agent.parsed.name, agent)
    }

    const dbSkillsByFilename = new Map<string, Skill>()
    for (const sk of dbSkills) {
      dbSkillsByFilename.set(sk.filename, sk)
    }

    // 4. Classify specialists
    const newSpecialists: DiscoveredAgent[] = []
    const updatedSpecialists: SyncDiff['updatedSpecialists'] = []
    const unchangedSpecialists: Specialist[] = []
    const matchedAgentIds = new Set<string>()

    for (const agent of yamlAgents) {
      const agentId = agent.parsed.name
      const dbRecord = dbByAgentId.get(agentId)

      if (!dbRecord) {
        newSpecialists.push(agent)
      } else {
        matchedAgentIds.add(agentId)
        const changes = this.detectChanges(agent, dbRecord)
        if (changes.length > 0) {
          updatedSpecialists.push({ agent, dbRecord, changes })
        } else {
          unchangedSpecialists.push(dbRecord)
        }
      }
    }

    // DB records not matched by any YAML and originally synced from YAML
    const removedSpecialists = dbSpecialists.filter(
      (sp) => !matchedAgentIds.has(sp.agentId) && sp.sourceYaml !== null
    )

    // 5. Classify skills
    const allReferencedSkillNames = new Set<string>()
    for (const agent of yamlAgents) {
      for (const skillRef of agent.parsed.skills) {
        allReferencedSkillNames.add(skillRef)
      }
    }

    const newSkills: DiscoveredSkill[] = []
    const unchangedSkills: Skill[] = []
    const matchedSkillFilenames = new Set<string>()

    for (const skillName of allReferencedSkillNames) {
      // Skills are stored in DB by their filename (e.g. "electron-pro.md")
      // But YAML references use the directory name (e.g. "electron-pro")
      // The file_path in DB points to the SKILL.md location
      const matchingDbSkill = dbSkills.find(
        (sk) =>
          sk.filename === `${skillName}.md` ||
          sk.name.toLowerCase().replace(/\s+/g, '-') === skillName
      )

      if (matchingDbSkill) {
        matchedSkillFilenames.add(matchingDbSkill.filename)
        unchangedSkills.push(matchingDbSkill)
      } else {
        // Check if skill directory exists in workspace
        const discoveredSkill = yamlSkills.find((s) => s.name === skillName)
        if (discoveredSkill && discoveredSkill.hasSkillMd) {
          newSkills.push(discoveredSkill)
        }
      }
    }

    // Skills in DB but no longer referenced by any YAML
    const removedSkills = dbSkills.filter((sk) => !matchedSkillFilenames.has(sk.filename))

    const hasChanges =
      newSpecialists.length > 0 ||
      updatedSpecialists.length > 0 ||
      removedSpecialists.length > 0 ||
      newSkills.length > 0

    return {
      newSpecialists,
      updatedSpecialists,
      removedSpecialists,
      unchangedSpecialists,
      newSkills,
      removedSkills,
      unchangedSkills,
      hasChanges
    }
  }

  /**
   * Apply the full sync: create/update/deactivate specialists + skills.
   * Called after user confirms the sync report.
   */
  applySync(workspacePath: string, _options?: { skipRemoved?: boolean }): SyncResult {
    const result: SyncResult = {
      imported: 0,
      updated: 0,
      deactivated: 0,
      skillsImported: 0,
      errors: []
    }

    // ── Step 1: Wipe all YAML-sourced specialists ──
    const dbSpecialists = specialistRepository.findAll()
    for (const sp of dbSpecialists) {
      if (sp.sourceYaml) {
        try {
          specialistRepository.delete(sp.id) // CASCADE removes specialist_skills
          result.deactivated++
        } catch (e) {
          result.errors.push(`Failed to delete specialist "${sp.agentId}": ${(e as Error).message}`)
        }
      }
    }

    // ── Step 2: Import all skills from workspace ──
    const yamlSkills = this.getDeployedWorkspaceSkills(workspacePath)
    for (const discoveredSkill of yamlSkills) {
      if (!discoveredSkill.hasSkillMd) continue
      try {
        this.importSkillFromDiscovered(discoveredSkill)
        result.skillsImported++
        dbLogger.info(`Sync: imported skill "${discoveredSkill.name}"`)
      } catch (e) {
        const msg = `Failed to import skill "${discoveredSkill.name}": ${(e as Error).message}`
        result.errors.push(msg)
        dbLogger.warn(`Sync: ${msg}`)
      }
    }

    // ── Step 3: Re-create all specialists from YAML ──
    const yamlAgents = this.getDeployedWorkspaceAgents(workspacePath)
    for (const agent of yamlAgents) {
      try {
        this.createSpecialistFromAgent(agent)
        result.imported++
        dbLogger.info(`Sync: imported specialist "${agent.parsed.name}"`)
      } catch (e) {
        const msg = `Failed to import specialist "${agent.parsed.name}": ${(e as Error).message}`
        result.errors.push(msg)
        dbLogger.warn(`Sync: ${msg}`)
      }
    }

    // ── Step 4: Link specialists to skills ──
    this.syncSkillAssignments(workspacePath)

    dbLogger.info(
      `Fresh sync complete: ${result.imported} imported, ${result.deactivated} wiped, ${result.skillsImported} skills`
    )

    return result
  }

  /**
   * Auto-sync: computeDiff + apply only NEW items (safe).
   * Used on workspace open — only adds, never removes or overwrites.
   */
  autoSyncNewEntries(workspacePath: string): SyncResult {
    const diff = this.computeDiff(workspacePath)
    const result: SyncResult = {
      imported: 0,
      updated: 0,
      deactivated: 0,
      skillsImported: 0,
      errors: []
    }

    if (!diff.hasChanges) return result

    // Only import NEW skills
    for (const discoveredSkill of diff.newSkills) {
      try {
        this.importSkillFromDiscovered(discoveredSkill)
        result.skillsImported++
        dbLogger.info(`Auto-sync: imported new skill "${discoveredSkill.name}"`)
      } catch (e) {
        const msg = `Failed to auto-import skill "${discoveredSkill.name}": ${(e as Error).message}`
        result.errors.push(msg)
        dbLogger.warn(`Auto-sync: ${msg}`)
      }
    }

    // Only import NEW specialists
    for (const agent of diff.newSpecialists) {
      try {
        this.createSpecialistFromAgent(agent)
        result.imported++
        dbLogger.info(`Auto-sync: imported new specialist "${agent.parsed.name}"`)
      } catch (e) {
        const msg = `Failed to auto-import specialist "${agent.parsed.name}": ${(e as Error).message}`
        result.errors.push(msg)
        dbLogger.warn(`Auto-sync: ${msg}`)
      }
    }

    // Link specialists to skills for new entries
    if (result.imported > 0 || result.skillsImported > 0) {
      this.syncSkillAssignments(workspacePath)
    }

    return result
  }

  // ── Private Helpers ──

  /** Get deployed workspace agents */
  private getDeployedWorkspaceAgents(workspacePath: string): DiscoveredAgent[] {
    const allAgents = workspaceDeployService.scanWorkspaceAgents(workspacePath)
    return allAgents.filter((a) => a.isDeployed)
  }

  /** Get only deployed workspace skills */
  private getDeployedWorkspaceSkills(workspacePath: string): DiscoveredSkill[] {
    return workspaceDeployService.scanWorkspaceSkills(workspacePath)
  }

  /** Compare a YAML agent against its DB record and return list of changes */
  private detectChanges(agent: DiscoveredAgent, dbRecord: Specialist): string[] {
    const changes: string[] = []

    // Compare prompt/body content
    const yamlPrompt = agent.bodyContent.trim()
    const dbPrompt = (dbRecord.prompt ?? '').trim()
    if (yamlPrompt && dbPrompt && yamlPrompt !== dbPrompt) {
      changes.push('prompt changed')
    } else if (yamlPrompt && !dbPrompt) {
      changes.push('prompt added')
    }

    // Compare display name (YAML description → DB displayName is not a 1:1 mapping,
    // but if the source_yaml matches, we can detect display name drift)
    // We skip display name comparison since it's user-customizable

    // Compare skill assignments
    const yamlSkillNames = new Set(agent.parsed.skills)
    const dbSkills = specialistRepository.getAllSkills(dbRecord.id)
    const dbSkillNames = new Set(
      dbSkills.map((sk) => {
        // Reverse-map DB skill filename to YAML skill reference
        const name = sk.filename.replace(/\.md$/, '')
        return name
      })
    )

    const addedSkills = [...yamlSkillNames].filter((s) => !dbSkillNames.has(s))
    const removedSkills = [...dbSkillNames].filter((s) => !yamlSkillNames.has(s))

    if (addedSkills.length > 0 || removedSkills.length > 0) {
      changes.push('skills changed')
    }

    return changes
  }

  /** Create a new specialist from a discovered YAML agent */
  private createSpecialistFromAgent(agent: DiscoveredAgent): Specialist {
    // Check if specialist already exists in DB (from prior sync) for icon/color defaults
    const meta = this.getAgentMeta(agent.parsed.name)

    return specialistRepository.create({
      agentId: agent.parsed.name,
      displayName: meta?.displayName ?? this.formatDisplayName(agent.parsed.name),
      description: agent.parsed.description || '',
      icon: meta?.icon ?? '🔧',
      color: meta?.color ?? '#6366F1',
      prompt: agent.bodyContent || agent.parsed.description || '',
      priority: meta?.priority ?? 100,
      sourceYaml: agent.filename,
      isActive: false
    })
  }

  /** Import a discovered skill into the DB and generate semantic summaries */
  private importSkillFromDiscovered(discovered: DiscoveredSkill): Skill {
    const filename = `${discovered.name}.md`

    // Check if already exists
    const existing = skillRepository.findByFilename(filename)
    if (existing) {
      // Regenerate summaries if stale
      this.generateSkillSummaries(existing)
      return existing
    }

    const skill = skillRepository.create({
      name: discovered.frontmatter?.name ?? this.formatDisplayName(discovered.name),
      description: discovered.frontmatter?.description ?? '',
      filename,
      filePath: join(discovered.dirPath, 'SKILL.md'),
      isActive: false,
      lastUpdatedDate: discovered.lastUpdated ?? undefined
    })

    // Generate semantic summaries for the new skill
    this.generateSkillSummaries(skill)

    return skill
  }

  /** Generate and store semantic summaries for a skill if stale or missing */
  private generateSkillSummaries(skill: Skill): void {
    try {
      const content = readFileSync(skill.filePath, 'utf-8')
      if (!skillSummaryService.isStale(skill, content)) return

      const summaries = skillSummaryService.generateSummaries(content)
      const hash = skillSummaryService.contentHash(content)

      skillRepository.updateSummaries(skill.id, {
        full: summaries.full,
        standard: summaries.standard,
        minimal: summaries.minimal,
        hash
      })

      dbLogger.info(
        `Generated semantic summaries for skill "${skill.name}" ` +
          `(full: ${summaries.full.length}, standard: ${summaries.standard.length}, minimal: ${summaries.minimal.length} chars)`
      )
    } catch (e) {
      dbLogger.warn(
        `Could not generate summaries for skill "${skill.name}": ${(e as Error).message}`
      )
    }
  }

  /** Sync specialist-skill junction table based on YAML skill references */
  private syncSkillAssignments(workspacePath: string): void {
    const yamlAgents = this.getDeployedWorkspaceAgents(workspacePath)
    const dbSkills = skillRepository.findAll()
    const skillByName = new Map<string, Skill>()
    for (const sk of dbSkills) {
      // Map by directory name (filename without .md extension)
      skillByName.set(sk.filename.replace(/\.md$/, ''), sk)
    }

    for (const agent of yamlAgents) {
      const specialist = specialistRepository.findByAgentId(agent.parsed.name)
      if (!specialist) continue

      const currentSkills = specialistRepository.getAllSkills(specialist.id)
      const currentSkillIds = new Set(currentSkills.map((s) => s.id))

      // Build the set of skill IDs that YAML expects
      const expectedSkillIds = new Set<string>()
      for (const skillRef of agent.parsed.skills) {
        const skill = skillByName.get(skillRef)
        if (skill) {
          expectedSkillIds.add(skill.id)
        }
      }

      // Add missing skill assignments
      for (const skillId of expectedSkillIds) {
        if (!currentSkillIds.has(skillId)) {
          try {
            specialistRepository.assignSkill(specialist.id, skillId)
          } catch {
            // Already assigned or constraint issue — ignore
          }
        }
      }

      // Remove stale skill assignments no longer in YAML
      for (const existingSkill of currentSkills) {
        if (!expectedSkillIds.has(existingSkill.id)) {
          try {
            specialistRepository.removeSkill(specialist.id, existingSkill.id)
          } catch {
            // Already removed or constraint issue — ignore
          }
        }
      }
    }
  }

  /**
   * Get agent meta for icon/color/displayName defaults.
   * First checks if the specialist already exists in DB (from a prior sync),
   * preserving user customizations. Falls back to generic defaults for first-time imports.
   */
  private getAgentMeta(
    agentId: string
  ): { icon: string; color: string; displayName: string; priority: number } | null {
    // Check if specialist already exists in DB (from prior sync)
    const existing = specialistRepository.findByAgentId(agentId)
    if (existing) {
      return {
        icon: existing.icon,
        color: existing.color,
        displayName: existing.displayName,
        priority: existing.priority
      }
    }
    // Fallback for first-time import — generic defaults
    return null
  }

  /** Convert kebab-case agent ID to display name */
  private formatDisplayName(agentId: string): string {
    return agentId
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  }
}

export const agentSyncService = new AgentSyncService()
