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
function parseSkillMdFrontmatter(
  content: string
): { name?: string; description?: string } | null {
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
        emit('status', `Synced ${syncResult.imported} specialists and ${syncResult.skillsImported} skills to database`)
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

  /** Get a simple tree listing for the Opus prompt */
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
        ['-p', prompt, '--model', ACTIVATION_MODEL_ID, '--output-format', 'text', '--permission-mode', 'plan', '--tools', ''],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
          signal
        }
      )

      deployLogger.info(`Sonnet activation spawned (no timeout, prompt length: ${prompt.length} chars)`)
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
        deployLogger.info(`Sonnet activation exited with code ${code} (stdout: ${stdout.length} chars, stderr: ${stderr.length} chars)`)
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

  /** Shutdown — cancel any in-progress Opus call */
  shutdown(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
  }
}

export const workspaceDeployService = new WorkspaceDeployService()
