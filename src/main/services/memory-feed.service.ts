import { spawn } from 'node:child_process'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dbLogger } from '../logger'
import { memoryRepository } from '../db/repositories'
import { workspaceRepository } from '../db/repositories'
import type {
  DiscoveredAgent,
  DiscoveredSkill,
  MemoryFeedProgress,
  MemoryFeedResult,
  MemoryType
} from '../../shared/types'
import { modelConfigService } from './model-config.service'
import { workspaceDeployService } from './workspace-deploy.service'

const log = dbLogger

type ProgressCallback = (event: MemoryFeedProgress) => void

/**
 * Service to ingest external sources (CLAUDE.md, codebase, documents) into the auto memory system.
 * Replaces BrainFeedService — writes structured memories to the memories table instead of .brain/ files.
 */
class MemoryFeedService {
  private currentAbortController: AbortController | null = null
  private isBusy = false

  /**
   * Feed from a specific document file — extract memories from .md, .txt, .docx, etc.
   */
  async feedFromDocument(
    workspacePath: string,
    filePath: string,
    onProgress?: ProgressCallback
  ): Promise<MemoryFeedResult> {
    if (this.isBusy) {
      return {
        success: false,
        source: 'document',
        memoriesCreated: 0,
        error: 'Another feed is in progress'
      }
    }

    const emit = (msg: string, type: MemoryFeedProgress['type'] = 'status'): void => {
      onProgress?.({ type, message: msg, source: 'document', timestamp: Date.now() })
    }

    try {
      this.isBusy = true
      emit(`Reading document: ${filePath}...`)

      if (!existsSync(filePath)) {
        emit('File not found', 'error')
        return {
          success: false,
          source: 'document',
          memoriesCreated: 0,
          error: `File not found: ${filePath}`
        }
      }

      const content = readFileSync(filePath, 'utf-8')
      if (content.length < 20) {
        emit('Document too short to extract memories', 'error')
        return {
          success: false,
          source: 'document',
          memoriesCreated: 0,
          error: 'Document too short'
        }
      }

      emit('Extracting memories from document...')

      const workspaceId = this.getWorkspaceId(workspacePath)
      const prompt = `You are a document analysis engine. Read the following document and extract structured memories.

For each important piece of information, output a JSON object on its own line:
- "type": one of "project", "reference", "user", or "feedback"
- "title": short descriptive title (5-15 words)
- "content": the extracted knowledge (1-3 sentences)
- "importance": 1-10
- "tags": array of relevant tags

Output ONLY valid JSON objects, one per line. No markdown, no explanation. Extract key information from:

${content.substring(0, 50000)}`

      const result = await this.spawnSummarizer(prompt, workspacePath)
      const memories = this.parseMemoryLines(result, workspaceId, 'memory-feed-document')

      this.saveFeedTimestamp(workspacePath, 'document')
      emit(`Created ${memories} memories from document`, 'complete')
      return { success: true, source: 'document', memoriesCreated: memories }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      emit(`Feed failed: ${msg}`, 'error')
      return { success: false, source: 'document', memoriesCreated: 0, error: msg }
    } finally {
      this.isBusy = false
    }
  }

  /**
   * Parse the LLM output — one JSON memory per line — and persist to DB.
   * Returns the count of successfully created memories.
   */
  private parseMemoryLines(text: string, workspaceId: string | null, agentId: string): number {
    let created = 0
    const lines = text.split('\n').filter((l) => l.trim().startsWith('{'))

    for (const line of lines) {
      try {
        const data = JSON.parse(line.trim())
        if (!data.type || !data.title || !data.content) continue

        const validTypes: MemoryType[] = ['user', 'feedback', 'project', 'reference']
        if (!validTypes.includes(data.type)) continue

        // user/feedback memories are cross-workspace
        const memWorkspaceId = data.type === 'user' || data.type === 'feedback' ? null : workspaceId

        const mem = memoryRepository.createIfNotDuplicate({
          workspaceId: memWorkspaceId,
          type: data.type,
          title: data.title,
          content: data.content,
          tags: Array.isArray(data.tags) ? data.tags : [],
          sourceAgentId: agentId,
          importance:
            typeof data.importance === 'number' ? Math.min(10, Math.max(1, data.importance)) : 5
        })
        if (!mem) continue // skip duplicate
        created++
      } catch {
        // Skip malformed lines
      }
    }

    log.info(`Memory feed parsed ${created} memories from ${lines.length} lines`)
    return created
  }

  /**
   * Read key project files for codebase analysis.
   */
  private readKeyFiles(workspacePath: string): string {
    const keyFileNames = ['package.json', 'tsconfig.json', 'electron-builder.yml', 'CLAUDE.md']
    const sections: string[] = []

    for (const name of keyFileNames) {
      const filePath = join(workspacePath, name)
      try {
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8')
          sections.push(`### ${name}\n\`\`\`\n${content.substring(0, 5000)}\n\`\`\``)
        }
      } catch {
        // Skip unreadable files
      }
    }

    return sections.join('\n\n')
  }

  /**
   * Generate a tree listing of the project structure.
   */
  private getTreeListing(workspacePath: string, depth: number = 3): string {
    const lines: string[] = []
    const ignored = new Set([
      'node_modules',
      '.git',
      'dist',
      'out',
      'build',
      '.next',
      '.cache',
      'coverage',
      '.idea',
      '.vscode',
      '__pycache__',
      '.DS_Store'
    ])

    const walk = (dir: string, prefix: string, currentDepth: number): void => {
      if (currentDepth > depth) return
      try {
        const entries = readdirSync(dir)
          .filter((e) => !ignored.has(e))
          .sort()
        for (const entry of entries) {
          const fullPath = join(dir, entry)
          try {
            const stat = statSync(fullPath)
            if (stat.isDirectory()) {
              lines.push(`${prefix}${entry}/`)
              walk(fullPath, prefix + '  ', currentDepth + 1)
            } else {
              lines.push(`${prefix}${entry}`)
            }
          } catch {
            // Skip inaccessible entries
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }

    walk(workspacePath, '', 0)
    return lines.slice(0, 200).join('\n') // Cap at 200 lines
  }

  /**
   * Spawn a claude -p summarizer process.
   */
  private spawnSummarizer(prompt: string, workspacePath?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.currentAbortController = new AbortController()
      const { signal } = this.currentAbortController

      const TIMEOUT_MS = 5 * 60 * 1000
      const timer = setTimeout(() => {
        log.warn('Memory feed summarizer timed out after 5 minutes')
        this.currentAbortController?.abort()
      }, TIMEOUT_MS)

      const env = { ...process.env }
      delete env.CLAUDECODE

      if (env.PATH && !env.PATH.includes('/usr/local/bin')) {
        env.PATH = `/usr/local/bin:${env.PATH}`
      }
      if (env.PATH && !env.PATH.includes('/opt/homebrew/bin')) {
        env.PATH = `/opt/homebrew/bin:${env.PATH}`
      }

      const memoryFeedModel = modelConfigService.getModel(workspacePath, 'memoryFeed')

      const child = spawn(
        'claude',
        [
          '-p',
          prompt,
          '--model',
          memoryFeedModel,
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

      log.info(`Memory feed summarizer spawned (prompt length: ${prompt.length} chars)`)

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString()
        stderr += chunk
        log.debug(`Memory feed stderr: ${chunk.slice(0, 200)}`)
      })

      child.on('exit', (code) => {
        clearTimeout(timer)
        this.currentAbortController = null

        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim())
        } else {
          const stderrMsg = stderr.trim()
          const details =
            stderrMsg ||
            (stdout.trim() ? `Unexpected output: ${stdout.slice(0, 200)}` : 'No output received')
          log.error(
            `Memory feed summarizer failed — exit code: ${code}, stderr: ${stderrMsg.slice(0, 500)}, stdout length: ${stdout.length}`
          )
          reject(new Error(`Memory feed summarization failed (exit ${code}): ${details}`))
        }
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        this.currentAbortController = null
        reject(new Error(`Failed to spawn memory feed summarizer: ${err.message}`))
      })
    })
  }

  /**
   * Save a feed timestamp to workspace settings_json.
   */
  private saveFeedTimestamp(workspacePath: string, feedKey: string): void {
    try {
      const workspaceId = this.getWorkspaceId(workspacePath)
      if (!workspaceId) return
      const currentSettings = workspaceRepository.getSettings(workspaceId)
      const lastFed =
        ((currentSettings as Record<string, unknown>).lastFed as Record<string, unknown>) ?? {}
      workspaceRepository.updateSettings(workspaceId, {
        ...currentSettings,
        lastFed: {
          ...lastFed,
          [feedKey]: new Date().toISOString()
        }
      })
    } catch (err) {
      log.warn('Failed to save feed timestamp:', err)
    }
  }

  /**
   * Look up workspace ID from workspace path.
   */
  private getWorkspaceId(workspacePath: string): string | null {
    try {
      const workspaces = workspaceRepository.findAll()
      const ws = workspaces.find((w) => w.repoPath === workspacePath)
      return ws?.id ?? null
    } catch {
      return null
    }
  }

  /**
   * Regenerate CLAUDE.md from project truth sources using AI.
   * Gathers package.json, tsconfig, project tree, agents, skills, schema,
   * and spawns Claude CLI to produce a high-quality CLAUDE.md.
   */
  async regenerateClaudeMd(
    workspacePath: string,
    onProgress?: ProgressCallback
  ): Promise<{ success: boolean; content: string; error?: string }> {
    if (this.isBusy) {
      return { success: false, content: '', error: 'A feed operation is already in progress' }
    }

    this.isBusy = true
    try {
      onProgress?.({
        source: 'claude-md',
        status: 'running',
        message: 'Gathering project sources...'
      })

      // 1. Gather truth sources
      const keyFiles = this.readKeyFiles(workspacePath)
      const treeListing = this.getTreeListing(workspacePath)

      let agents: DiscoveredAgent[] = []
      let skills: DiscoveredSkill[] = []
      try {
        agents = workspaceDeployService.scanWorkspaceAgents(workspacePath)
        skills = workspaceDeployService.scanWorkspaceSkills(workspacePath)
      } catch (err) {
        log.warn('Failed to scan agents/skills for CLAUDE.md regeneration:', err)
      }

      // 2. Read existing CLAUDE.md (if any) for user-written sections to preserve
      let existingClaudeMd: string | null = null
      try {
        existingClaudeMd = readFileSync(join(workspacePath, 'CLAUDE.md'), 'utf-8')
      } catch {
        // No existing CLAUDE.md
      }

      // 3. Read schema.sql if present (DB structure)
      let schemaContent: string | null = null
      try {
        schemaContent = readFileSync(
          join(workspacePath, 'src/main/db/schema.sql'),
          'utf-8'
        )?.substring(0, 5000)
      } catch {
        // No schema file
      }

      onProgress?.({
        source: 'claude-md',
        status: 'running',
        message: 'Generating CLAUDE.md with AI...'
      })

      // 4. Spawn Claude with expert generation prompt
      const prompt = buildRegeneratePrompt({
        keyFiles,
        treeListing,
        agents,
        skills,
        existingClaudeMd,
        schemaContent
      })

      const content = await this.spawnSummarizer(prompt, workspacePath)

      onProgress?.({
        source: 'claude-md',
        status: 'done',
        message: 'CLAUDE.md generated successfully'
      })

      return { success: true, content }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      log.error('Failed to regenerate CLAUDE.md:', errorMsg)
      onProgress?.({ source: 'claude-md', status: 'error', message: errorMsg })
      return { success: false, content: '', error: errorMsg }
    } finally {
      this.isBusy = false
    }
  }

  /** Cancel in-progress feed */
  shutdown(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
    this.isBusy = false
  }
}

export const memoryFeedService = new MemoryFeedService()

// ── Regeneration prompt builder ──

interface RegenerateSources {
  keyFiles: string
  treeListing: string
  agents: DiscoveredAgent[]
  skills: DiscoveredSkill[]
  existingClaudeMd: string | null
  schemaContent: string | null
}

function buildRegeneratePrompt(sources: RegenerateSources): string {
  const agentLines =
    sources.agents.length > 0
      ? sources.agents
          .map(
            (a) =>
              `- ${a.parsed.name}: ${a.parsed.description || 'no description'} (model: ${a.parsed.model}, skills: ${a.parsed.skills.join(', ') || 'none'})`
          )
          .join('\n')
      : '(none deployed)'

  const skillLines =
    sources.skills.length > 0
      ? sources.skills
          .map((s) => `- ${s.name}: ${s.frontmatter?.description || 'no description'}`)
          .join('\n')
      : '(none deployed)'

  const existingSection = sources.existingClaudeMd
    ? `### Existing CLAUDE.md (for reference — preserve user-written sections)\n${sources.existingClaudeMd.substring(0, 10000)}`
    : '### No existing CLAUDE.md — generate from scratch'

  const schemaSection = sources.schemaContent ? `### Database Schema\n${sources.schemaContent}` : ''

  return `You are an expert CLAUDE.md generator for Claude Code projects. Your job is to produce a high-quality, accurate CLAUDE.md file based ONLY on the actual project sources provided below.

## Output Format
Generate a complete CLAUDE.md following this exact structure:

### Required Sections:
1. **# Project: {name}** — from package.json name
2. **## Overview** — 2-3 sentences from package.json description + what the tree reveals
3. **## Tech stack** — ONLY dependencies actually in package.json (with versions)
4. **## Conventions** — Inferred from tsconfig strict mode, import aliases, file patterns
5. **## Project structure** — Simplified tree of src/ showing key directories
6. **## Key commands** — From package.json scripts (dev, build, test, lint)
7. **## What NOT to do** — Framework-specific anti-patterns (e.g., Electron: no nodeIntegration, no remote module)
8. **## Error handling patterns** — Inferred from code structure
9. **## Agents** — Table from deployed agents (with <!-- AGENTS:AUTO-GENERATED --> comment)
10. **## Skills** — Table from deployed skills (with <!-- SKILLS:AUTO-GENERATED --> comment)

### Critical Rules:
- ONLY include technologies that appear in package.json dependencies/devDependencies
- ONLY include commands that exist in package.json scripts
- NEVER invent conventions you can't verify from the sources
- If the project uses Electron, include Electron security rules (contextIsolation, no nodeIntegration, etc.)
- If existing CLAUDE.md has user-written sections not covered above, preserve them at the end under their original headings
- Use "as const" style if tsconfig shows strict mode
- Match the import style visible in the tree (barrel exports, alias prefixes)
- Keep the file concise but comprehensive — aim for 100-300 lines

## Project Sources

### package.json & config files
${sources.keyFiles}

### Project Tree
${sources.treeListing}

${schemaSection}

### Deployed Agents (${sources.agents.length})
${agentLines}

### Deployed Skills (${sources.skills.length})
${skillLines}

${existingSection}

Output ONLY the CLAUDE.md content. No explanation, no code fences wrapping the entire output.`
}
