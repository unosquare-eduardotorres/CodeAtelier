import { spawn } from 'node:child_process'
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  unlinkSync,
  renameSync,
  statSync,
  existsSync
} from 'node:fs'
import { join, basename } from 'node:path'
import { app } from 'electron'
import { ACTIVATION_MODEL_ID, SKILL_MAX_FILE_SIZE_BYTES } from '../../shared/constants'
import type { Skill } from '../../shared/types'
import { skillLogger } from '../logger'
import { skillRepository } from '../db/repositories'

interface QueueItem {
  operation: () => Promise<void>
  resolve: () => void
  reject: (err: Error) => void
}

export class SkillService {
  private queue: QueueItem[] = []
  private processing = false
  private currentAbortController: AbortController | null = null

  /** Returns the .claude/skills/ folder path (Claude Code standard location) */
  private getSkillsDir(): string {
    // In development, use the project root; in production, use app resources
    const isDev = !app.isPackaged
    if (isDev) {
      return join(process.cwd(), '.claude', 'skills')
    }
    return join(app.getPath('userData'), '.claude', 'skills')
  }

  /** Returns the CLAUDE.md path at the project root */
  private getClaudeMdPath(): string {
    const isDev = !app.isPackaged
    if (isDev) {
      return join(process.cwd(), 'CLAUDE.md')
    }
    return join(app.getPath('userData'), 'CLAUDE.md')
  }

  // ── File Validation ──
  validateSkillFile(filePath: string): { valid: boolean; error?: string; lastUpdated?: string } {
    if (!existsSync(filePath)) {
      return { valid: false, error: 'File not found' }
    }

    try {
      const stats = statSync(filePath)
      if (stats.size > SKILL_MAX_FILE_SIZE_BYTES) {
        return {
          valid: false,
          error: `File too large: ${(stats.size / 1024).toFixed(1)} KB (max ${SKILL_MAX_FILE_SIZE_BYTES / 1024} KB)`
        }
      }
    } catch {
      return { valid: false, error: 'Cannot access file' }
    }

    const content = readFileSync(filePath, 'utf-8')

    // Check for required "Last updated: YYYY-MM-DD" field
    const dateMatch = content.match(/Last updated:\s*(\d{4}-\d{2}-\d{2})/i)
    if (!dateMatch) {
      return {
        valid: false,
        error:
          'Missing required "Last updated: YYYY-MM-DD" field. Skill files must include this date for staleness tracking.'
      }
    }

    // Check for duplicate filename in .claude/skills/ folder
    const filename = basename(filePath)
    const targetPath = join(this.getSkillsDir(), filename)
    if (existsSync(targetPath) && targetPath !== filePath) {
      const existingInDb = skillRepository.findByFilename(filename)
      if (existingInDb) {
        return {
          valid: false,
          error: `A skill file named "${filename}" already exists. Please rename the file before importing.`
        }
      }
    }

    return { valid: true, lastUpdated: dateMatch[1] }
  }

  // ── Import (atomic: copy + DB + Opus) ──
  async importSkill(sourcePath: string): Promise<Skill> {
    const validation = this.validateSkillFile(sourcePath)
    if (!validation.valid) {
      throw new Error(validation.error)
    }

    const filename = basename(sourcePath)
    const skillsDir = this.getSkillsDir()
    const targetPath = join(skillsDir, filename)
    const relPath = `.claude/skills/${filename}`

    // Derive name from filename (remove .md extension, replace hyphens with spaces, title case)
    const name = filename
      .replace(/\.md$/i, '')
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())

    // Read description from file (first paragraph or first 200 chars)
    const content = readFileSync(sourcePath, 'utf-8')
    const descriptionMatch = content.match(/^#[^\n]*\n+([^\n#]+)/)
    const description = descriptionMatch ? descriptionMatch[1].trim().substring(0, 200) : ''

    let skill: Skill | null = null
    let fileCopied = false

    try {
      // 1. Copy file to .claude/skills/ folder
      copyFileSync(sourcePath, targetPath)
      fileCopied = true

      // 2. Create DB record (active by default)
      skill = skillRepository.create({
        name,
        description,
        filename,
        filePath: relPath,
        isActive: true,
        lastUpdatedDate: validation.lastUpdated
      })

      // 3. Trigger Opus CLAUDE.md update for activation
      await this.enqueueAndWait(async () => {
        await this.updateClaudeMd(targetPath, 'activate')
      })

      return skill
    } catch (error) {
      // Rollback: delete copied file and DB record
      if (fileCopied && existsSync(targetPath)) {
        try {
          unlinkSync(targetPath)
        } catch {
          /* ignore cleanup error */
        }
      }
      if (skill) {
        try {
          skillRepository.delete(skill.id)
        } catch {
          /* ignore cleanup error */
        }
      }
      throw error
    }
  }

  // ── Activate ──
  async activateSkill(id: string): Promise<Skill> {
    const skill = skillRepository.findById(id)
    if (!skill) throw new Error(`Skill not found: ${id}`)
    if (skill.isActive) return skill

    const skillsDir = this.getSkillsDir()
    const skillFilePath = join(skillsDir, skill.filename)

    try {
      // Update DB first
      const updated = skillRepository.setActive(id, true)

      // Queue Opus CLAUDE.md update
      await this.enqueueAndWait(async () => {
        await this.updateClaudeMd(skillFilePath, 'activate')
      })

      return updated
    } catch (error) {
      // Rollback: revert to inactive
      try {
        skillRepository.setActive(id, false)
      } catch {
        /* ignore */
      }
      throw error
    }
  }

  // ── Deactivate ──
  async deactivateSkill(id: string): Promise<Skill> {
    const skill = skillRepository.findById(id)
    if (!skill) throw new Error(`Skill not found: ${id}`)
    if (!skill.isActive) return skill

    const skillsDir = this.getSkillsDir()
    const skillFilePath = join(skillsDir, skill.filename)

    try {
      // Update DB first
      const updated = skillRepository.setActive(id, false)

      // Queue Opus CLAUDE.md update
      await this.enqueueAndWait(async () => {
        await this.updateClaudeMd(skillFilePath, 'deactivate')
      })

      return updated
    } catch (error) {
      // Rollback: revert to active
      try {
        skillRepository.setActive(id, true)
      } catch {
        /* ignore */
      }
      throw error
    }
  }

  // ── Opus CLAUDE.md Update ──
  private async updateClaudeMd(
    skillFilePath: string,
    operation: 'activate' | 'deactivate'
  ): Promise<void> {
    const claudeMdPath = this.getClaudeMdPath()

    if (!existsSync(claudeMdPath)) {
      skillLogger.warn('CLAUDE.md not found, skipping update')
      return
    }

    if (!existsSync(skillFilePath)) {
      skillLogger.warn('Skill file not found, skipping CLAUDE.md update:', skillFilePath)
      return
    }

    const claudeMdContent = readFileSync(claudeMdPath, 'utf-8')
    const skillContent = readFileSync(skillFilePath, 'utf-8')
    const skillFilename = basename(skillFilePath)

    const prompt =
      operation === 'activate'
        ? `You are updating a CLAUDE.md file to add references to a newly activated skill file.

Current CLAUDE.md content:
---
${claudeMdContent}
---

New skill file (${skillFilename}):
---
${skillContent}
---

Instructions:
1. Add appropriate references to the skill file in the CLAUDE.md "Skills" section
2. Follow the same format and style as existing skill references in the file
3. Return ONLY the complete updated CLAUDE.md content — no explanations, no code fences
4. Do not remove or modify any existing content unless necessary for the integration`
        : `You are updating a CLAUDE.md file to remove references to a deactivated skill file.

Current CLAUDE.md content:
---
${claudeMdContent}
---

Skill file being deactivated (${skillFilename}):
---
${skillContent}
---

Instructions:
1. Remove all references to the skill file "${skillFilename}" from the CLAUDE.md
2. Remove any skill-specific sections, keywords, or trigger descriptions related to this skill
3. Return ONLY the complete updated CLAUDE.md content — no explanations, no code fences
4. Keep all other content intact`

    const result = await this.spawnOpusCall(prompt)

    // Write atomically
    const tmpPath = claudeMdPath + '.tmp'
    writeFileSync(tmpPath, result, 'utf-8')
    renameSync(tmpPath, claudeMdPath)
  }

  private spawnOpusCall(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.currentAbortController = new AbortController()
      const { signal } = this.currentAbortController

      const env = { ...process.env }
      delete env.CLAUDECODE

      // Ensure claude CLI is findable
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

      skillLogger.info(
        `Opus CLAUDE.md update spawned (no timeout, prompt length: ${prompt.length} chars)`
      )

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
        skillLogger.debug(`Opus stderr: ${data.toString().slice(0, 200)}`)
      })

      // NO TIMEOUT — user can cancel manually via shutdown()

      child.on('exit', (code) => {
        this.currentAbortController = null
        skillLogger.info(
          `Opus exited with code ${code} (stdout: ${stdout.length} chars, stderr: ${stderr.length} chars)`
        )

        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim())
        } else {
          reject(
            new Error(
              `Opus call failed (exit code ${code}): ${stderr.trim() || 'No output received'}`
            )
          )
        }
      })

      child.on('error', (err) => {
        this.currentAbortController = null
        reject(new Error(`Failed to spawn Opus call: ${err.message}`))
      })
    })
  }

  // ── Queue Management ──
  private enqueueAndWait(operation: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ operation, resolve, reject })
      this.processQueue()
    })
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return
    this.processing = true

    while (this.queue.length > 0) {
      const item = this.queue.shift()!
      try {
        await item.operation()
        item.resolve()
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }

    this.processing = false
  }

  // ── Shutdown ──
  async shutdown(): Promise<void> {
    // Cancel in-progress Opus call
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }

    // Discard pending queue
    for (const item of this.queue) {
      item.reject(new Error('Skill service shutting down'))
    }
    this.queue = []
    this.processing = false
  }
}

export const skillService = new SkillService()
