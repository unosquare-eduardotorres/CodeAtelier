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
import { resolvePromptVerbosity } from '../../shared/constants'
import { skillEnrichmentService } from './skill-enrichment.service'
import type { SkillEnrichment } from './skill-enrichment.service'
import { skillRepository, workspaceRepository } from '../db/repositories'

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
  last_built_at?: string
  updated_at?: string
  skill_recommendations_hash?: string | null
  skill_recommendations_json?: string | null
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

      // 3b. Auto-activate: set specialistSwapAccepted so resolveAdapter() picks
      // the specialist adapter for new conversations without requiring the
      // ask_user swap proposal. Existing sessions (still DaVinci) can still
      // trigger the manual swap flow for the current conversation.
      try {
        const wsSettings = workspaceRepository.getSettings(workspace.id)
        if (!wsSettings.specialistSwapAccepted) {
          wsSettings.specialistSwapAccepted = true
          db.prepare(`UPDATE workspaces SET settings_json = ? WHERE id = ?`).run(
            JSON.stringify(wsSettings),
            workspace.id
          )
          buildLog.info(
            `[auto-activate] Set specialistSwapAccepted=true for workspace=${workspace.id}`
          )
        }
      } catch (activateErr) {
        buildLog.warn('[auto-activate] Failed to set specialistSwapAccepted:', activateErr)
      }

      // 4. Refresh skill recommendations if stale (non-blocking)
      void this.refreshRecommendationsIfStale(
        specialist.id,
        workspace.repo_path,
        techResult.detectedTechs
      ).catch((err) => buildLog.warn('Skill recommendation refresh failed:', err))

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

  /**
   * Refresh Haiku-powered skill recommendations for a specialist if the
   * skills inventory has changed since the last review.
   */
  private async refreshRecommendationsIfStale(
    specialistId: string,
    workspacePath: string,
    detectedTechs: string[]
  ): Promise<void> {
    const db = getDatabase()
    const allSkills = skillRepository.findAll()
    const currentHash = skillEnrichmentService.computeSkillsHash(
      allSkills.map((s) => ({ id: s.id, enrichmentJson: s.enrichmentJson }))
    )

    const specialist = db
      .prepare(`SELECT skill_recommendations_hash FROM specialists WHERE id = ?`)
      .get(specialistId) as { skill_recommendations_hash: string | null } | undefined

    if (
      !skillEnrichmentService.isStale(currentHash, specialist?.skill_recommendations_hash ?? null)
    ) {
      buildLog.info('Skill recommendations still fresh — skipping Haiku review')
      return
    }

    const claudeMd = this.readClaudeMd(workspacePath, 2000)
    const enrichedSkills = allSkills.map((s) => {
      let enrichment: SkillEnrichment | null = null
      if (s.enrichmentJson) {
        try {
          enrichment = JSON.parse(s.enrichmentJson)
        } catch {
          /* ignore parse error */
        }
      }
      return { id: s.id, name: s.name, enrichment }
    })

    const result = await skillEnrichmentService.generateRecommendations({
      specialistId,
      detectedTechs,
      claudeMdExcerpt: claudeMd,
      skills: enrichedSkills
    })

    db.prepare(
      `UPDATE specialists SET skill_recommendations_json = ?, skill_recommendations_hash = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify(result), currentHash, specialistId)

    buildLog.info(
      `✓ Skill recommendations refreshed for ${specialistId} (${result.recommendations.length} recommended)`
    )
  }

  /** Force-refresh skill recommendations regardless of staleness. */
  async forceRefreshRecommendations(
    specialistId: string,
    workspacePath: string,
    detectedTechs: string[]
  ): Promise<void> {
    const db = getDatabase()
    const allSkills = skillRepository.findAll()
    const currentHash = skillEnrichmentService.computeSkillsHash(
      allSkills.map((s) => ({ id: s.id, enrichmentJson: s.enrichmentJson }))
    )

    const claudeMd = this.readClaudeMd(workspacePath, 2000)
    const enrichedSkills = allSkills.map((s) => {
      let enrichment: SkillEnrichment | null = null
      if (s.enrichmentJson) {
        try {
          enrichment = JSON.parse(s.enrichmentJson)
        } catch {
          /* ignore parse error */
        }
      }
      return { id: s.id, name: s.name, enrichment }
    })

    const result = await skillEnrichmentService.generateRecommendations({
      specialistId,
      detectedTechs,
      claudeMdExcerpt: claudeMd,
      skills: enrichedSkills
    })

    db.prepare(
      `UPDATE specialists SET skill_recommendations_json = ?, skill_recommendations_hash = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify(result), currentHash, specialistId)

    buildLog.info(
      `✓ Skill recommendations force-refreshed for ${specialistId} (${result.recommendations.length} recommended)`
    )
  }

  private buildSlotValues(
    specialist: SpecialistRow,
    workspace: WorkspaceRow,
    _techResult: TechStackResult
  ): Partial<PromptSlotValues> {
    const enabledSkills = this.readEnabledSkills(specialist.id)
    return {
      workspaceName: workspace.name,
      enabledSkills
    }
  }

  /** Hard cap on specialist skill section size (chars). Matches DaVinci's 4K budget. */
  private static readonly SKILL_BUDGET_CHARS = 4000

  /**
   * Read `specialist_skills.is_enabled = 1` rows for this specialist and
   * format them as a bullet list of skill names + descriptions. The builder
   * injects this into the prompt so enabled skills actually influence the
   * Project Specialist's behavior.
   *
   * Capped at SKILL_BUDGET_CHARS to prevent unbounded prompt growth when
   * many skills are enabled.
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

    const lines: string[] = []
    let totalChars = 0
    for (const r of rows) {
      const line = `- **${r.name}**${r.description ? ` — ${r.description}` : ''}`
      if (
        totalChars + line.length > SpecialistBuilderService.SKILL_BUDGET_CHARS &&
        lines.length > 0
      ) {
        lines.push(`_(${rows.length - lines.length} more skills omitted — budget cap reached)_`)
        break
      }
      lines.push(line)
      totalChars += line.length + 1 // +1 for newline
    }
    return lines.join('\n')
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
    /** When 'lean', instructs the builder to produce a shorter identity (~250 words) */
    verbosity?: 'full' | 'lean'
  }): string {
    const techList =
      params.detectedTechs.length > 0 ? params.detectedTechs.join(', ') : '(none detected)'

    return [
      `You are writing the system prompt for a "Project Specialist" — an opinionated senior engineer`,
      `persona who will work on "${params.workspaceName}".`,
      '',
      `DETECTED STACK: ${techList}`,
      '',
      `CRITICAL LAYERING CONTEXT:`,
      `At runtime, your output is sandwiched between two other prompt layers the model already sees:`,
      `- BEFORE yours: a Mode Section with operational rules (tool budgets, plan/build constraints).`,
      `- AFTER yours: the project's full CLAUDE.md — conventions, project structure, tech stack,`,
      `  anti-patterns, key commands, and error handling patterns.`,
      ``,
      `Your prompt MUST NOT repeat ANY fact from CLAUDE.md. No tech stack lists, no directory trees,`,
      `no convention rules, no command references. Those are already in context. Repeating them wastes`,
      `tokens and dilutes your signal.`,
      ``,
      `YOUR JOB: Write the JUDGMENT layer — how this engineer THINKS about this codebase.`,
      `Encode decision-making instincts, priority ordering, trade-off preferences, and architectural`,
      `reflexes that help the model make better choices when rules are ambiguous or multiple valid`,
      `approaches exist.`,
      '',
      `REFERENCE (for domain and pattern inference — DO NOT quote, list, or reproduce):`,
      `---`,
      params.claudeMdReference,
      `---`,
      '',
      `Write a first-person identity prompt with EXACTLY these sections, in order, and nothing else:`,
      '',
      `## Your identity`,
      `3-4 sentences. The domain this project operates in (infer from reference — e.g. "developer`,
      `tooling", "fintech", "healthcare SaaS"). Your engineering stance (opinionated, pragmatic,`,
      `security-first, test-driven, etc.). What makes you effective on THIS codebase specifically —`,
      `not generic engineering virtues.`,
      '',
      `## Decision heuristics`,
      `3-5 bullet points. How you approach problems in THIS codebase. Shape:`,
      `- "When I face [situation], I [action] because [reason specific to this project]."`,
      `- "Before [common task], I always check [specific thing] first."`,
      `- "I default to [approach] over [alternative] in this codebase because [project-specific reason]."`,
      `These MUST be derived from the project's architecture and conventions — not generic engineering wisdom.`,
      '',
      `## Architecture instincts`,
      `2-4 bullet points. Boundaries, patterns, and safety defaults you enforce:`,
      `- Security or trust boundaries you never cross without explicit confirmation`,
      `- Patterns you reach for when adding new features (e.g. where new modules go, how they wire up)`,
      `- What you check first when estimating the blast radius of a change`,
      `These MUST reference actual architectural patterns visible in the reference — not platitudes.`,
      '',
      `## Output style`,
      `Keep these bullets verbatim from the skeleton:`,
      `- Clean markdown. Code blocks with language tags.`,
      `- Repo-relative paths.`,
      `- Numbered steps with file targets when proposing plans.`,
      '',
      `## Tool usage`,
      `Keep these bullets verbatim from the skeleton:`,
      `- Use Code Graph (search_identifiers, graph_map, file_outline) and Semantic Search FIRST.`,
      `- Read only files identified by code intelligence. Grep only for exact strings.`,
      `- file_outline before Read on any file over 80 lines.`,
      `- For action/change proposals, call **emit_plan** — plain-text plans are not actionable.`,
      `- For questions (why/what/how), answer directly in text.`,
      '',
      `HARD RULES:`,
      `- DO NOT list technologies, frameworks, or versions — CLAUDE.md covers that.`,
      `- DO NOT describe project structure or directory layout — CLAUDE.md covers that.`,
      `- DO NOT state conventions or anti-patterns as bullet lists — CLAUDE.md covers that.`,
      `- No directory trees, no command transcripts, no bulleted lists of agents or skills.`,
      `- Under ${params.verbosity === 'lean' ? '250' : '400'} words total.`,
      `- FIRST PERSON throughout ("I", "my", "I prefer", "I check").`,
      `- Every heuristic bullet must be SPECIFIC to this project — delete any that could apply to any codebase.`,
      `- Return the FINAL prompt only — no preamble, no fences, no trailing commentary.`,
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

    const claudeMdReference = this.readClaudeMd(workspacePath, 5_000)
    const resolvedModel = modelConfigService.getModel(workspacePath, 'project-specialist:plan')
    const verbosity = resolvePromptVerbosity(resolvedModel)
    const metaPrompt = this.buildMetaPrompt({
      workspaceName,
      detectedTechs,
      claudeMdReference,
      skeleton,
      verbosity
    })

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
