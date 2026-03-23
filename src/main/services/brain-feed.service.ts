import { spawn } from 'node:child_process'
import { join, extname } from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { parseOffice } from 'officeparser'
import { brainService } from './brain.service'
import { ACTIVATION_MODEL_ID } from '../../shared/constants'
import { brainFeedLogger } from '../logger'
import type { BrainFeedProgress, BrainFeedResult } from '../../shared/types'

const log = brainFeedLogger

/** Max file size for document ingestion (2MB) */
const MAX_DOCUMENT_SIZE = 2 * 1024 * 1024
/** Max chars to send to the summarizer prompt (to avoid exceeding context) */
const MAX_PROMPT_CHARS = 100_000
/** Supported document extensions */
const SUPPORTED_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.docx',
  '.xlsx',
  '.pdf',
  '.pptx',
  '.odt',
  '.ods',
  '.rtf'
])
/** Allowed brain files for writing */
const ALLOWED_BRAIN_FILES = [
  'project-state.md',
  'changelog.md',
  'decisions-log.md',
  'errors-resolutions.md'
]

type ProgressCallback = (event: BrainFeedProgress) => void

class BrainFeedService {
  private currentAbortController: AbortController | null = null

  /** Ensure the .brain directory exists */
  private ensureBrainDir(workspacePath: string): string {
    const brainDir = join(workspacePath, '.brain')
    if (!existsSync(brainDir)) {
      mkdirSync(brainDir, { recursive: true })
    }
    return brainDir
  }

  /**
   * Feed from CLAUDE.md — read, AI-summarize, write to brain files
   */
  async feedFromClaudeMd(
    workspacePath: string,
    onProgress?: ProgressCallback
  ): Promise<BrainFeedResult> {
    const emit = (type: BrainFeedProgress['type'], message: string): void => {
      onProgress?.({ type, message, source: 'claude-md', timestamp: Date.now() })
    }

    const claudeMdPath = join(workspacePath, 'CLAUDE.md')
    if (!existsSync(claudeMdPath)) {
      emit('error', 'No CLAUDE.md found in workspace')
      return { success: false, source: 'claude-md', filesUpdated: [], error: 'No CLAUDE.md found' }
    }

    emit('status', 'Reading CLAUDE.md...')
    const content = readFileSync(claudeMdPath, 'utf-8')

    if (!content.trim()) {
      emit('error', 'CLAUDE.md is empty')
      return { success: false, source: 'claude-md', filesUpdated: [], error: 'CLAUDE.md is empty' }
    }

    const now = new Date().toISOString()
    const today = now.split('T')[0]

    const prompt = `You are analyzing a project's CLAUDE.md file to extract a structured project state snapshot for a persistent "project brain."

CLAUDE.md content:
---
${content.substring(0, MAX_PROMPT_CHARS)}
---

Generate TWO markdown sections separated by "===SECTION_BREAK===":

SECTION 1 - Project State (replaces project-state.md):
# Project State
> Auto-maintained by Agent Studio. Last updated: ${now}

## Current Phase
[Extract the current development phase]

## Tech Stack
[List key technologies, frameworks, versions]

## Key Conventions
[List coding conventions, patterns, naming rules]

## Completed Items
[List features/items that appear to be implemented]

## Pending Items
[List features/items that appear to be planned but not done]

===SECTION_BREAK===

SECTION 2 - Decisions (append to decisions-log.md):
Extract any architectural decisions mentioned in the CLAUDE.md as entries like:
### [DECISION] Decision title
> ${today}
Description and rationale.
---

If no clear decisions are found, output "NO_DECISIONS" for Section 2.

Return ONLY the two sections as plain text. No code fences, no JSON wrapping.`

    emit('status', 'Summarizing with AI...')

    try {
      const result = await this.spawnSummarizer(prompt)
      const parts = result.split('===SECTION_BREAK===')
      const projectState = parts[0]?.trim()
      const decisions = parts[1]?.trim()

      const brainDir = this.ensureBrainDir(workspacePath)
      const filesUpdated: string[] = []

      // Write project-state.md
      if (projectState) {
        const filePath = join(brainDir, 'project-state.md')
        writeFileSync(filePath, projectState, 'utf-8')
        filesUpdated.push('project-state.md')
        emit('status', 'Updated project-state.md')
      }

      // Append decisions if any
      if (decisions && !decisions.includes('NO_DECISIONS')) {
        const filePath = join(brainDir, 'decisions-log.md')
        const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
        writeFileSync(filePath, existing + '\n' + decisions, 'utf-8')
        filesUpdated.push('decisions-log.md')
        emit('status', 'Updated decisions-log.md')
      }

      brainService.invalidateCachePublic(workspacePath)
      emit('complete', `Brain fed from CLAUDE.md — ${filesUpdated.length} file(s) updated`)
      return { success: true, source: 'claude-md', filesUpdated }
    } catch (error) {
      const msg = (error as Error).message
      log.error('feedFromClaudeMd failed:', msg)
      emit('error', `AI summarization failed: ${msg}`)
      return { success: false, source: 'claude-md', filesUpdated: [], error: msg }
    }
  }

  /**
   * Feed from codebase scan — scan file tree + key files, AI-summarize
   */
  async feedFromCodebase(
    workspacePath: string,
    onProgress?: ProgressCallback
  ): Promise<BrainFeedResult> {
    const emit = (type: BrainFeedProgress['type'], message: string): void => {
      onProgress?.({ type, message, source: 'codebase', timestamp: Date.now() })
    }

    emit('status', 'Scanning project structure...')

    // Gather project context
    const treeListing = this.getTreeListing(workspacePath, 3)
    const keyFiles = this.readKeyFiles(workspacePath)

    const now = new Date().toISOString()
    const today = now.split('T')[0]

    const prompt = `You are analyzing a software project's codebase to create a comprehensive project brain snapshot.

Project path: ${workspacePath}

File tree (depth 3):
${treeListing.substring(0, 30_000)}

Key files content:
${keyFiles.substring(0, MAX_PROMPT_CHARS - 30_000)}

Generate TWO markdown sections separated by "===SECTION_BREAK===":

SECTION 1 - Project State (replaces project-state.md):
# Project State
> Auto-maintained by Agent Studio. Last updated: ${now}

## Current Phase
[Infer the current development phase from codebase maturity]

## Tech Stack
[List key technologies, frameworks, versions from package.json/config files]

## Key Conventions
[List coding conventions, patterns, naming rules inferred from structure]

## Completed Items
[List features/components that appear to be implemented based on file tree]

## Pending Items
[List features/items that appear to be planned but not fully done]

===SECTION_BREAK===

SECTION 2 - Decisions (append to decisions-log.md):
Infer architectural decisions from the codebase structure (e.g., chosen frameworks, DB choice, file organization pattern, testing approach, deployment strategy). Format each as:
### [DECISION] Decision title
> ${today}
Description and rationale inferred from codebase.
---

Return ONLY the two sections as plain text. No code fences, no JSON wrapping.`

    emit('status', 'Analyzing codebase with AI...')

    try {
      const result = await this.spawnSummarizer(prompt)
      const parts = result.split('===SECTION_BREAK===')
      const projectState = parts[0]?.trim()
      const decisions = parts[1]?.trim()

      const brainDir = this.ensureBrainDir(workspacePath)
      const filesUpdated: string[] = []

      // Write project-state.md
      if (projectState) {
        const filePath = join(brainDir, 'project-state.md')
        writeFileSync(filePath, projectState, 'utf-8')
        filesUpdated.push('project-state.md')
        emit('status', 'Updated project-state.md')
      }

      // Append decisions if any
      if (decisions && !decisions.includes('NO_DECISIONS')) {
        const filePath = join(brainDir, 'decisions-log.md')
        const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
        writeFileSync(filePath, existing + '\n' + decisions, 'utf-8')
        filesUpdated.push('decisions-log.md')
        emit('status', 'Updated decisions-log.md')
      }

      brainService.invalidateCachePublic(workspacePath)
      emit('complete', `Brain fed from codebase — ${filesUpdated.length} file(s) updated`)
      return { success: true, source: 'codebase', filesUpdated }
    } catch (error) {
      const msg = (error as Error).message
      log.error('feedFromCodebase failed:', msg)
      emit('error', `AI summarization failed: ${msg}`)
      return { success: false, source: 'codebase', filesUpdated: [], error: msg }
    }
  }

  /**
   * Feed from an uploaded document — extract text, AI-summarize, write to brain files
   */
  async feedFromDocument(
    workspacePath: string,
    filePath: string,
    onProgress?: ProgressCallback
  ): Promise<BrainFeedResult> {
    const emit = (type: BrainFeedProgress['type'], message: string): void => {
      onProgress?.({ type, message, source: 'document', timestamp: Date.now() })
    }

    // Validate extension
    const ext = extname(filePath).toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      emit('error', `Unsupported file type: ${ext}`)
      return {
        success: false,
        source: 'document',
        filesUpdated: [],
        error: `Unsupported file type: ${ext}`
      }
    }

    // Validate size
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(filePath)
    } catch {
      emit('error', 'File not found or inaccessible')
      return {
        success: false,
        source: 'document',
        filesUpdated: [],
        error: 'File not found or inaccessible'
      }
    }

    if (stat.size > MAX_DOCUMENT_SIZE) {
      emit(
        'error',
        `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 2MB)`
      )
      return { success: false, source: 'document', filesUpdated: [], error: 'File too large' }
    }

    emit('status', 'Extracting text from document...')

    let text: string
    try {
      if (ext === '.md' || ext === '.txt') {
        text = readFileSync(filePath, 'utf-8')
      } else {
        // Use officeparser for docx, xlsx, pdf, pptx, odt, ods, rtf
        text = await parseOffice(filePath) as string
      }
    } catch (error) {
      const msg = `Text extraction failed: ${(error as Error).message}`
      emit('error', msg)
      return { success: false, source: 'document', filesUpdated: [], error: msg }
    }

    if (!text?.trim()) {
      emit('error', 'No text content extracted from document')
      return {
        success: false,
        source: 'document',
        filesUpdated: [],
        error: 'Empty document'
      }
    }

    const fileName = filePath.split('/').pop() || 'document'
    const today = new Date().toISOString().split('T')[0]

    const prompt = `You are processing a document to add its content to a project's persistent brain memory.

Document: "${fileName}" (${ext})
Content:
---
${text.substring(0, MAX_PROMPT_CHARS)}
---

Analyze this document and determine which brain file(s) it should be added to:
- **project-state.md**: Project overview, phases, tech stack, status
- **changelog.md**: Completed work, version history, releases
- **decisions-log.md**: Architectural decisions, design choices, rationale
- **errors-resolutions.md**: Known issues, bugs, workarounds

Output format — for EACH relevant brain file, output a section like:
===FILE:project-state.md===
[Content to APPEND to that brain file, formatted as markdown entries]
===END_FILE===

===FILE:decisions-log.md===
### [DECISION] Decision title
> ${today}
Summary from document.
---
===END_FILE===

Only include files that have relevant content. Use appropriate markdown formatting for each file type. Return ONLY the sections — no explanations.`

    emit('status', 'Summarizing document with AI...')

    try {
      const result = await this.spawnSummarizer(prompt)
      const filesUpdated = this.parseAndWriteSections(workspacePath, result)

      brainService.invalidateCachePublic(workspacePath)
      emit('complete', `Document ingested — ${filesUpdated.length} brain file(s) updated`)
      return { success: true, source: 'document', filesUpdated }
    } catch (error) {
      const msg = (error as Error).message
      log.error('feedFromDocument failed:', msg)
      emit('error', `AI summarization failed: ${msg}`)
      return { success: false, source: 'document', filesUpdated: [], error: msg }
    }
  }

  // ── Private helpers ──

  /** Parse ===FILE:xxx=== sections and append to brain files */
  private parseAndWriteSections(workspacePath: string, aiOutput: string): string[] {
    const brainDir = this.ensureBrainDir(workspacePath)
    const filesUpdated: string[] = []
    const regex = /===FILE:([\w\-.]+)===\n([\s\S]*?)===END_FILE===/g
    let match: RegExpExecArray | null

    while ((match = regex.exec(aiOutput)) !== null) {
      const [, matchedFileName, content] = match
      if (!ALLOWED_BRAIN_FILES.includes(matchedFileName)) continue

      const trimmed = content.trim()
      if (!trimmed) continue

      const targetPath = join(brainDir, matchedFileName)

      // For project-state.md, overwrite; for others, append
      if (matchedFileName === 'project-state.md') {
        writeFileSync(targetPath, trimmed, 'utf-8')
      } else {
        const existing = existsSync(targetPath) ? readFileSync(targetPath, 'utf-8') : ''
        writeFileSync(targetPath, existing + '\n\n' + trimmed, 'utf-8')
      }
      filesUpdated.push(matchedFileName)
    }

    return filesUpdated
  }

  /** Read key project files for context */
  private readKeyFiles(workspacePath: string): string {
    const keyFileNames = [
      'package.json',
      'tsconfig.json',
      'README.md',
      'Cargo.toml',
      'go.mod',
      'pyproject.toml',
      '.gitignore'
    ]
    const sections: string[] = []

    for (const name of keyFileNames) {
      const keyPath = join(workspacePath, name)
      if (existsSync(keyPath)) {
        try {
          const fileContent = readFileSync(keyPath, 'utf-8')
          sections.push(`### ${name}\n\`\`\`\n${fileContent.substring(0, 5000)}\n\`\`\``)
        } catch {
          /* skip unreadable files */
        }
      }
    }

    // Also try to read CLAUDE.md if exists (bonus context)
    const claudeMd = join(workspacePath, 'CLAUDE.md')
    if (existsSync(claudeMd)) {
      try {
        sections.push(
          `### CLAUDE.md\n${readFileSync(claudeMd, 'utf-8').substring(0, 10_000)}`
        )
      } catch {
        /* skip */
      }
    }

    return sections.join('\n\n')
  }

  /** Tree listing (reused from workspace-deploy pattern) */
  private getTreeListing(
    dirPath: string,
    maxDepth: number,
    prefix = '',
    depth = 0
  ): string {
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
      /* ignore unreadable directories */
    }

    return result
  }

  /** Spawn claude -p for summarization (same pattern as workspace-deploy) */
  private spawnSummarizer(prompt: string): Promise<string> {
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

      log.info(`Brain feed summarizer spawned (prompt length: ${prompt.length} chars)`)

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString()
        stderr += chunk
        log.debug(`Summarizer stderr: ${chunk.slice(0, 200)}`)
      })

      child.on('exit', (code) => {
        this.currentAbortController = null
        log.info(
          `Summarizer exited with code ${code} (stdout: ${stdout.length} chars, stderr: ${stderr.length} chars)`
        )

        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim())
        } else {
          reject(
            new Error(
              `Summarization failed (exit ${code}): ${stderr.trim() || 'No output received'}`
            )
          )
        }
      })

      child.on('error', (err) => {
        this.currentAbortController = null
        reject(new Error(`Failed to spawn summarizer: ${err.message}`))
      })
    })
  }

  /** Cancel in-progress feed */
  shutdown(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
  }
}

export const brainFeedService = new BrainFeedService()
