import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { deployLogger } from '../logger'
import { specialistRepository } from '../db/repositories/specialist.repository'
import { workspaceDeployService } from './workspace-deploy.service'
import type { MarketplaceSpecialist, Specialist, Skill } from '../../shared/types'

/**
 * Service for marketplace-style specialist deployment.
 *
 * Handles deploying/undeploying individual specialists to a workspace:
 * - Copies YAML files from master → workspace
 * - Symlinks skill directories
 * - Regenerates CLAUDE.md deterministically
 * - Manages DB is_active state
 */
class SpecialistDeployService {
  private readonly CORE_AGENT_IDS = new Set(['generalist', 'generalist-agent'])

  /**
   * Deploy a specialist to the workspace:
   * 1. Copy agent YAML from master to workspace
   * 2. Symlink each attached skill
   * 3. Set is_active = true in DB
   * 4. Regenerate CLAUDE.md
   */
  deploySpecialist(workspacePath: string, specialistId: string): void {
    const specialist = specialistRepository.findById(specialistId)
    if (!specialist) {
      throw new Error(`Specialist not found: ${specialistId}`)
    }
    if (this.CORE_AGENT_IDS.has(specialist.agentId)) {
      throw new Error(`Cannot deploy/undeploy core agent: ${specialist.agentId}`)
    }

    const skills = specialistRepository.getSkills(specialistId)
    const agentFilename = `${specialist.agentId}.yml`

    // 1. Deploy agent YAML
    try {
      workspaceDeployService.deployAgent(workspacePath, agentFilename)
    } catch (error) {
      deployLogger.warn(
        `Agent YAML not found for ${specialist.agentId}, skipping file deploy: ${(error as Error).message}`
      )
    }

    // 2. Deploy each attached skill
    for (const skill of skills) {
      const skillName = this.extractSkillName(skill)
      try {
        workspaceDeployService.deploySkill(workspacePath, skillName)
      } catch (error) {
        deployLogger.warn(`Skill deploy failed for ${skillName}: ${(error as Error).message}`)
      }
    }

    // 3. Set active in DB
    specialistRepository.update(specialistId, { isActive: true })

    // 4. Regenerate CLAUDE.md
    this.regenerateClaudeMd(workspacePath)

    deployLogger.info(
      `Deployed specialist "${specialist.displayName}" (${specialist.agentId}) to ${workspacePath}`
    )
  }

  /**
   * Undeploy a specialist from the workspace:
   * 1. Remove agent YAML from workspace
   * 2. Remove orphan skills (not used by other active specialists)
   * 3. Set is_active = false in DB
   * 4. Regenerate CLAUDE.md
   */
  undeploySpecialist(workspacePath: string, specialistId: string): void {
    const specialist = specialistRepository.findById(specialistId)
    if (!specialist) {
      throw new Error(`Specialist not found: ${specialistId}`)
    }
    if (this.CORE_AGENT_IDS.has(specialist.agentId)) {
      throw new Error(`Cannot undeploy core agent: ${specialist.agentId}`)
    }

    const skills = specialistRepository.getSkills(specialistId)
    const agentFilename = `${specialist.agentId}.yml`

    // 1. Remove agent YAML
    workspaceDeployService.undeployAgent(workspacePath, agentFilename)

    // 2. Find and remove orphan skills
    for (const skill of skills) {
      const skillName = this.extractSkillName(skill)
      // Check if any OTHER active specialist uses this skill
      const usedByOthers = this.isSkillUsedByOtherActiveSpecialists(skill.id, specialistId)
      if (!usedByOthers) {
        workspaceDeployService.undeploySkill(workspacePath, skillName)
      }
    }

    // 3. Set inactive in DB
    specialistRepository.update(specialistId, { isActive: false })

    // 4. Regenerate CLAUDE.md
    this.regenerateClaudeMd(workspacePath)

    deployLogger.info(
      `Undeployed specialist "${specialist.displayName}" (${specialist.agentId}) from ${workspacePath}`
    )
  }

  /**
   * Update specialist configuration (display name, icon, color, etc.)
   */
  updateConfig(
    id: string,
    data: {
      displayName?: string
      icon?: string
      color?: string
      alias?: string | null
      avatarUrl?: string | null
      priority?: number
    }
  ): Specialist {
    return specialistRepository.update(id, data)
  }

  /**
   * Get full marketplace data: all specialists with deploy status for workspace.
   */
  getMarketplaceData(workspacePath: string): MarketplaceSpecialist[] {
    const specialistsWithSkills = specialistRepository.findAllWithSkills()

    return specialistsWithSkills.map((specialist) => {
      const agentFilename = `${specialist.agentId}.yml`
      const agentPath = join(workspacePath, '.claude', 'agents', agentFilename)
      const isDeployed = existsSync(agentPath)

      // Extract model and tools from sourceYaml if available
      const { model, tools, description } = this.parseSpecialistMeta(specialist)

      return {
        id: specialist.id,
        agentId: specialist.agentId,
        displayName: specialist.displayName,
        description,
        icon: specialist.icon,
        color: specialist.color,
        model,
        tools,
        skills: specialist.skills,
        isActive: specialist.isActive,
        isDeployed,
        alias: specialist.alias,
        avatarUrl: specialist.avatarUrl,
        pixelSpriteId: specialist.pixelSpriteId,
        usePixelForChat: specialist.usePixelForChat ?? false,
        priority: specialist.priority,
        isCore: specialist.isCore ?? false
      }
    })
  }

  /**
   * Deploy all specialists to workspace at once.
   */
  deployAll(workspacePath: string): void {
    const specialists = specialistRepository.findAll()
    for (const specialist of specialists) {
      if (!specialist.isActive) {
        try {
          this.deploySpecialist(workspacePath, specialist.id)
        } catch (error) {
          deployLogger.warn(`Failed to deploy ${specialist.agentId}: ${(error as Error).message}`)
        }
      }
    }
  }

  // ── Private Helpers ──

  /**
   * Extract the skill directory name from a skill record.
   * The filename is like "electron-pro.md" → skill dir is "electron-pro".
   * The filePath is like ".claude/skills/electron-pro/SKILL.md" → extract dir name.
   */
  private extractSkillName(skill: Skill): string {
    // Prefer extracting from filePath
    const match = skill.filePath.match(/skills\/([^/]+)\//)
    if (match) return match[1]
    // Fallback: strip extension from filename
    return skill.filename.replace(/\.md$/, '')
  }

  /**
   * Check if a skill is used by any other ACTIVE specialist (excluding the given one).
   */
  private isSkillUsedByOtherActiveSpecialists(
    skillId: string,
    excludeSpecialistId: string
  ): boolean {
    const specialists = specialistRepository.findSpecialistsForSkill(skillId)
    return specialists.some((s) => s.id !== excludeSpecialistId && s.isActive)
  }

  /**
   * Regenerate CLAUDE.md using the existing deterministic generator.
   * This scans deployed workspace agents/skills and rebuilds the auto-generated sections.
   */
  private regenerateClaudeMd(workspacePath: string): void {
    try {
      const agents = workspaceDeployService.scanWorkspaceAgents(workspacePath)
      const skills = workspaceDeployService.scanWorkspaceSkills(workspacePath)

      // Collect all referenced skill names from deployed agents
      const referencedSkills = new Set<string>()
      for (const agent of agents) {
        for (const skillRef of agent.parsed.skills) {
          referencedSkills.add(skillRef)
        }
      }

      // Read existing CLAUDE.md
      let existingContent: string | null = null
      try {
        existingContent = workspaceDeployService.readWorkspaceFile(join(workspacePath, 'CLAUDE.md'))
      } catch {
        // No existing CLAUDE.md — that's fine
      }

      // Generate new content using deterministic method (via activateAgents flow)
      // We use the workspace deploy service's generateClaudeMdDeterministic indirectly
      // by writing the content ourselves using the same pattern
      const sections: string[] = []

      // Preserve existing project content (strip old auto-generated sections)
      if (existingContent) {
        let cleaned = existingContent
        // Strip ## Agents section
        cleaned = cleaned.replace(
          /\n*## Agents\s*\n<!-- AUTO-GENERATED[^]*?(?=\n## (?!Agents|Skills)|\n*$)/,
          ''
        )
        // Strip ## Skills section
        cleaned = cleaned.replace(
          /\n*## Skills\s*\n<!-- AUTO-GENERATED[^]*?(?=\n## (?!Agents|Skills)|\n*$)/,
          ''
        )
        if (cleaned.trim()) {
          sections.push(cleaned.trim())
        }
      }

      // Build agents table
      if (agents.length > 0) {
        const agentRows = agents
          .map((a) => {
            const skillNames = a.parsed.skills.length > 0 ? a.parsed.skills.join(', ') : 'none'
            return `| \`${a.parsed.name}\` | ${a.parsed.description || a.parsed.name} | ${skillNames} |`
          })
          .join('\n')

        sections.push(`## Agents

<!-- AUTO-GENERATED by Agent Studio — do not edit manually -->

| Agent | Description | Skills |
|-------|-------------|--------|
${agentRows}`)
      }

      // Build skills table
      if (referencedSkills.size > 0) {
        const skillRows = [...referencedSkills]
          .map((name) => {
            const skill = skills.find((s) => s.name === name)
            const description = skill?.frontmatter?.description || 'No description'
            return `| \`${name}\` | ${description} | \`.claude/skills/${name}/SKILL.md\` |`
          })
          .join('\n')

        sections.push(`## Skills

<!-- AUTO-GENERATED by Agent Studio — do not edit manually -->

| Skill | Description | Path |
|-------|-------------|------|
${skillRows}`)
      }

      const newContent = sections.join('\n\n')
      workspaceDeployService.confirmClaudeMd(workspacePath, newContent)

      deployLogger.info(`Regenerated CLAUDE.md for ${workspacePath}`)
    } catch (error) {
      deployLogger.error(`Failed to regenerate CLAUDE.md: ${(error as Error).message}`)
    }
  }

  /**
   * Parse model, tools, and description from specialist's sourceYaml or YAML frontmatter.
   */
  private parseSpecialistMeta(specialist: Specialist): {
    model: string
    tools: string[]
    description: string
  } {
    const result = {
      model: 'sonnet',
      tools: [] as string[],
      description: specialist.prompt || `${specialist.displayName} specialist agent`
    }

    if (!specialist.sourceYaml) return result

    try {
      // Simple YAML parsing for model and tools
      const modelMatch = specialist.sourceYaml.match(/model:\s*(.+)/)
      if (modelMatch) {
        const modelValue = modelMatch[1].trim()
        if (modelValue.includes('opus')) result.model = 'opus'
        else if (modelValue.includes('haiku')) result.model = 'haiku'
        else result.model = 'sonnet'
      }

      const toolsMatch = specialist.sourceYaml.match(/allowed_tools:\s*\n((?:\s+-\s+.+\n?)+)/)
      if (toolsMatch) {
        result.tools = toolsMatch[1]
          .split('\n')
          .map((line) => line.replace(/^\s+-\s+/, '').trim())
          .filter(Boolean)
      }

      // Extract description from YAML frontmatter
      const descMatch = specialist.sourceYaml.match(/description:\s*(.+)/)
      if (descMatch) {
        result.description = descMatch[1].trim().replace(/^["']|["']$/g, '')
      }
    } catch {
      // Silently ignore parse errors
    }

    return result
  }
}

export const specialistDeployService = new SpecialistDeployService()
