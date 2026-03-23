import { spawn } from 'node:child_process'
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  rmSync,
  renameSync
} from 'node:fs'
import { join } from 'node:path'
import { ACTIVATION_MODEL_ID } from '../../shared/constants'
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
  private currentAbortController: AbortController | null = null

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

  /** Scan Agent Studio's master .claude/agents/ directory */
  scanMasterAgents(): DiscoveredAgent[] {
    const agentsDir = join(this.getMasterClaudeDir(), 'agents')
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
            isDeployed: false,
            source: 'master'
          })
        } catch {
          /* skip unreadable files */
        }
      }
    } catch {
      /* ignore */
    }

    return agents
  }

  /** Scan Agent Studio's master .claude/skills/ directory */
  scanMasterSkills(): DiscoveredSkill[] {
    const skillsDir = join(this.getMasterClaudeDir(), 'skills')
    if (!existsSync(skillsDir)) return []

    return this.scanSkillsDirectory(skillsDir, 'master')
  }

  /** Scan target workspace's deployed agents */
  scanWorkspaceAgents(workspacePath: string): DiscoveredAgent[] {
    const agentsDir = join(workspacePath, '.claude', 'agents')
    if (!existsSync(agentsDir)) return []

    // Get master agents for comparison
    const masterAgents = this.scanMasterAgents()
    const masterFilenames = new Set(masterAgents.map((a) => a.filename))

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
            source: masterFilenames.has(f) ? 'master' : 'workspace'
          })
        } catch {
          /* skip */
        }
      }
    } catch {
      /* ignore */
    }

    // Also include master agents that are NOT deployed (for the full list view)
    const deployedFilenames = new Set(agents.map((a) => a.filename))
    for (const master of masterAgents) {
      if (!deployedFilenames.has(master.filename)) {
        agents.push({
          ...master,
          isDeployed: false
        })
      }
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

    return agents
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

  /** Copy a single agent YAML to workspace */
  deployAgent(workspacePath: string, agentFilename: string): void {
    const masterPath = join(this.getMasterClaudeDir(), 'agents', agentFilename)
    const targetDir = join(workspacePath, '.claude', 'agents')
    const targetPath = join(targetDir, agentFilename)

    if (!existsSync(masterPath)) {
      throw new Error(`Agent file not found in master: ${agentFilename}`)
    }

    mkdirSync(targetDir, { recursive: true })
    copyFileSync(masterPath, targetPath)
  }

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

    this.copyDirRecursive(masterDir, targetDir)
  }

  /** Remove a skill directory from workspace */
  undeploySkill(workspacePath: string, skillName: string): void {
    const targetDir = join(workspacePath, '.claude', 'skills', skillName)
    if (existsSync(targetDir)) {
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

  /** Sync a single agent to workspace: copy YAML from master, update CLAUDE.md, upsert DB record */
  syncAgentToWorkspace(workspacePath: string, filename: string): void {
    // 1. Copy agent YAML from master to workspace
    this.deployAgent(workspacePath, filename)

    // 2. Add agent reference to workspace CLAUDE.md
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

  /** Full activation: Opus analyzes project, selects agents, copies files, merges CLAUDE.md */
  async activateAgents(
    workspacePath: string,
    onProgress?: (event: ActivationProgressEvent) => void
  ): Promise<ActivationResult> {
    const emit = (type: ActivationProgressEvent['type'], message: string): void => {
      onProgress?.({ type, message, timestamp: Date.now() })
    }

    // ── STEP 1: Deploy all agents & skills (deterministic, no LLM) ──
    emit('status', 'Scanning master agents and skills...')
    const masterAgents = this.scanMasterAgents()
    const masterSkills = this.scanMasterSkills()

    // Create directories
    const agentsDir = join(workspacePath, '.claude', 'agents')
    const skillsDir = join(workspacePath, '.claude', 'skills')
    mkdirSync(agentsDir, { recursive: true })
    mkdirSync(skillsDir, { recursive: true })

    // Deploy ALL agent YAMLs
    emit('status', `Deploying ${masterAgents.length} agents...`)
    const deployedAgents: string[] = []
    for (const agent of masterAgents) {
      try {
        this.deployAgent(workspacePath, agent.filename)
        deployedAgents.push(agent.filename)
      } catch (e) {
        deployLogger.warn(`Failed to deploy agent ${agent.filename}:`, e)
      }
    }

    // Collect all skills referenced by agents + deploy them
    const referencedSkills = new Set<string>()
    for (const agent of masterAgents) {
      for (const skillRef of agent.parsed.skills) {
        referencedSkills.add(skillRef)
      }
    }

    emit('status', `Deploying ${referencedSkills.size} skills...`)
    const deployedSkills: string[] = []
    for (const skillName of referencedSkills) {
      try {
        this.deploySkill(workspacePath, skillName)
        deployedSkills.push(skillName)
      } catch {
        /* skill may not exist in master */
      }
    }

    // ── STEP 1.5: Auto-sync deployed agents/skills into DB ──
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

    // ── STEP 2: Generate merged CLAUDE.md with Sonnet ──
    emit('status', 'Reading existing CLAUDE.md...')
    const claudeMdPath = join(workspacePath, 'CLAUDE.md')
    let existingClaudeMd: string | null = null
    if (existsSync(claudeMdPath)) {
      try {
        existingClaudeMd = readFileSync(claudeMdPath, 'utf-8')
      } catch {
        /* ignore */
      }
    }

    // Build a focused agent/skill summary for the prompt (names + descriptions only)
    const agentSummary = masterAgents
      .map(
        (a) =>
          `- ${a.filename}: ${a.parsed.description || a.parsed.name} (skills: ${a.parsed.skills.join(', ') || 'none'})`
      )
      .join('\n')

    const skillSummary = [...referencedSkills]
      .map((name) => {
        const skill = masterSkills.find((s) => s.name === name)
        return `- ${name}: ${skill?.frontmatter?.description || 'No description'}`
      })
      .join('\n')

    // Get workspace file listing for project context
    let treeListing = ''
    try {
      treeListing = this.getTreeListing(workspacePath, 3)
    } catch {
      treeListing = '(could not read directory)'
    }

    const prompt = `You are generating a CLAUDE.md file for a software project that now has AI specialist agents and skills deployed.

Project path: ${workspacePath}
Project file listing:
${treeListing}

${existingClaudeMd ? `Existing CLAUDE.md:\n---\n${existingClaudeMd}\n---` : 'No CLAUDE.md exists yet.'}

Deployed agents:
${agentSummary}

Deployed skills:
${skillSummary}

Instructions:
1. If an existing CLAUDE.md is present, PRESERVE all its project-specific content (tech stack, conventions, structure, commands, etc.)
2. If the existing CLAUDE.md has inline instructions for a technology that now has a dedicated skill (e.g., React instructions when there's an electron-pro skill), REPLACE those inline instructions with a reference to the skill instead of duplicating content
3. Add a "## Skills" section listing each deployed skill with its trigger keywords
4. Add a "## Agents" section listing deployed agents with brief delegation guidelines
5. Keep the result clean and well-organized

Return ONLY the complete CLAUDE.md content as plain text (no JSON wrapping, no code fences).`

    emit('status', 'Generating CLAUDE.md with Sonnet...')

    try {
      const mergedClaudeMd = await this.spawnActivationCall(prompt, onProgress)

      emit('status', 'Activation complete!')
      return {
        success: true,
        selectedAgents: deployedAgents,
        selectedSkills: deployedSkills,
        existingClaudeMd,
        proposedClaudeMd: mergedClaudeMd,
        claudeMdWritten: false
      }
    } catch (error) {
      // Step 1 succeeded (agents/skills deployed), but CLAUDE.md generation failed
      // Still return partial success so user sees deployed agents
      emit('error', `CLAUDE.md generation failed: ${(error as Error).message}`)
      return {
        success: true,
        selectedAgents: deployedAgents,
        selectedSkills: deployedSkills,
        error: `Agents deployed but CLAUDE.md generation failed: ${(error as Error).message}`,
        existingClaudeMd,
        proposedClaudeMd: null,
        claudeMdWritten: false
      }
    }
  }

  /** Write approved CLAUDE.md content to disk atomically */
  confirmClaudeMd(workspacePath: string, content: string): void {
    const claudeMdPath = join(workspacePath, 'CLAUDE.md')
    const tmpPath = claudeMdPath + '.tmp'
    writeFileSync(tmpPath, content, 'utf-8')
    renameSync(tmpPath, claudeMdPath)
  }

  /** Get a simple tree listing for the activation prompt */
  private getTreeListing(dirPath: string, maxDepth: number, prefix = '', depth = 0): string {
    if (depth >= maxDepth) return ''

    let result = ''
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true })
      const filtered = entries.filter(
        (e) =>
          !e.name.startsWith('.') &&
          e.name !== 'node_modules' &&
          e.name !== 'dist' &&
          e.name !== 'out' &&
          e.name !== 'build' &&
          e.name !== '.git'
      )

      for (let i = 0; i < filtered.length; i++) {
        const entry = filtered[i]
        const isLast = i === filtered.length - 1
        const connector = isLast ? '└── ' : '├── '
        const childPrefix = isLast ? '    ' : '│   '

        result += `${prefix}${connector}${entry.name}${entry.isDirectory() ? '/' : ''}\n`

        if (entry.isDirectory()) {
          result += this.getTreeListing(
            join(dirPath, entry.name),
            maxDepth,
            prefix + childPrefix,
            depth + 1
          )
        }
      }
    } catch {
      /* ignore */
    }

    return result
  }

  /** Spawn activation LLM call (Sonnet) */
  private spawnActivationCall(
    prompt: string,
    onProgress?: (event: ActivationProgressEvent) => void
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      this.currentAbortController = new AbortController()
      const { signal } = this.currentAbortController

      const env = { ...process.env }
      delete env.CLAUDECODE

      if (env.PATH && !env.PATH.includes('/usr/local/bin')) {
        env.PATH = `/usr/local/bin:${env.PATH}`
      }
      if (env.PATH && !env.PATH.includes('/opt/homebrew/bin')) {
        env.PATH = `/opt/homebrew/bin:${env.PATH}`
      }

      const emit = (type: ActivationProgressEvent['type'], message: string): void => {
        onProgress?.({ type, message, timestamp: Date.now() })
      }

      emit('status', 'Spawning Sonnet activation...')

      const child = spawn(
        'claude',
        [
          '-p',
          prompt,
          '--model',
          ACTIVATION_MODEL_ID,
          '--output-format',
          'text',
          '--permission-mode',
          'plan'
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
          signal
        }
      )

      deployLogger.info(
        `Sonnet activation spawned (no timeout, prompt length: ${prompt.length} chars)`
      )
      emit('status', `Sonnet process started (prompt: ${prompt.length} chars)`)

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString()
        stderr += chunk
        deployLogger.debug(`Activation stderr: ${chunk.slice(0, 200)}`)
        emit('stderr', chunk.trim())
      })

      // NO TIMEOUT — user can cancel manually via shutdown()

      child.on('exit', (code) => {
        this.currentAbortController = null
        deployLogger.info(
          `Sonnet activation exited with code ${code} (stdout: ${stdout.length} chars, stderr: ${stderr.length} chars)`
        )
        emit('status', `Sonnet exited with code ${code}`)

        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim())
        } else {
          const msg = `Activation call failed (exit code ${code}): ${stderr.trim() || 'No output received'}`
          emit('error', msg)
          reject(new Error(msg))
        }
      })

      child.on('error', (err) => {
        this.currentAbortController = null
        emit('error', `Failed to spawn: ${err.message}`)
        reject(new Error(`Failed to spawn activation call: ${err.message}`))
      })
    })
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

  /** Deploy all master agents & skills to workspace with inactive DB records */
  async deployAllInactive(workspacePath: string): Promise<{ agents: number; skills: number }> {
    const masterAgents = this.scanMasterAgents()
    const masterSkills = this.scanMasterSkills()

    // Create directories
    mkdirSync(join(workspacePath, '.claude', 'agents'), { recursive: true })
    mkdirSync(join(workspacePath, '.claude', 'skills'), { recursive: true })

    // Deploy all agent YAMLs
    let agentCount = 0
    for (const agent of masterAgents) {
      try {
        this.deployAgent(workspacePath, agent.filename)
        agentCount++
      } catch {
        /* skip */
      }
    }

    // Deploy all skills referenced by agents
    let skillCount = 0
    const referencedSkills = new Set<string>()
    for (const agent of masterAgents) {
      for (const ref of agent.parsed.skills) referencedSkills.add(ref)
    }
    // Also include any standalone master skills
    for (const skill of masterSkills) {
      referencedSkills.add(skill.name)
    }
    for (const skillName of referencedSkills) {
      try {
        this.deploySkill(workspacePath, skillName)
        skillCount++
      } catch {
        /* skip */
      }
    }

    // Auto-sync to DB (creates DB records, all inactive due to new default)
    const { agentSyncService } = await import('./agent-sync.service')
    agentSyncService.autoSyncNewEntries(workspacePath)

    return { agents: agentCount, skills: skillCount }
  }

  /** Shutdown — cancel any in-progress activation call */
  shutdown(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
  }
}

export const workspaceDeployService = new WorkspaceDeployService()
