/**
 * Skill Enrichment Service — two-stage Haiku enrichment pipeline.
 *
 * **Stage 1 — Import-time enrichment** (runs once per skill, on import):
 * Haiku reads SKILL.md content and produces structured enrichment metadata
 * (keywords, applicableTo, complexity). Stored in `skills.enrichment_json`.
 *
 * **Stage 2 — Build-time recommendations** (runs per specialist when skills change):
 * Haiku receives the project's detected techs, CLAUDE.md excerpt, and all
 * skills' enrichment data → returns a ranked list of skill relevance scores.
 * Stored in `specialists.skill_recommendations_json` alongside a staleness hash.
 */

import { createHash } from 'node:crypto'
import log from 'electron-log'
import { modelConfigService } from './model-config.service'
import { runOneShotClaude } from './one-shot-claude'

const enrichLog = log.scope('skill-enrichment')

// ── Types ────────────────────────────────────────────────────────────────────

export interface SkillEnrichment {
  keywords: string[]
  applicableTo: string
  complexity: 'foundational' | 'intermediate' | 'advanced'
}

export interface SkillRecommendation {
  skillId: string
  relevance: number // 0.0–1.0
  rationale: string // one-line explanation
}

export interface SkillRecommendationsResult {
  reviewedAt: string
  recommendations: SkillRecommendation[]
}

// ── Service ──────────────────────────────────────────────────────────────────

class SkillEnrichmentService {
  /**
   * Stage 1: Generate enrichment for a single skill.
   * Called on import. Uses Haiku via `claude -p`.
   */
  async enrichSkill(skillContent: string, skillName: string): Promise<SkillEnrichment> {
    const truncatedContent = skillContent.slice(0, 3000)
    const prompt = [
      'You are analyzing a development skill file to extract structured metadata.',
      '',
      `SKILL NAME: ${skillName}`,
      'SKILL CONTENT (first 3000 chars):',
      '---',
      truncatedContent,
      '---',
      '',
      'Return ONLY a JSON object with these fields:',
      '- "keywords": array of 3-10 lowercase tech/domain tags this skill covers (e.g. "electron", "ipc", "security", "sqlite", "testing", "react", "css")',
      '- "applicableTo": one sentence describing when this skill should be used (max 120 chars)',
      '- "complexity": one of "foundational", "intermediate", or "advanced"',
      '',
      'JSON only, no fences, no commentary.'
    ].join('\n')

    const raw = await this.invokeHaiku(prompt, 'skill_enrich')
    return this.parseEnrichment(raw)
  }

  /**
   * Stage 2: Generate recommendations for a specialist.
   * Compares all skills' enrichment against the project's detected techs
   * and CLAUDE.md excerpt. Only runs if skills have changed since last review.
   */
  async generateRecommendations(params: {
    specialistId: string
    detectedTechs: string[]
    claudeMdExcerpt: string
    skills: Array<{ id: string; name: string; enrichment: SkillEnrichment | null }>
  }): Promise<SkillRecommendationsResult> {
    const techList =
      params.detectedTechs.length > 0 ? params.detectedTechs.join(', ') : '(none detected)'

    const skillLines = params.skills
      .map((s) => {
        const kw = s.enrichment?.keywords?.join(', ') ?? '(no keywords)'
        const ap = s.enrichment?.applicableTo ?? '(no description)'
        return `- id: "${s.id}", name: "${s.name}", keywords: [${kw}], applicableTo: "${ap}"`
      })
      .join('\n')

    const prompt = [
      'You are selecting which development skills are relevant for a specific project.',
      '',
      `PROJECT STACK: ${techList}`,
      'PROJECT CONTEXT (from CLAUDE.md):',
      '---',
      params.claudeMdExcerpt.slice(0, 2000),
      '---',
      '',
      'AVAILABLE SKILLS:',
      skillLines,
      '',
      'For each skill, assess relevance (0.0-1.0) to THIS project.',
      'Return ONLY a JSON object:',
      '{',
      '  "recommendations": [',
      '    { "skillId": "...", "relevance": 0.95, "rationale": "one sentence why" }',
      '  ]',
      '}',
      '',
      'Only include skills with relevance >= 0.3. Sort by relevance descending.',
      'JSON only, no fences, no commentary.'
    ].join('\n')

    const raw = await this.invokeHaiku(prompt, 'skill_recommend')
    const parsed = this.parseRecommendations(raw)

    return {
      reviewedAt: new Date().toISOString(),
      recommendations: parsed
    }
  }

  /**
   * Check if recommendations are stale (new skills added since last review).
   */
  isStale(currentHash: string, storedHash: string | null): boolean {
    return currentHash !== storedHash
  }

  /**
   * Compute a hash of all skill IDs + their enrichment state for staleness detection.
   */
  computeSkillsHash(skills: Array<{ id: string; enrichmentJson: string | null }>): string {
    const sorted = [...skills].sort((a, b) => a.id.localeCompare(b.id))
    const payload = sorted.map((s) => `${s.id}:${s.enrichmentJson ?? ''}`).join('|')
    return createHash('sha256').update(payload).digest('hex').slice(0, 16)
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async invokeHaiku(prompt: string, feature: string): Promise<string> {
    const resolvedModel = modelConfigService.getModel(undefined, 'haiku')

    const { text } = await runOneShotClaude({
      feature,
      model: resolvedModel,
      args: ['-p', prompt, '--model', resolvedModel],
      cli: {
        timeout: 30_000
      }
    })
    return text.trim()
  }

  private parseEnrichment(raw: string): SkillEnrichment {
    try {
      // Strip markdown fences if present
      const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '')
      const parsed = JSON.parse(cleaned)

      // Validate + normalise
      const keywords = Array.isArray(parsed.keywords)
        ? parsed.keywords.filter((k: unknown) => typeof k === 'string').slice(0, 10)
        : []

      const applicableTo =
        typeof parsed.applicableTo === 'string'
          ? parsed.applicableTo.slice(0, 120)
          : 'General development skill'

      const validComplexities = ['foundational', 'intermediate', 'advanced'] as const
      const complexity = validComplexities.includes(parsed.complexity)
        ? (parsed.complexity as SkillEnrichment['complexity'])
        : 'intermediate'

      return { keywords, applicableTo, complexity }
    } catch (err) {
      enrichLog.warn('Failed to parse enrichment JSON — returning defaults:', err)
      return {
        keywords: [],
        applicableTo: 'Development skill',
        complexity: 'intermediate'
      }
    }
  }

  private parseRecommendations(raw: string): SkillRecommendation[] {
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '')
      const parsed = JSON.parse(cleaned)
      const recs = Array.isArray(parsed.recommendations) ? parsed.recommendations : []

      return recs
        .filter(
          (r: Record<string, unknown>) =>
            typeof r.skillId === 'string' && typeof r.relevance === 'number' && r.relevance >= 0.3
        )
        .map((r: Record<string, unknown>) => ({
          skillId: r.skillId as string,
          relevance: Math.min(1, Math.max(0, r.relevance as number)),
          rationale: typeof r.rationale === 'string' ? r.rationale : ''
        }))
        .sort((a: SkillRecommendation, b: SkillRecommendation) => b.relevance - a.relevance)
    } catch (err) {
      enrichLog.warn('Failed to parse recommendations JSON — returning empty:', err)
      return []
    }
  }
}

export const skillEnrichmentService = new SkillEnrichmentService()
