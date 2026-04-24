import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  rmSync,
  renameSync,
  symlinkSync,
  lstatSync
} from 'node:fs'
import { join } from 'node:path'
import { deployLogger } from '../logger'
import { specialistRepository } from '../db/repositories/specialist.repository'
import { skillRepository } from '../db/repositories/skill.repository'
import type {
  DiscoveredSkill,
  DiscoveredAgent,
  WorkspaceClaudeStatus,
  ActivationResult,
  ActivationProgressEvent
} from '../../shared/types'

/** Simple YAML frontmatter parser for agent YAML files */
function parseAgentYaml(content: string): {
  frontmatter: Record<string, unknown>
  body: string
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return { frontmatter: {}, body: content }
  }

  const frontmatterRaw = match[1]
  const body = match[2].trim()
  const frontmatter: Record<string, unknown> = {}

  // Parse simple YAML key-value pairs
  let currentKey = ''
  let currentValue = ''
  let isMultiline = false

  for (const line of frontmatterRaw.split('\n')) {
    if (isMultiline) {
      if (line.startsWith('  ') || line.startsWith('\t')) {
        currentValue += ' ' + line.trim()
        continue
      } else {
        frontmatter[currentKey] = currentValue.trim()
        isMultiline = false
      }
    }

    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (kvMatch) {
      currentKey = kvMatch[1]
      const val = kvMatch[2].trim()

      if (val === '>' || val === '|') {
        isMultiline = true
        currentValue = ''
      } else if (val.startsWith('[') && val.endsWith(']')) {
        // Parse inline array: [item1, item2, ...]
        frontmatter[currentKey] = val
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      } else {
        frontmatter[currentKey] = val
      }
    }
  }

  if (isMultiline) {
    frontmatter[currentKey] = currentValue.trim()
  }

  return { frontmatter, body }
}

/** Parse SKILL.md frontmatter for name/description */
function parseSkillMdFrontmatter(content: string): { name?: string; description?: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null

  const result: { name?: string; description?: string } = {}
  let currentKey = ''
  let currentValue = ''
  let isMultiline = false

  for (const line of match[1].split('\n')) {
    if (isMultiline) {
      if (line.startsWith('  ') || line.startsWith('\t')) {
        currentValue += ' ' + line.trim()
        continue
      } else {
        if (currentKey === 'name') result.name = currentValue.trim()
        if (currentKey === 'description') result.description = currentValue.trim()
        isMultiline = false
      }
    }

    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (kvMatch) {
      currentKey = kvMatch[1]
      const val = kvMatch[2].trim()
      if (val === '>' || val === '|') {
        isMultiline = true
        currentValue = ''
      } else {
        if (currentKey === 'name') result.name = val
        if (currentKey === 'description') result.description = val
      }
    }
  }

  if (isMultiline) {
    if (currentKey === 'name') result.name = currentValue.trim()
    if (currentKey === 'description') result.description = currentValue.trim()
  }

  return result
}

/** Extract "Last updated: YYYY-MM-DD" from SKILL.md content */
function extractLastUpdated(content: string): string | null {
  const match = content.match(/Last updated:\s*(\d{4}-\d{2}-\d{2})/i)
  return match ? match[1] : null
}

export class WorkspaceDeployService {
  // currentAbortController removed — activation is now deterministic (no LLM process to abort)

  /** Get Agent Studio's master .claude/ directory */
  private getMasterClaudeDir(): string {
    return join(process.cwd(), '.claude')
  }

  // ── Scanning ──

  /** Scan workspace's .claude/ directory status */
  scanWorkspaceClaude(workspacePath: string): WorkspaceClaudeStatus {
    const claudeDir = join(workspacePath, '.claude')
    const claudeMdPath = join(workspacePath, 'CLAUDE.md')
    const agentsDir = join(claudeDir, 'agents')
    const skillsDir = join(claudeDir, 'skills')

    const hasClaudeDir = existsSync(claudeDir)
    const hasClaudeMd = existsSync(claudeMdPath)
    const hasAgentsDir = existsSync(agentsDir)
    const hasSkillsDir = existsSync(skillsDir)

    const deployedAgents: string[] = []
    if (hasAgentsDir) {
      try {
        const files = readdirSync(agentsDir)
        for (const f of files) {
          if (f.endsWith('.yml') || f.endsWith('.yaml')) {
            deployedAgents.push(f)
          }
        }
      } catch {
        /* ignore read error */
      }
    }

    const deployedSkills: string[] = []
    if (hasSkillsDir) {
      try {
        const entries = readdirSync(skillsDir, { withFileTypes: true })
        for (const e of entries) {
          if (e.isDirectory()) {
            deployedSkills.push(e.name)
          }
        }
      } catch {
        /* ignore read error */
      }
    }

    let claudeMdPreview: string | null = null
    if (hasClaudeMd) {
      try {
        const content = readFileSync(claudeMdPath, 'utf-8')
        claudeMdPreview = content.substring(0, 500)
      } catch {
        /* ignore */
      }
    }

    return {
      hasClaudeDir,
      hasClaudeMd,
      hasAgentsDir,
      hasSkillsDir,
      deployedAgents,
      deployedSkills,
      claudeMdPreview
    }
  }

  /**
   * Scan Agent Studio's master .claude/skills/ directory.
   * Skills still live as files in .claude/skills/ — this remains functional.
   */
  scanMasterSkills(): DiscoveredSkill[] {
    const skillsDir = join(this.getMasterClaudeDir(), 'skills')
    if (!existsSync(skillsDir)) return []

    return this.scanSkillsDirectory(skillsDir, 'master')
  }

  /** Scan target workspace's deployed agents */
  scanWorkspaceAgents(workspacePath: string): DiscoveredAgent[] {
    const agentsDir = join(workspacePath, '.claude', 'agents')
    if (!existsSync(agentsDir)) return []

    const agents: DiscoveredAgent[] = []
    try {
      const files = readdirSync(agentsDir)
      for (const f of files) {
        if (!f.endsWith('.yml') && !f.endsWith('.yaml')) continue

        const filePath = join(agentsDir, f)
        try {
          const content = readFileSync(filePath, 'utf-8')
          const { frontmatter, body } = parseAgentYaml(content)

          agents.push({
            filename: f,
            filePath,
            parsed: {
              name: (frontmatter.name as string) ?? f.replace(/\.ya?ml$/, ''),
              description: (frontmatter.description as string) ?? '',
              model: (frontmatter.model as string) ?? 'sonnet',
              tools: Array.isArray(frontmatter.tools) ? (frontmatter.tools as string[]) : [],
              skills: Array.isArray(frontmatter.skills) ? (frontmatter.skills as string[]) : []
            },
            bodyContent: body,
            isActive: true,
            isDeployed: true,
            source: 'workspace'
          })
        } catch {
          /* skip */
        }
      }
    } catch {
      /* ignore */
    }

    // Enrich with DB specialist info (accurate isActive + specialistId)
    try {
      for (const agent of agents) {
        const specialist = specialistRepository.findByAgentId(agent.parsed.name)
        if (specialist) {
          agent.specialistId = specialist.id
          agent.isActive = specialist.isActive
        } else {
          agent.isActive = false
        }
      }
    } catch {
      // DB not ready — leave isActive as-is
    }

    // Filter out deprecated orchestrator agent
    return agents.filter((a) => a.parsed.name !== 'orchestrator')
  }

  /** Scan target workspace's deployed skills */
  scanWorkspaceSkills(workspacePath: string): DiscoveredSkill[] {
    const skillsDir = join(workspacePath, '.claude', 'skills')
    if (!existsSync(skillsDir)) return []

    const workspaceSkills = this.scanSkillsDirectory(skillsDir, 'workspace')

    // Also include master skills that are NOT deployed
    const masterSkills = this.scanMasterSkills()
    const deployedNames = new Set(workspaceSkills.map((s) => s.name))
    for (const master of masterSkills) {
      if (!deployedNames.has(master.name)) {
        workspaceSkills.push({
          ...master,
          isActive: false,
          source: 'master'
        })
      }
    }

    return workspaceSkills
  }

  /** Common skill directory scanner */
  private scanSkillsDirectory(
    skillsDir: string,
    source: 'master' | 'workspace'
  ): DiscoveredSkill[] {
    const skills: DiscoveredSkill[] = []

    try {
      const entries = readdirSync(skillsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const dirPath = join(skillsDir, entry.name)
        const skillMdPath = join(dirPath, 'SKILL.md')
        const hasSkillMd = existsSync(skillMdPath)

        let frontmatter: { name?: string; description?: string } | null = null
        let lastUpdated: string | null = null

        if (hasSkillMd) {
          try {
            const content = readFileSync(skillMdPath, 'utf-8')
            frontmatter = parseSkillMdFrontmatter(content)
            lastUpdated = extractLastUpdated(content)
          } catch {
            /* ignore */
          }
        }

        // Scan references/ subdirectory
        const referenceFiles: string[] = []
        const refsDir = join(dirPath, 'references')
        if (existsSync(refsDir)) {
          try {
            const refs = readdirSync(refsDir)
            referenceFiles.push(...refs.filter((r) => !r.startsWith('.')))
          } catch {
            /* ignore */
          }
        }

        skills.push({
          name: entry.name,
          dirPath,
          hasSkillMd,
          referenceFiles,
          frontmatter,
          isActive: source === 'workspace',
          lastUpdated,
          source
        })
      }
    } catch {
      /* ignore */
    }

    return skills
  }

  // ── File Operations ──

  /** Read any file from workspace (for the content viewer) */
  readWorkspaceFile(filePath: string): string {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`)
    }
    return readFileSync(filePath, 'utf-8')
  }

  /** Write file back to workspace (for the editor) */
  writeWorkspaceFile(filePath: string, content: string): void {
    writeFileSync(filePath, content, 'utf-8')
  }

  // ── Deployment ──

  /** Remove a single agent YAML from workspace */
  undeployAgent(workspacePath: string, agentFilename: string): void {
    const targetPath = join(workspacePath, '.claude', 'agents', agentFilename)
    if (existsSync(targetPath)) {
      unlinkSync(targetPath)
    }
  }

  /** Copy a skill directory (with references/) to workspace */
  deploySkill(workspacePath: string, skillName: string): void {
    const masterDir = join(this.getMasterClaudeDir(), 'skills', skillName)
    const targetDir = join(workspacePath, '.claude', 'skills', skillName)

    if (!existsSync(masterDir)) {
      throw new Error(`Skill not found in master: ${skillName}`)
    }

    // Use symlink instead of recursive copy — edits to master are reflected instantly
    try {
      // Remove existing target (could be a stale symlink, old copy, or broken link)
      if (existsSync(targetDir) || this.isSymlink(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true })
      }
      symlinkSync(masterDir, targetDir, 'dir')
      deployLogger.debug(`Symlinked skill: ${masterDir} → ${targetDir}`)
    } catch (symlinkErr) {
      // Fallback to copy if symlink fails (e.g. cross-device, permissions)
      deployLogger.warn(
        `Symlink failed for skill "${skillName}", falling back to copy: ${(symlinkErr as Error).message}`
      )
      this.copyDirRecursive(masterDir, targetDir)
    }
  }

  /** Check if a path is a symlink (even if broken) */
  private isSymlink(targetPath: string): boolean {
    try {
      const stats = lstatSync(targetPath)
      return stats.isSymbolicLink()
    } catch {
      return false
    }
  }

  /** Remove a skill directory (or symlink) from workspace */
  undeploySkill(workspacePath: string, skillName: string): void {
    const targetDir = join(workspacePath, '.claude', 'skills', skillName)
    if (existsSync(targetDir) || this.isSymlink(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true })
    }
  }

  // ── Individual Agent/Skill Delete & Sync ──

  /** Delete a single agent from workspace: remove YAML, clean CLAUDE.md references, remove DB record */
  deleteAgentFromWorkspace(workspacePath: string, filename: string): void {
    // 1. Remove agent YAML from workspace
    this.undeployAgent(workspacePath, filename)

    // 2. Remove agent references from workspace CLAUDE.md
    this.removeFromClaudeMd(workspacePath, filename.replace(/\.ya?ml$/, ''))

    deployLogger.info(`Deleted agent from workspace: ${filename} in ${workspacePath}`)
  }

  /** Sync a single agent to workspace: update CLAUDE.md, upsert DB record */
  syncAgentToWorkspace(workspacePath: string, filename: string): void {
    // 1. Add agent reference to workspace CLAUDE.md
    const agentName = filename.replace(/\.ya?ml$/, '')
    this.addToClaudeMd(workspacePath, 'agent', agentName)

    deployLogger.info(`Synced agent to workspace: ${filename} in ${workspacePath}`)
  }

  /** Delete a single skill from workspace: remove skill dir, clean CLAUDE.md references, remove DB record */
  deleteSkillFromWorkspace(workspacePath: string, skillName: string): void {
    // 1. Remove skill directory from workspace
    this.undeploySkill(workspacePath, skillName)

    // 2. Remove skill references from workspace CLAUDE.md
    this.removeFromClaudeMd(workspacePath, skillName)

    deployLogger.info(`Deleted skill from workspace: ${skillName} in ${workspacePath}`)
  }

  /** Sync a single skill to workspace: copy skill dir from master, update CLAUDE.md, upsert DB record */
  syncSkillToWorkspace(workspacePath: string, skillName: string): void {
    // 1. Copy skill directory from master to workspace
    this.deploySkill(workspacePath, skillName)

    // 2. Add skill reference to workspace CLAUDE.md
    this.addToClaudeMd(workspacePath, 'skill', skillName)

    deployLogger.info(`Synced skill to workspace: ${skillName} in ${workspacePath}`)
  }

  /** Remove references to an agent or skill name from workspace CLAUDE.md */
  private removeFromClaudeMd(workspacePath: string, name: string): void {
    const claudeMdPath = join(workspacePath, 'CLAUDE.md')
    if (!existsSync(claudeMdPath)) return

    try {
      let content = readFileSync(claudeMdPath, 'utf-8')
      const original = content

      // Remove lines containing the agent/skill name (common patterns in CLAUDE.md)
      // e.g. references like "| `skill-name` | ..." or "- skill-name" or agent YAML references
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const patterns = [
        // Table row: | `name` | ... |
        new RegExp(`^\\|[^|]*\`${escapedName}\`[^|]*\\|.*$\\n?`, 'gm'),
        // List item: - name or * name
        new RegExp(`^\\s*[-*]\\s+\`?${escapedName}\`?\\s*.*$\\n?`, 'gm')
      ]

      for (const pattern of patterns) {
        content = content.replace(pattern, '')
      }

      if (content !== original) {
        // Clean up any double blank lines left behind
        content = content.replace(/\n{3,}/g, '\n\n')
        writeFileSync(claudeMdPath, content, 'utf-8')
        deployLogger.info(`Removed references to "${name}" from CLAUDE.md`)
      }
    } catch (err) {
      deployLogger.warn(`Failed to clean CLAUDE.md for "${name}": ${(err as Error).message}`)
    }
  }

  /** Add a reference to an agent or skill in workspace CLAUDE.md */
  private addToClaudeMd(workspacePath: string, type: 'agent' | 'skill', name: string): void {
    const claudeMdPath = join(workspacePath, 'CLAUDE.md')
    if (!existsSync(claudeMdPath)) return

    try {
      const content = readFileSync(claudeMdPath, 'utf-8')

      // Check if already referenced
      if (content.includes(name)) {
        return // Already referenced
      }

      // Determine the section to append to
      const sectionHeader = type === 'agent' ? '### Available agents' : '### Available skills'
      const sectionIndex = content.indexOf(sectionHeader)

      if (sectionIndex === -1) {
        // No dedicated section found — append a note at the end
        const reference =
          type === 'agent'
            ? `\n\n### Available agents\n\n| Agent | Path |\n|-------|------|\n| \`${name}\` | \`.claude/agents/${name}.yml\` |\n`
            : `\n\n### Available skills\n\n| Skill | Path |\n|-------|------|\n| \`${name}\` | \`.claude/skills/${name}/SKILL.md\` |\n`
        writeFileSync(claudeMdPath, content + reference, 'utf-8')
      } else {
        // Find the end of the table in that section and append a row
        const afterSection = content.substring(sectionIndex)
        // Find the last table row in the section (before the next heading or EOF)
        const nextHeading = afterSection.search(/\n##[^#]/)
        const sectionEnd = nextHeading === -1 ? content.length : sectionIndex + nextHeading

        const newRow =
          type === 'agent'
            ? `| \`${name}\` | \`.claude/agents/${name}.yml\` | — |\n`
            : `| \`${name}\` | \`.claude/skills/${name}/SKILL.md\` | — |\n`

        const updated = content.substring(0, sectionEnd) + newRow + content.substring(sectionEnd)
        writeFileSync(claudeMdPath, updated, 'utf-8')
      }

      deployLogger.info(`Added ${type} "${name}" reference to CLAUDE.md`)
    } catch (err) {
      deployLogger.warn(
        `Failed to update CLAUDE.md for ${type} "${name}": ${(err as Error).message}`
      )
    }
  }

  /** Remove all deployed agents, skills, and optionally CLAUDE.md from the workspace */
  cleanActivation(workspacePath: string, removeClaudeMd = false): void {
    const agentsDir = join(workspacePath, '.claude', 'agents')
    const skillsDir = join(workspacePath, '.claude', 'skills')

    if (existsSync(agentsDir)) {
      rmSync(agentsDir, { recursive: true, force: true })
    }
    if (existsSync(skillsDir)) {
      rmSync(skillsDir, { recursive: true, force: true })
    }
    if (removeClaudeMd) {
      const claudeMdPath = join(workspacePath, 'CLAUDE.md')
      if (existsSync(claudeMdPath)) {
        unlinkSync(claudeMdPath)
      }
    }

    deployLogger.info(
      `Cleaned activation for workspace: ${workspacePath} (removeClaudeMd: ${removeClaudeMd})`
    )
  }

  /** Recursive directory copy */
  private copyDirRecursive(src: string, dest: string): void {
    mkdirSync(dest, { recursive: true })
    const entries = readdirSync(src, { withFileTypes: true })

    for (const entry of entries) {
      const srcPath = join(src, entry.name)
      const destPath = join(dest, entry.name)

      if (entry.isDirectory()) {
        this.copyDirRecursive(srcPath, destPath)
      } else {
        copyFileSync(srcPath, destPath)
      }
    }
  }

  // ── Activation Flow ──

  /**
   * Full activation: activate all DB specialists, sync workspace, generate CLAUDE.md.
   * Skills are NOT deployed during activation — users opt-in later.
   */
  async activateAgents(
    workspacePath: string,
    onProgress?: (event: ActivationProgressEvent) => void
  ): Promise<ActivationResult> {
    const emit = (type: ActivationProgressEvent['type'], message: string): void => {
      onProgress?.({ type, message, timestamp: Date.now() })
    }

    // Ensure .claude/ directories exist
    const agentsDir = join(workspacePath, '.claude', 'agents')
    const skillsDir = join(workspacePath, '.claude', 'skills')
    mkdirSync(agentsDir, { recursive: true })
    mkdirSync(skillsDir, { recursive: true })

    // ── STEP 1: Auto-sync workspace entries into DB ──
    emit('status', 'Syncing workspace entries...')
    try {
      const { agentSyncService } = await import('./agent-sync.service')
      const syncResult = agentSyncService.autoSyncNewEntries(workspacePath)
      if (syncResult.imported > 0 || syncResult.skillsImported > 0) {
        emit(
          'status',
          `Synced ${syncResult.imported} specialists and ${syncResult.skillsImported} skills to database`
        )
      }
    } catch (e) {
      deployLogger.warn('Auto-sync after activation failed:', e)
    }

    // Scan workspace agents/skills for CLAUDE.md generation
    const workspaceAgents = this.scanWorkspaceAgents(workspacePath)
    const masterSkills = this.scanMasterSkills()

    // Collect referenced skills from workspace agents
    const referencedSkills = new Set<string>()
    for (const agent of workspaceAgents) {
      for (const skillRef of agent.parsed.skills) {
        referencedSkills.add(skillRef)
      }
    }

    // ── STEP 2: Generate merged CLAUDE.md deterministically (no LLM call) ──
    emit('status', 'Generating CLAUDE.md...')
    const claudeMdPath = join(workspacePath, 'CLAUDE.md')
    let existingClaudeMd: string | null = null
    if (existsSync(claudeMdPath)) {
      try {
        existingClaudeMd = readFileSync(claudeMdPath, 'utf-8')
      } catch {
        /* ignore */
      }
    }

    const mergedClaudeMd = this.generateClaudeMdDeterministic(
      existingClaudeMd,
      workspaceAgents,
      masterSkills,
      referencedSkills
    )

    // ── STEP 3: Detect tech stack and recommend specialists ──
    emit('status', 'Detecting tech stack...')
    let detectedTechs: string[] | undefined
    let recommendedSpecialists: string[] | undefined
    try {
      const { detectTechStack } = await import('./tech-stack-detector.service')
      const techResult = detectTechStack(workspacePath)
      detectedTechs = techResult.detectedTechs
      recommendedSpecialists = techResult.recommendedSpecialists
      if (detectedTechs.length > 0) {
        emit('status', `Detected: ${detectedTechs.join(', ')}`)
      }
    } catch (e) {
      deployLogger.warn('Tech-stack detection failed:', e)
    }

    emit('status', 'Activation complete!')
    return {
      success: true,
      selectedAgents: workspaceAgents.map((a) => a.filename),
      selectedSkills: [],
      existingClaudeMd,
      proposedClaudeMd: mergedClaudeMd,
      claudeMdWritten: false,
      detectedTechs,
      recommendedSpecialists
    }
  }

  /**
   * Generate CLAUDE.md content deterministically from templates.
   * No LLM call needed — assembles from existing content + agent/skill listings.
   */
  private generateClaudeMdDeterministic(
    existingContent: string | null,
    agents: DiscoveredAgent[],
    allSkills: DiscoveredSkill[],
    referencedSkills: Set<string>
  ): string {
    const sections: string[] = []

    // Preserve existing project content (strip old agent/skill sections if present)
    if (existingContent) {
      const cleaned = this.stripGeneratedSections(existingContent)
      if (cleaned.trim()) {
        sections.push(cleaned.trim())
      }
    }

    // Build agents table
    const agentRows = agents
      .map((a) => {
        const skills = a.parsed.skills.length > 0 ? a.parsed.skills.join(', ') : 'none'
        return `| \`${a.parsed.name}\` | ${a.parsed.description || a.parsed.name} | ${skills} |`
      })
      .join('\n')

    sections.push(`## Agents

<!-- AUTO-GENERATED by Agent Studio — do not edit manually -->

| Agent | Description | Skills |
|-------|-------------|--------|
${agentRows}`)

    // Build skills table
    const skillRows = [...referencedSkills]
      .map((name) => {
        const skill = allSkills.find((s) => s.name === name)
        const description = skill?.frontmatter?.description || 'No description'
        return `| \`${name}\` | ${description} | \`.claude/skills/${name}/SKILL.md\` |`
      })
      .join('\n')

    sections.push(`## Skills

<!-- AUTO-GENERATED by Agent Studio — do not edit manually -->

| Skill | Description | Path |
|-------|-------------|------|
${skillRows}`)

    return sections.join('\n\n')
  }

  /**
   * Strip auto-generated ## Agents and ## Skills sections from existing CLAUDE.md content.
   * Preserves all user-written sections.
   */
  private stripGeneratedSections(content: string): string {
    // Remove ## Agents section (from header to next ## or EOF)
    let result = content.replace(
      /\n*## Agents\s*\n<!-- AUTO-GENERATED[^]*?(?=\n## (?!Agents|Skills)|\n*$)/,
      ''
    )
    // Remove ## Skills section
    result = result.replace(
      /\n*## Skills\s*\n<!-- AUTO-GENERATED[^]*?(?=\n## (?!Agents|Skills)|\n*$)/,
      ''
    )
    return result
  }

  /** Write approved CLAUDE.md content to disk atomically */
  confirmClaudeMd(workspacePath: string, content: string): void {
    const claudeMdPath = join(workspacePath, 'CLAUDE.md')
    const tmpPath = claudeMdPath + '.tmp'
    writeFileSync(tmpPath, content, 'utf-8')
    renameSync(tmpPath, claudeMdPath)
  }

  // ── Activate / Deactivate / Delete All / Deploy All ──

  /** Activate agent: set DB is_active=true, add to CLAUDE.md */
  activateAgent(workspacePath: string, agentName: string): void {
    const specialist = specialistRepository.findByAgentId(agentName)
    if (specialist) {
      specialistRepository.update(specialist.id, { isActive: true })
    }
    this.addToClaudeMd(workspacePath, 'agent', agentName)
    deployLogger.info(`Activated agent: ${agentName}`)
  }

  /** Deactivate agent: set DB is_active=false, remove from CLAUDE.md */
  deactivateAgent(workspacePath: string, agentName: string): void {
    const specialist = specialistRepository.findByAgentId(agentName)
    if (specialist) {
      specialistRepository.update(specialist.id, { isActive: false })
    }
    this.removeFromClaudeMd(workspacePath, agentName)
    deployLogger.info(`Deactivated agent: ${agentName}`)
  }

  /** Delete all agents from workspace: rm .claude/agents/, delete all DB specialist records */
  deleteAllAgents(workspacePath: string): void {
    const agentsDir = join(workspacePath, '.claude', 'agents')
    if (existsSync(agentsDir)) {
      rmSync(agentsDir, { recursive: true, force: true })
    }
    specialistRepository.deleteAll()
    deployLogger.info(`Deleted all agents from workspace: ${workspacePath}`)
  }

  /** Delete all skills from workspace: rm .claude/skills/, delete all DB skill records */
  deleteAllSkills(workspacePath: string): void {
    const skillsDir = join(workspacePath, '.claude', 'skills')
    if (existsSync(skillsDir)) {
      rmSync(skillsDir, { recursive: true, force: true })
    }
    skillRepository.deleteAll()
    deployLogger.info(`Deleted all skills from workspace: ${workspacePath}`)
  }

  /**
   * Activate all specialists in the DB for a workspace.
   * Skills are NOT deployed during bulk activation — users opt-in to skills later.
   * Agent YAMLs are no longer copied (DB is source of truth).
   */
  async deployAllInactive(workspacePath: string): Promise<{ agents: number; skills: number }> {
    // Ensure .claude/ directories exist for workspace compatibility
    mkdirSync(join(workspacePath, '.claude', 'agents'), { recursive: true })
    mkdirSync(join(workspacePath, '.claude', 'skills'), { recursive: true })

    // Remove deprecated orchestrator YAML if present
    const orchestratorPath = join(workspacePath, '.claude', 'agents', 'orchestrator.yml')
    if (existsSync(orchestratorPath)) {
      unlinkSync(orchestratorPath)
    }

    // Auto-sync any new entries from workspace to DB
    const { agentSyncService } = await import('./agent-sync.service')
    agentSyncService.autoSyncNewEntries(workspacePath)

    // Post-migration-66: specialist deployment to YAML files is no longer a thing —
    // every workspace has a single Project Specialist managed via SpecialistBuilder.
    // Return a count of the workspace's specialists purely for UI feedback.
    const { specialistRepository: specRepo } =
      await import('../db/repositories/specialist.repository')
    const allSpecialists = specRepo.findAll()
    const agentCount = allSpecialists.filter((s) => s.isActive).length

    return { agents: agentCount, skills: 0 }
  }

  /** Shutdown — no-op (activation is now deterministic, no background process to cancel) */
  shutdown(): void {
    // Intentionally empty — kept for API compatibility
  }
}

export const workspaceDeployService = new WorkspaceDeployService()
