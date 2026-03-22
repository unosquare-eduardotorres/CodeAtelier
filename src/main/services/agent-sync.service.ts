import { join } from 'node:path'
import { dbLogger } from '../logger'
import { specialistRepository } from '../db/repositories/specialist.repository'
import { skillRepository } from '../db/repositories/skill.repository'
import { workspaceDeployService } from './workspace-deploy.service'
import type {
  SyncDiff,
  SyncResult,
  DiscoveredAgent,
  DiscoveredSkill,
  Specialist,
  Skill
} from '../../shared/types'

/**
 * AgentSyncService — bridges workspace YAML files with the SQLite runtime cache.
 *
 * YAMLs are the portable source of truth (git-committed).
 * SQLite is Agent Studio's local runtime cache.
 * Sync is workspace-scoped — triggered on workspace open or via Settings UI.
 */
export class AgentSyncService {
  /**
   * Compare workspace YAMLs against DB state.
   * Does NOT mutate anything — pure read + diff.
   */
  computeDiff(workspacePath: string): SyncDiff {
    // 1. Scan workspace YAMLs (only deployed agents in the workspace)
    const yamlAgents = this.getDeployedWorkspaceAgents(workspacePath)
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
  applySync(workspacePath: string, options?: { skipRemoved?: boolean }): SyncResult {
    const diff = this.computeDiff(workspacePath)
    const result: SyncResult = {
      imported: 0,
      updated: 0,
      deactivated: 0,
      skillsImported: 0,
      errors: []
    }

    // Import new skills first (specialists may reference them)
    for (const discoveredSkill of diff.newSkills) {
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

    // Create new specialists
    for (const agent of diff.newSpecialists) {
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

    // Update changed specialists
    for (const { agent, dbRecord } of diff.updatedSpecialists) {
      try {
        this.updateSpecialistFromAgent(agent, dbRecord)
        result.updated++
        dbLogger.info(`Sync: updated specialist "${agent.parsed.name}"`)
      } catch (e) {
        const msg = `Failed to update specialist "${agent.parsed.name}": ${(e as Error).message}`
        result.errors.push(msg)
        dbLogger.warn(`Sync: ${msg}`)
      }
    }

    // Deactivate removed specialists (if not skipped)
    if (!options?.skipRemoved) {
      for (const specialist of diff.removedSpecialists) {
        try {
          specialistRepository.update(specialist.id, { isActive: false, sourceYaml: null })
          result.deactivated++
          dbLogger.info(`Sync: deactivated specialist "${specialist.agentId}" (YAML removed)`)
        } catch (e) {
          const msg = `Failed to deactivate specialist "${specialist.agentId}": ${(e as Error).message}`
          result.errors.push(msg)
          dbLogger.warn(`Sync: ${msg}`)
        }
      }
    }

    // Link specialists to skills
    this.syncSkillAssignments(workspacePath)

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

  /** Get only deployed workspace agents (not master-only ones) */
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
    const dbSkills = specialistRepository.getSkills(dbRecord.id)
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
    // Look up meta from AGENT_META for icon/color defaults
    const meta = this.getAgentMeta(agent.parsed.name)

    return specialistRepository.create({
      agentId: agent.parsed.name,
      displayName: meta?.displayName ?? this.formatDisplayName(agent.parsed.name),
      icon: meta?.icon ?? '🔧',
      color: meta?.color ?? '#6366F1',
      prompt: agent.bodyContent || agent.parsed.description || '',
      priority: meta?.priority ?? 100,
      sourceYaml: agent.filename
    })
  }

  /** Update an existing specialist from YAML changes */
  private updateSpecialistFromAgent(agent: DiscoveredAgent, dbRecord: Specialist): Specialist {
    return specialistRepository.update(dbRecord.id, {
      prompt: agent.bodyContent || agent.parsed.description || dbRecord.prompt,
      sourceYaml: agent.filename
    })
  }

  /** Import a discovered skill into the DB */
  private importSkillFromDiscovered(discovered: DiscoveredSkill): Skill {
    const filename = `${discovered.name}.md`

    // Check if already exists
    const existing = skillRepository.findByFilename(filename)
    if (existing) return existing

    return skillRepository.create({
      name: discovered.frontmatter?.name ?? this.formatDisplayName(discovered.name),
      description: discovered.frontmatter?.description ?? '',
      filename,
      filePath: join(discovered.dirPath, 'SKILL.md'),
      isActive: true,
      lastUpdatedDate: discovered.lastUpdated ?? undefined
    })
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

      const currentSkills = specialistRepository.getSkills(specialist.id)
      const currentSkillIds = new Set(currentSkills.map((s) => s.id))

      for (const skillRef of agent.parsed.skills) {
        const skill = skillByName.get(skillRef)
        if (skill && !currentSkillIds.has(skill.id)) {
          try {
            specialistRepository.assignSkill(specialist.id, skill.id)
          } catch {
            // Already assigned or constraint issue — ignore
          }
        }
      }
    }
  }

  /** Get agent meta from AGENT_META constant for icon/color/displayName defaults */
  private getAgentMeta(
    agentId: string
  ): { icon: string; color: string; displayName: string; priority: number } | null {
    // Import at runtime to avoid circular deps
    const AGENT_META: Record<string, { icon: string; color: string; displayName: string }> = {
      generalist: { icon: '💬', color: '#6366F1', displayName: 'Generalist' },
      orchestrator: { icon: '🎯', color: '#8B5CF6', displayName: 'Orchestrator' },
      'react-architect': { icon: '⚛️', color: '#61DAFB', displayName: 'React Architect' },
      'dotnet-architect': { icon: '🟣', color: '#512BD4', displayName: '.NET Architect' },
      'electron-architect': { icon: '⚡', color: '#47848F', displayName: 'Electron Architect' },
      'agentic-architect': { icon: '🤖', color: '#D97706', displayName: 'Agentic Architect' },
      'db-architect': { icon: '🗄️', color: '#336791', displayName: 'DB Architect' },
      'ux-ui-specialist': { icon: '🎨', color: '#DB2777', displayName: 'UX/UI Specialist' },
      'git-github-specialist': {
        icon: '🔀',
        color: '#64748B',
        displayName: 'Git/GitHub Specialist'
      },
      'requirements-specialist': {
        icon: '📋',
        color: '#059669',
        displayName: 'Requirements Specialist'
      },
      'code-planner': { icon: '📝', color: '#475569', displayName: 'Code Planner' },
      'execution-planner': { icon: '📅', color: '#DC6843', displayName: 'Execution Planner' },
      'cicd-devops': { icon: '🚀', color: '#DC2626', displayName: 'CI/CD DevOps' },
      'cloud-infrastructure': { icon: '☁️', color: '#0D9488', displayName: 'Cloud Infrastructure' }
    }

    const AGENT_PRIORITIES: Record<string, number> = {
      generalist: 0,
      orchestrator: 1,
      'react-architect': 2,
      'dotnet-architect': 3,
      'electron-architect': 4,
      'agentic-architect': 5,
      'db-architect': 6,
      'ux-ui-specialist': 7,
      'git-github-specialist': 8,
      'requirements-specialist': 9,
      'code-planner': 10,
      'execution-planner': 11,
      'cicd-devops': 12,
      'cloud-infrastructure': 13
    }

    const meta = AGENT_META[agentId]
    if (!meta) return null
    return { ...meta, priority: AGENT_PRIORITIES[agentId] ?? 100 }
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
