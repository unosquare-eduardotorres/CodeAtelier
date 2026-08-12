/**
 * SpecialistBuilder — constructs a Project Specialist's prompt + stack
 * fingerprint for a given workspace.
 *
 * Phase 2 of the Project Specialist refactor. The builder runs:
 *
 *   0. HARD GATE — refuse to build unless the workspace's knowledge bootstrap
 *      (Brain → Bootstrap Project Knowledge) has completed with facts. Without
 *      ingested knowledge the tailoring step has nothing project-specific to
 *      work from and silently degrades to the generic template.
 *   1. detectTechStack(workspacePath, workspaceId) to snapshot the tech stack +
 *      compute a SHA-256 fingerprint.
 *   2. Read CLAUDE.md + bootstrap memory facts for the meta-prompt context.
 *   3. Render the template skeleton with the slot values.
 *   4. Tailor via an AGENTIC Claude run (read-only, with code-graph + memory
 *      MCP tools) so the persona is written from real code and real facts.
 *      Degrades to a blind one-shot call, then to the skeleton.
 *   5. Persist the result to the specialists row (prompt, stack_fingerprint,
 *      detected_techs, last_built_at, build_status='ready', build_method,
 *      ingestion_run_id).
 *
 * `build_method` records which of those three paths actually produced the
 * prompt, so a silent fallback can never render as a healthy "Ready" again.
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
import { runOneShotClaude } from './one-shot-claude'
import { modelConfigService } from './model-config.service'
import { resolvePromptVerbosity } from '../../shared/constants'
import { skillEnrichmentService } from './skill-enrichment.service'
import type { SkillEnrichment } from './skill-enrichment.service'
import {
  skillRepository,
  memoryBootstrapRepository,
  memoryFactRepository
} from '../db/repositories'
import { runAgenticClaude } from './agentic-claude-runner'
import { SpecialistIngestionRequiredError } from '../../shared/errors'
import type { BootstrapRunSummary, MemoryFact } from '../../shared/types'

const buildLog = log.scope('specialist-builder')

/** Which path actually produced the persisted prompt. */
export type SpecialistBuildMethod = 'agentic' | 'oneshot' | 'skeleton'

/** Sentinels the agentic run wraps its final prompt in. */
const PROMPT_BEGIN = '===SPECIALIST_PROMPT_BEGIN==='
const PROMPT_END = '===SPECIALIST_PROMPT_END==='

/** Character budget for bootstrap facts injected into the meta-prompt. */
const FACTS_BUDGET_CHARS = 8_000

/** Agentic tailoring gets a longer leash than the old blind one-shot. */
const AGENTIC_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Read-only tool whitelist for the agentic build. No Write/Edit/Bash — this run
 * inspects the project to describe it, it never changes it.
 */
const AGENTIC_SPECIALIST_TOOLS = ['Read', 'Glob', 'Grep', 'mcp__code-graph__*', 'mcp__memory__*']

/**
 * Pull the final prompt out of an agentic run's stdout. Prefers the sentinel
 * block; falls back to the whole stdout so a model that ignored the wrapper
 * instruction still yields a usable prompt (the caller length-checks it).
 *
 * Exported for unit tests.
 */
export function extractPromptBlock(stdout: string): string | null {
  const begin = stdout.indexOf(PROMPT_BEGIN)
  const end = stdout.indexOf(PROMPT_END)
  if (begin !== -1 && end > begin) {
    return stdout.slice(begin + PROMPT_BEGIN.length, end).trim()
  }
  const trimmed = stdout.trim()
  return trimmed.length > 0 ? trimmed : null
}

export interface BuildResult {
  specialistId: string
  stackFingerprint: string
  detectedTechs: string[]
  promptLength: number
  usedLLM: boolean
  /** Which path produced the prompt — persisted to specialists.build_method. */
  buildMethod: SpecialistBuildMethod
  /** The bootstrap run that informed this build, when one did. */
  ingestionRunId: string | null
}

export interface BuildOptions {
  /** When false, skip the LLM entirely and write only the skeleton. */
  useLLM?: boolean
  /** Override the CLI timeout (ms). Defaults to 5min agentic / 60s one-shot. */
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

/** Sentinel returned by readClaudeMd when the repo has no CLAUDE.md. */
const NO_CLAUDE_MD = '(no CLAUDE.md found in this repo)'

// ── Ingestion gate ────────────────────────────────────────────────

/**
 * A bootstrap run only counts as "ingested" when it completed AND produced
 * facts — a completed run with zero facts leaves the specialist just as blind
 * as no run at all.
 *
 * Exported for unit tests.
 */
export function isIngestionSatisfied(run: BootstrapRunSummary | null | undefined): boolean {
  return run?.status === 'completed' && run.factsCreated > 0
}

/**
 * Resolve the bootstrap run that will inform this build, or throw.
 * Exported for unit tests.
 */
export function requireIngestionRun(workspaceId: string): BootstrapRunSummary {
  const latest = memoryBootstrapRepository.getLatestRun(workspaceId) ?? null
  if (!isIngestionSatisfied(latest)) {
    buildLog.warn(
      `[gate] Specialist build blocked for workspace ${workspaceId} — latest bootstrap run: ${
        latest ? `${latest.status} (${latest.factsCreated} facts)` : 'none'
      }`
    )
    throw new SpecialistIngestionRequiredError(workspaceId)
  }
  return latest as BootstrapRunSummary
}

// ── Skeleton augmentation ──────────────────────────────────────────

/**
 * The skeleton defers all stack knowledge to CLAUDE.md. When the repo has no
 * CLAUDE.md that deferral leaves the specialist with zero stack awareness
 * anywhere, so name the detected stack inline instead.
 *
 * Exported for unit tests.
 */
export function augmentSkeleton(
  skeleton: string,
  techResult: TechStackResult,
  hasClaudeMd: boolean
): string {
  if (hasClaudeMd || techResult.detectedTechs.length === 0) return skeleton
  return skeleton.replace(
    '## Decision heuristics',
    `## Stack\nThis project uses: ${techResult.detectedTechs.join(', ')}. There is no CLAUDE.md — verify against the code before assuming conventions.\n\n## Decision heuristics`
  )
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
      throw new Error(
        `Specialist ${specialistId} is not workspace-bound — only workspace-bound specialists are supported`
      )
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

    // 0. HARD GATE — checked before build_status is touched, so a gated build
    //    leaves the specialist in its existing state rather than 'failed'.
    const ingestionRun = mode === 'skills-only' ? null : requireIngestionRun(workspace.id)

    // Flag building
    db.prepare(
      `UPDATE specialists SET build_status = 'building', updated_at = datetime('now') WHERE id = ?`
    ).run(specialist.id)

    try {
      // 1. Detect tech stack — workspace id enables the code-graph evidence source.
      const techResult = detectTechStack(workspace.repo_path, workspace.id)
      const fingerprint = this.fingerprintStack(techResult)

      // 2. Optionally rebuild prompt
      let newPrompt = specialist.prompt ?? ''
      let buildMethod: SpecialistBuildMethod = 'skeleton'
      if (mode !== 'skills-only') {
        const claudeMd = this.readClaudeMd(workspace.repo_path, 5_000)
        const hasClaudeMd = claudeMd !== NO_CLAUDE_MD
        const slots = this.buildSlotValues(specialist, workspace)
        const skeleton = augmentSkeleton(renderTemplate(slots), techResult, hasClaudeMd)
        newPrompt = skeleton

        if (options.useLLM !== false) {
          const tailored = await this.tailorPrompt({
            skeleton,
            claudeMd,
            hasClaudeMd,
            workspace,
            techResult,
            timeoutMs: options.llmTimeoutMs
          })
          if (tailored) {
            newPrompt = tailored.prompt
            buildMethod = tailored.method
          }
        }
      }

      // 3. Persist — including how the prompt was actually produced.
      db.prepare(
        `UPDATE specialists
            SET prompt = ?,
                stack_fingerprint = ?,
                detected_techs = ?,
                last_built_at = datetime('now'),
                build_status = 'ready',
                build_method = ?,
                ingestion_run_id = ?,
                updated_at = datetime('now')
          WHERE id = ?`
      ).run(
        newPrompt,
        fingerprint,
        JSON.stringify(techResult.detectedTechs),
        mode === 'skills-only' ? null : buildMethod,
        ingestionRun?.id ?? null,
        specialist.id
      )

      buildLog.info(
        `✓ Built Project Specialist ${specialist.id} (workspace=${workspace.name}, techs=${techResult.detectedTechs.length}, method=${buildMethod}, ingestionRun=${ingestionRun?.id ?? 'n/a'})`
      )

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
        usedLLM: buildMethod !== 'skeleton',
        buildMethod,
        ingestionRunId: ingestionRun?.id ?? null
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
    workspace: WorkspaceRow
  ): Partial<PromptSlotValues> {
    const enabledSkills = this.readEnabledSkills(specialist.id)
    return {
      workspaceName: workspace.name,
      enabledSkills
    }
  }

  /** Hard cap on specialist skill section size (chars). 4K budget. */
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

  /** Build the meta-prompt sent to Claude for persona tailoring. Exposed for tests. */
  buildMetaPrompt(params: {
    workspaceName: string
    detectedTechs: string[]
    claudeMdReference: string
    /**
     * When false, the "CLAUDE.md covers that" deferrals are unsafe and are
     * dropped. Defaults to true — the historical assumption.
     */
    hasClaudeMd?: boolean
    skeleton: string
    /** When 'lean', instructs the builder to produce a shorter identity (~250 words) */
    verbosity?: 'full' | 'lean'
    /** Ingested bootstrap knowledge — present on the agentic path. */
    ingestedFacts?: string
    /** When true, prepend tool-driven investigation steps and require sentinels. */
    agentic?: boolean
  }): string {
    const techList =
      params.detectedTechs.length > 0 ? params.detectedTechs.join(', ') : '(none detected)'
    const hasClaudeMd = params.hasClaudeMd !== false

    // Deferring stack/structure/conventions to CLAUDE.md is only sound when
    // CLAUDE.md actually exists. Without it the same rules would strip the
    // specialist of every concrete fact about the project.
    const layeringContext = hasClaudeMd
      ? [
          `CRITICAL LAYERING CONTEXT:`,
          `At runtime, your output is sandwiched between two other prompt layers the model already sees:`,
          `- BEFORE yours: a Mode Section with operational rules (tool budgets, plan/build constraints).`,
          `- AFTER yours: the project's full CLAUDE.md — conventions, project structure, tech stack,`,
          `  anti-patterns, key commands, and error handling patterns.`,
          ``,
          `Your prompt MUST NOT repeat ANY fact from CLAUDE.md. No tech stack lists, no directory trees,`,
          `no convention rules, no command references. Those are already in context. Repeating them wastes`,
          `tokens and dilutes your signal.`
        ]
      : [
          `CRITICAL LAYERING CONTEXT:`,
          `At runtime, your output is preceded by a Mode Section with operational rules.`,
          `This project has NO CLAUDE.md — nothing downstream will supply the stack, structure or`,
          `conventions. You are the ONLY layer carrying project facts, so state the stack and the`,
          `key architectural boundaries explicitly and concisely.`
        ]

    const factsSection =
      params.ingestedFacts && params.ingestedFacts.length > 0
        ? [
            '',
            `INGESTED PROJECT KNOWLEDGE (from this workspace's knowledge bootstrap — these are`,
            `verified facts about THIS repo; ground your heuristics in them):`,
            `---`,
            params.ingestedFacts,
            `---`
          ]
        : []

    const investigation = params.agentic
      ? [
          '',
          `BEFORE WRITING, INVESTIGATE. You have read-only tools — use them:`,
          `- mcp__code-graph__* to map the real module layout, entry points and hot spots.`,
          `- mcp__memory__* to read the ingested facts above in full where a summary is not enough.`,
          `- Read to confirm specific patterns you intend to encode as heuristics.`,
          `Spend your turns on evidence, then write. A heuristic you cannot point at real code for`,
          `does not belong in the output.`
        ]
      : []

    return [
      `You are writing the system prompt for a "Project Specialist" — an opinionated senior engineer`,
      `persona who will work on "${params.workspaceName}".`,
      '',
      `DETECTED STACK: ${techList}`,
      ...factsSection,
      ...investigation,
      '',
      ...layeringContext,
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
      `- Use Code Graph (mcp__code-graph__search_identifiers, mcp__code-graph__graph_map, mcp__code-graph__file_outline) and Semantic Search FIRST.`,
      `- Read only files identified by code intelligence. Grep only for exact strings.`,
      `- mcp__code-graph__file_outline before Read on any file over 80 lines.`,
      `- For action/change proposals, call **emit_plan** — plain-text plans are not actionable.`,
      `- For questions (why/what/how), answer directly in text.`,
      '',
      `HARD RULES:`,
      ...(hasClaudeMd
        ? [
            `- DO NOT list technologies, frameworks, or versions — CLAUDE.md covers that.`,
            `- DO NOT describe project structure or directory layout — CLAUDE.md covers that.`,
            `- DO NOT state conventions or anti-patterns as bullet lists — CLAUDE.md covers that.`
          ]
        : [
            `- DO name the stack and the main architectural boundaries — no CLAUDE.md will supply them.`,
            `- Keep it to what a new engineer needs to make good calls; still no directory trees.`
          ]),
      `- No directory trees, no command transcripts, no bulleted lists of agents or skills.`,
      `- Under ${params.verbosity === 'lean' ? '250' : '400'} words total.`,
      `- FIRST PERSON throughout ("I", "my", "I prefer", "I check").`,
      `- Every heuristic bullet must be SPECIFIC to this project — delete any that could apply to any codebase.`,
      `- Return the FINAL prompt only — no preamble, no fences, no trailing commentary.`,
      ...(params.agentic
        ? [
            `- Wrap the final prompt — and nothing else — between ${PROMPT_BEGIN} and ${PROMPT_END}.`
          ]
        : []),
      '',
      `SKELETON (fallback only, if you truly cannot produce a better version):`,
      `---`,
      params.skeleton,
      `---`,
      '',
      `Final expert-persona prompt:`
    ].join('\n')
  }

  /**
   * Read the highest-signal bootstrap facts for this workspace, budgeted.
   * Facts arrive tier/confidence-ordered from the repository, so a simple
   * prefix scan keeps the best ones.
   *
   * Exposed for tests.
   */
  readBootstrapFacts(workspaceId: string, budgetChars = FACTS_BUDGET_CHARS): string {
    let facts: MemoryFact[]
    try {
      facts = memoryFactRepository.findByWorkspace(workspaceId)
    } catch (err) {
      buildLog.warn('Could not read bootstrap facts:', err)
      return '(no ingested project knowledge available)'
    }

    const bootstrapped = facts.filter(
      (f) => f.sourceType === 'bootstrap' || f.tags.includes('bootstrap')
    )
    const pool = bootstrapped.length > 0 ? bootstrapped : facts
    if (pool.length === 0) return '(no ingested project knowledge available)'

    const lines: string[] = []
    let total = 0
    for (const fact of pool) {
      const line = `- [${fact.category}] ${fact.title}: ${fact.content}`
      if (total + line.length > budgetChars && lines.length > 0) break
      lines.push(line)
      total += line.length + 1
    }
    buildLog.info(
      `[facts] ${lines.length}/${pool.length} bootstrap facts injected (${total} chars) for ${workspaceId}`
    )
    return lines.join('\n')
  }

  /**
   * Tailor the skeleton into a project-specific persona.
   *
   * Preference order, each recorded distinctly so the UI can show what really
   * happened: agentic (reads code + ingested facts) → blind one-shot → null
   * (caller keeps the skeleton).
   */
  private async tailorPrompt(params: {
    skeleton: string
    claudeMd: string
    hasClaudeMd: boolean
    workspace: WorkspaceRow
    techResult: TechStackResult
    timeoutMs?: number
  }): Promise<{ prompt: string; method: SpecialistBuildMethod } | null> {
    const { skeleton, claudeMd, hasClaudeMd, workspace, techResult } = params
    const resolvedModel = modelConfigService.getModel(workspace.repo_path, 'specialist:plan')
    const verbosity = resolvePromptVerbosity(resolvedModel)
    const acceptable = (text: string): boolean =>
      text.trim().length > skeleton.length * 0.5 && text.trim() !== skeleton.trim()

    // ── 1. Agentic — the specialist is written from real code and real facts.
    try {
      const metaPrompt = this.buildMetaPrompt({
        workspaceName: workspace.name,
        detectedTechs: techResult.detectedTechs,
        claudeMdReference: claudeMd,
        hasClaudeMd,
        skeleton,
        verbosity,
        ingestedFacts: this.readBootstrapFacts(workspace.id),
        agentic: true
      })
      const { stdout } = await runAgenticClaude({
        workspaceId: workspace.id,
        workspacePath: workspace.repo_path,
        prompt: metaPrompt,
        model: resolvedModel,
        allowedTools: AGENTIC_SPECIALIST_TOOLS,
        mcpServers: ['memory', 'code-graph'],
        maxTurns: 20,
        timeoutMs: params.timeoutMs ?? AGENTIC_TIMEOUT_MS
      })
      const extracted = extractPromptBlock(stdout)
      if (extracted && acceptable(extracted)) {
        return { prompt: extracted, method: 'agentic' }
      }
      buildLog.warn(
        `[tailor] Agentic run produced an unusable prompt (${extracted?.length ?? 0} chars) — falling back to one-shot`
      )
    } catch (err) {
      buildLog.warn('[tailor] Agentic prompt build failed — falling back to one-shot:', err)
    }

    // ── 2. Blind one-shot — no tools, but still better than the raw skeleton.
    try {
      const tailored = await this.invokeLLM(
        skeleton,
        workspace.repo_path,
        workspace.name,
        techResult.detectedTechs,
        hasClaudeMd,
        params.timeoutMs ?? 60_000,
        workspace.id
      )
      if (acceptable(tailored)) {
        return { prompt: tailored, method: 'oneshot' }
      }
      buildLog.warn('[tailor] One-shot output too short — keeping skeleton')
    } catch (err) {
      buildLog.warn('[tailor] One-shot prompt build failed — keeping skeleton:', err)
    }

    return null
  }

  private async invokeLLM(
    skeleton: string,
    workspacePath: string,
    workspaceName: string,
    detectedTechs: string[],
    hasClaudeMd: boolean,
    timeoutMs: number,
    workspaceId?: string
  ): Promise<string> {
    const claudeMdReference = this.readClaudeMd(workspacePath, 5_000)
    const resolvedModel = modelConfigService.getModel(workspacePath, 'specialist:plan')
    const verbosity = resolvePromptVerbosity(resolvedModel)
    const metaPrompt = this.buildMetaPrompt({
      workspaceName,
      detectedTechs,
      claudeMdReference,
      hasClaudeMd,
      skeleton,
      verbosity
    })

    const { text } = await runOneShotClaude({
      feature: 'specialist_build',
      model: resolvedModel,
      workspaceId: workspaceId ?? null,
      args: ['-p', metaPrompt, '--model', resolvedModel],
      cli: {
        timeout: timeoutMs,
        cwd: workspacePath
      }
    })
    return text.trim()
  }
}

export const specialistBuilderService = new SpecialistBuilderService()
