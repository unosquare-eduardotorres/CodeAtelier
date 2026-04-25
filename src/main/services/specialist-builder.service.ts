/**
 * SpecialistBuilder — constructs a Project Specialist's prompt + stack
 * fingerprint for a given workspace.
 *
 * Phase 2 of the Project Specialist refactor. The builder runs:
 *
 *   1. detectTechStack(workspacePath) to snapshot the tech stack + compute a
 *      SHA-256 fingerprint.
 *   2. Read CLAUDE.md + package.json (best effort) for the prompt digest slot.
 *   3. Render the template skeleton with the slot values.
 *   4. OPTIONAL — one-shot Claude CLI build call (`claude -p`) to tailor the
 *      prompt for this project. Falls back to the unhydrated skeleton on
 *      failure so the specialist is always usable.
 *   5. Persist the result to the specialists row (prompt, stack_fingerprint,
 *      detected_techs, last_built_at, build_status='ready').
 *
 * MCP availability is decided at runtime by `buildWorkspaceMcpConfig` based
 * on workspace-level feature flags — not persisted per-specialist.
 *
 * Builds are exclusive per specialist (guarded by build_status='building').
 * Failures flip build_status='failed' and the error is logged.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import log from 'electron-log'
import { getDatabase } from '../db/index'
import { detectTechStack } from './tech-stack-detector.service'
import type { TechStackResult } from './tech-stack-detector.service'
import { renderTemplate, type PromptSlotValues } from './project-specialist-prompt-template'
import { buildEnvWithPath } from './env-utils'
import { modelConfigService } from './model-config.service'

const buildLog = log.scope('specialist-builder')

export interface BuildResult {
  specialistId: string
  stackFingerprint: string
  detectedTechs: string[]
  promptLength: number
  usedLLM: boolean
}

export interface BuildOptions {
  /** When false, skip the Claude CLI call and write only the skeleton. */
  useLLM?: boolean
  /** Override the CLI timeout (ms). Defaults to 60s. */
  llmTimeoutMs?: number
}

interface SpecialistRow {
  id: string
  workspace_id: string | null
  agent_id: string
  display_name: string
  prompt: string
  build_status: 'pending' | 'building' | 'ready' | 'failed'
  stack_fingerprint: string | null
  detected_techs: string
}

interface WorkspaceRow {
  id: string
  name: string
  repo_path: string
}

export class SpecialistBuilderService {
  /**
   * Build a pending Project Specialist for a workspace: detect stack,
   * render prompt, optionally call the LLM, persist result.
   */
  async buildProjectSpecialist(
    workspaceId: string,
    options: BuildOptions = {}
  ): Promise<BuildResult> {
    const db = getDatabase()
    const workspace = db
      .prepare(`SELECT id, name, repo_path FROM workspaces WHERE id = ?`)
      .get(workspaceId) as WorkspaceRow | undefined
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`)

    const specialist = this.loadSpecialistForWorkspace(workspaceId)
    if (!specialist) {
      throw new Error(`No Project Specialist row for workspace ${workspaceId}`)
    }

    return this.runBuild(specialist, workspace, options)
  }

  /** Rebuild an existing Project Specialist's prompt (keep skills intact). */
  async rebuildPrompt(specialistId: string, options: BuildOptions = {}): Promise<BuildResult> {
    const db = getDatabase()
    const specialist = db
      .prepare(
        `SELECT id, workspace_id, agent_id, display_name, prompt, build_status,
                stack_fingerprint, detected_techs
           FROM specialists WHERE id = ?`
      )
      .get(specialistId) as SpecialistRow | undefined
    if (!specialist) throw new Error(`Specialist ${specialistId} not found`)
    if (!specialist.workspace_id) {
      throw new Error(`Specialist ${specialistId} is not workspace-bound (is it the Generalist?)`)
    }
    const workspace = db
      .prepare(`SELECT id, name, repo_path FROM workspaces WHERE id = ?`)
      .get(specialist.workspace_id) as WorkspaceRow | undefined
    if (!workspace) throw new Error(`Workspace ${specialist.workspace_id} not found`)

    return this.runBuild(specialist, workspace, { ...options, mode: 'prompt-only' })
  }

  /** Re-detect stack and skill recommendations only — no prompt LLM call. */
  async rebuildSkills(specialistId: string): Promise<BuildResult> {
    const db = getDatabase()
    const specialist = db
      .prepare(
        `SELECT id, workspace_id, agent_id, display_name, prompt, build_status,
                stack_fingerprint, detected_techs
           FROM specialists WHERE id = ?`
      )
      .get(specialistId) as SpecialistRow | undefined
    if (!specialist) throw new Error(`Specialist ${specialistId} not found`)
    if (!specialist.workspace_id) {
      throw new Error(`Specialist ${specialistId} is not workspace-bound`)
    }
    const workspace = db
      .prepare(`SELECT id, name, repo_path FROM workspaces WHERE id = ?`)
      .get(specialist.workspace_id) as WorkspaceRow | undefined
    if (!workspace) throw new Error(`Workspace ${specialist.workspace_id} not found`)

    return this.runBuild(specialist, workspace, { useLLM: false, mode: 'skills-only' })
  }

  // ── Internal ─────────────────────────────────────────────────────

  private loadSpecialistForWorkspace(workspaceId: string): SpecialistRow | undefined {
    const db = getDatabase()
    return db
      .prepare(
        `SELECT id, workspace_id, agent_id, display_name, prompt, build_status,
                stack_fingerprint, detected_techs
           FROM specialists WHERE workspace_id = ?`
      )
      .get(workspaceId) as SpecialistRow | undefined
  }

  private async runBuild(
    specialist: SpecialistRow,
    workspace: WorkspaceRow,
    options: BuildOptions & { mode?: 'full' | 'prompt-only' | 'skills-only' }
  ): Promise<BuildResult> {
    const db = getDatabase()
    const mode = options.mode ?? 'full'

    // Flag building
    db.prepare(
      `UPDATE specialists SET build_status = 'building', updated_at = datetime('now') WHERE id = ?`
    ).run(specialist.id)

    try {
      // 1. Detect tech stack
      const techResult = detectTechStack(workspace.repo_path)
      const fingerprint = this.fingerprintStack(techResult)

      // 2. Optionally rebuild prompt
      let newPrompt = specialist.prompt ?? ''
      let usedLLM = false
      if (mode !== 'skills-only') {
        const slots = this.buildSlotValues(specialist, workspace, techResult)
        const skeleton = renderTemplate(slots)
        if (options.useLLM !== false) {
          try {
            const tailored = await this.invokeLLM(
              skeleton,
              workspace.repo_path,
              workspace.name,
              techResult.detectedTechs,
              options.llmTimeoutMs ?? 60_000
            )
            if (tailored && tailored.trim().length > skeleton.length * 0.5) {
              newPrompt = tailored
              usedLLM = true
            } else {
              // LLM produced something too short — fall back to skeleton.
              newPrompt = skeleton
            }
          } catch (err) {
            buildLog.warn('LLM prompt build failed — falling back to skeleton:', err)
            newPrompt = skeleton
          }
        } else {
          newPrompt = skeleton
        }
      }

      // 3. Persist
      db.prepare(
        `UPDATE specialists
            SET prompt = ?,
                stack_fingerprint = ?,
                detected_techs = ?,
                last_built_at = datetime('now'),
                build_status = 'ready',
                updated_at = datetime('now')
          WHERE id = ?`
      ).run(newPrompt, fingerprint, JSON.stringify(techResult.detectedTechs), specialist.id)

      buildLog.info(
        `✓ Built Project Specialist ${specialist.id} (workspace=${workspace.name}, techs=${techResult.detectedTechs.length}, usedLLM=${usedLLM})`
      )

      return {
        specialistId: specialist.id,
        stackFingerprint: fingerprint,
        detectedTechs: techResult.detectedTechs,
        promptLength: newPrompt.length,
        usedLLM
      }
    } catch (err) {
      db.prepare(
        `UPDATE specialists SET build_status = 'failed', updated_at = datetime('now') WHERE id = ?`
      ).run(specialist.id)
      throw err
    }
  }

  private buildSlotValues(
    specialist: SpecialistRow,
    workspace: WorkspaceRow,
    techResult: TechStackResult
  ): Partial<PromptSlotValues> {
    const stackSummary =
      techResult.detectedTechs.length > 0
        ? techResult.detectedTechs.join(', ')
        : 'no specific tech stack detected'
    const enabledSkills = this.readEnabledSkills(specialist.id)

    return {
      workspaceName: workspace.name,
      stackSummary,
      enabledSkills
    }
  }

  /**
   * Read `specialist_skills.is_enabled = 1` rows for this specialist and
   * format them as a bullet list of skill names + descriptions. The builder
   * injects this into the prompt so enabled skills actually influence the
   * Project Specialist's behavior.
   */
  private readEnabledSkills(specialistId: string): string {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT s.name, s.description
           FROM specialist_skills ss
           JOIN skills s ON s.id = ss.skill_id
          WHERE ss.specialist_id = ? AND ss.is_enabled = 1
          ORDER BY s.name`
      )
      .all(specialistId) as Array<{ name: string; description: string | null }>

    if (rows.length === 0) {
      return '(no skills enabled yet — enable from the Skills tab)'
    }
    return rows
      .map((r) => `- **${r.name}**${r.description ? ` — ${r.description}` : ''}`)
      .join('\n')
  }

  /**
   * Reads CLAUDE.md (or .claude/CLAUDE.md) and returns it trimmed to `maxBytes`.
   * No longer fed into a slot — used only by `invokeLLM` as a REFERENCE excerpt
   * for the meta-prompt so the LLM can infer DOMAIN context (not enrich content).
   */
  private readClaudeMd(workspacePath: string, maxBytes = 6_000): string {
    const candidates = ['CLAUDE.md', '.claude/CLAUDE.md']
    for (const rel of candidates) {
      const abs = join(workspacePath, rel)
      if (existsSync(abs)) {
        try {
          const raw = readFileSync(abs, 'utf8')
          return raw.length > maxBytes ? raw.slice(0, maxBytes) + '\n\n…(truncated)' : raw
        } catch {
          /* fall through */
        }
      }
    }
    return '(no CLAUDE.md found in this repo)'
  }

  private fingerprintStack(result: TechStackResult): string {
    const sorted = [...result.detectedTechs].sort()
    return createHash('sha256').update(sorted.join('|')).digest('hex').slice(0, 16)
  }

  /** Build the meta-prompt sent to `claude -p` for persona tailoring. Exposed for tests. */
  buildMetaPrompt(params: {
    workspaceName: string
    detectedTechs: string[]
    claudeMdReference: string
    skeleton: string
  }): string {
    const techList =
      params.detectedTechs.length > 0 ? params.detectedTechs.join(', ') : '(none detected)'

    return [
      `You are writing the system prompt for a "Project Specialist" — an opinionated senior engineer`,
      `persona who will work on "${params.workspaceName}".`,
      '',
      `DETECTED STACK: ${techList}`,
      '',
      `REFERENCE (for DOMAIN inference only — DO NOT quote, paraphrase, list, or reproduce structure):`,
      `---`,
      params.claudeMdReference,
      `---`,
      '',
      `Write a first-person identity prompt with EXACTLY these sections, in order, and nothing else:`,
      '',
      `## Your identity`,
      `3-5 sentences. Who this engineer is. Their seniority and concrete experience with each detected`,
      `tech. The domain they operate in (infer from the reference — e.g. "healthcare SaaS", "devtools",`,
      `"fintech"). Their default stance (opinionated, pragmatic, security-aware, test-driven, etc.).`,
      '',
      `## Your tech-stack stance`,
      `2-5 bullet points with CONCRETE opinions about the detected techs. Shape: "I prefer X over Y`,
      `because Z", "I never Y — instead I Z." Opinions MUST be specific to the detected stack. No`,
      `generic software-engineering platitudes.`,
      '',
      `## Domain context`,
      `1-2 sentences: what this project does and who its users are. Infer from the reference. Nothing`,
      `invented.`,
      '',
      `## Output style`,
      `Keep the existing "clean markdown / repo-relative paths / numbered plan steps" bullets verbatim`,
      `from the skeleton.`,
      '',
      `HARD RULES:`,
      `- No directory trees.`,
      `- No bulleted lists of other agents, skills, or commands.`,
      `- No absolute file paths or command transcripts.`,
      `- Under 400 words total.`,
      `- Identity is FIRST PERSON ("I am…", "I prefer…", "I push back on…").`,
      `- Return the FINAL prompt verbatim — no preamble, no fences, no trailing commentary.`,
      '',
      `SKELETON (fallback only, if you truly cannot produce a better version):`,
      `---`,
      params.skeleton,
      `---`,
      '',
      `Final expert-persona prompt:`
    ].join('\n')
  }

  private async invokeLLM(
    skeleton: string,
    workspacePath: string,
    workspaceName: string,
    detectedTechs: string[],
    timeoutMs: number
  ): Promise<string> {
    const { spawn } = await import('node:child_process')

    const claudeMdReference = this.readClaudeMd(workspacePath, 3_000)
    const metaPrompt = this.buildMetaPrompt({
      workspaceName,
      detectedTechs,
      claudeMdReference,
      skeleton
    })

    const resolvedModel = modelConfigService.getModel(workspacePath, 'project-specialist:plan')

    return new Promise<string>((resolve, reject) => {
      const env = buildEnvWithPath()
      const args = ['-p', metaPrompt, '--model', resolvedModel]
      const proc = spawn('claude', args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeoutMs,
        cwd: workspacePath
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString()
      })
      proc.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString()
      })

      proc.on('close', (code) => {
        if (code === 0 && stdout.trim().length > 100) {
          resolve(stdout.trim())
        } else {
          reject(new Error(`claude -p failed (code ${code}): ${stderr.slice(0, 500)}`))
        }
      })

      proc.on('error', reject)
    })
  }
}

export const specialistBuilderService = new SpecialistBuilderService()
