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
   * Feed from CLAUDE.md — extract structured memories from the project configuration file.
   */
  async feedFromClaudeMd(
    workspacePath: string,
    onProgress?: ProgressCallback
  ): Promise<MemoryFeedResult> {
    if (this.isBusy) {
      return {
        success: false,
        source: 'claude-md',
        memoriesCreated: 0,
        error: 'Another feed is in progress'
      }
    }

    const emit = (msg: string, type: MemoryFeedProgress['type'] = 'status'): void => {
      onProgress?.({ type, message: msg, source: 'claude-md', timestamp: Date.now() })
    }

    try {
      this.isBusy = true
      emit('Reading CLAUDE.md...')

      const claudeMdPath = join(workspacePath, 'CLAUDE.md')
      if (!existsSync(claudeMdPath)) {
        emit('No CLAUDE.md found', 'error')
        return {
          success: false,
          source: 'claude-md',
          memoriesCreated: 0,
          error: 'No CLAUDE.md found'
        }
      }

      const content = readFileSync(claudeMdPath, 'utf-8')
      if (content.length < 50) {
        emit('CLAUDE.md too short to extract memories', 'error')
        return {
          success: false,
          source: 'claude-md',
          memoriesCreated: 0,
          error: 'CLAUDE.md too short'
        }
      }

      emit('Extracting memories from CLAUDE.md...')

      const workspaceId = this.getWorkspaceId(workspacePath)
      const prompt = `You are a memory extraction engine. Read the following CLAUDE.md project configuration file and extract structured memories.

For each important piece of information, output a JSON object on its own line with these fields:
- "type": one of "project" (architecture decisions, tech choices) or "reference" (API patterns, conventions)
- "title": short descriptive title (5-15 words)
- "content": the extracted knowledge (1-3 sentences)
- "importance": 1-10 (10 = critical project constraint, 5 = useful convention, 1 = minor detail)
- "tags": array of relevant tags

Output ONLY valid JSON objects, one per line. No markdown, no explanation. Extract 5-20 memories from:

${content.substring(0, 50000)}`

      const result = await this.spawnSummarizer(prompt, workspacePath)
      const memories = this.parseMemoryLines(result, workspaceId, 'memory-feed-claude-md')

      this.saveFeedTimestamp(workspacePath, 'claude-md')
      emit(`Created ${memories} memories from CLAUDE.md`, 'complete')
      return { success: true, source: 'claude-md', memoriesCreated: memories }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      emit(`Feed failed: ${msg}`, 'error')
      return { success: false, source: 'claude-md', memoriesCreated: 0, error: msg }
    } finally {
      this.isBusy = false
    }
  }

  /**
   * Feed from codebase — analyze key project files and extract structural memories.
   */
  async feedFromCodebase(
    workspacePath: string,
    onProgress?: ProgressCallback
  ): Promise<MemoryFeedResult> {
    if (this.isBusy) {
      return {
        success: false,
        source: 'codebase',
        memoriesCreated: 0,
        error: 'Another feed is in progress'
      }
    }

    const emit = (msg: string, type: MemoryFeedProgress['type'] = 'status'): void => {
      onProgress?.({ type, message: msg, source: 'codebase', timestamp: Date.now() })
    }

    try {
      this.isBusy = true
      emit('Scanning codebase structure...')

      const keyFiles = this.readKeyFiles(workspacePath)
      const treeListing = this.getTreeListing(workspacePath)

      if (!keyFiles && !treeListing) {
        emit('No key files found to analyze', 'error')
        return {
          success: false,
          source: 'codebase',
          memoriesCreated: 0,
          error: 'No key files found'
        }
      }

      emit('Analyzing codebase structure...')

      const workspaceId = this.getWorkspaceId(workspacePath)
      const prompt = `You are a codebase analysis engine. Analyze the following project structure and key files, then extract structured memories about the project's architecture, patterns, and conventions.

For each important observation, output a JSON object on its own line with these fields:
- "type": one of "project" (architecture/tech choices) or "reference" (patterns/conventions)
- "title": short descriptive title (5-15 words)
- "content": the extracted knowledge (1-3 sentences)
- "importance": 1-10
- "tags": array of relevant tags

Output ONLY valid JSON objects, one per line. No markdown, no explanation.

## Project Tree
${treeListing}

## Key Files
${keyFiles}`

      const result = await this.spawnSummarizer(prompt, workspacePath)
      const memories = this.parseMemoryLines(result, workspaceId, 'memory-feed-codebase')

      this.saveFeedTimestamp(workspacePath, 'codebase')
      emit(`Created ${memories} memories from codebase analysis`, 'complete')
      return { success: true, source: 'codebase', memoriesCreated: memories }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      emit(`Feed failed: ${msg}`, 'error')
      return { success: false, source: 'codebase', memoriesCreated: 0, error: msg }
    } finally {
      this.isBusy = false
    }
  }

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

        memoryRepository.create({
          workspaceId: memWorkspaceId,
          type: data.type,
          title: data.title,
          content: data.content,
          tags: Array.isArray(data.tags) ? data.tags : [],
          sourceAgentId: agentId,
          importance:
            typeof data.importance === 'number' ? Math.min(10, Math.max(1, data.importance)) : 5
        })
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
