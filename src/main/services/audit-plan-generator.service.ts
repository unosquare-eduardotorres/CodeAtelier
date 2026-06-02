/**
 * AuditPlanGeneratorService — synthesizes a structured remediation plan from a
 * set of selected audit findings via a one-shot Claude CLI call.
 *
 * Mirrors GrillPlanGeneratorService: build a prompt → call the model → parse a
 * fenced JSON block → persist. The resulting AuditPlan can be routed to Chat,
 * Grill, Goals, Council, or exported.
 */

import log from 'electron-log'
import { modelConfigService } from './model-config.service'
import { auditPlanRepository } from '../db/repositories/audit-plan.repository'
import type { AuditPlan, AuditPlanRecord, AuditFinding } from '../../shared/types'

const planLog = log.scope('audit-plan-generator')

// ── System Prompt ───────────────────────────────────────────────────────────

const PLAN_GENERATION_SYSTEM_PROMPT = `You are a senior engineer synthesizing workspace-health audit findings into a structured, actionable remediation plan.

You receive a set of audit findings (severity, title, description, file, recommendation).
Your job is to produce a comprehensive AuditPlan JSON document.

RULES:
- Group related findings into coherent remediation items; do not emit one item per finding blindly.
- Order items by dependency and severity — critical/high first, items with no dependsOn first.
- Each item has a unique short id (e.g., "fix-1", "fix-2").
- Set scope to one of: backend | frontend | database | shared | tests.
- Populate files[] from the findings' file paths where available.
- sourceFindingIds must list the finding ids this plan addresses.
- Include a complete, standalone remediation document as markdown in requirementDocument.
- Produce the AuditPlan JSON inside a single fenced \`\`\`audit-plan block.

OUTPUT FORMAT:
\`\`\`audit-plan
{
  "version": 1,
  "title": "...",
  "summary": "...",
  "items": [
    {
      "id": "fix-1",
      "title": "...",
      "description": "...",
      "scope": "backend",
      "severity": "high",
      "files": ["..."],
      "recommendation": "...",
      "dependsOn": []
    }
  ],
  "risks": ["..."],
  "sourceFindingIds": ["..."],
  "requirementDocument": "# Remediation Plan\\n..."
}
\`\`\`

The JSON must be valid and complete. Do not truncate or abbreviate.`

// ── Service ─────────────────────────────────────────────────────────────────

class AuditPlanGeneratorService {
  /**
   * Generate a structured plan from selected audit findings, persist it, and
   * return the saved record.
   */
  async generate(params: {
    workspaceId: string
    runId: string
    findings: AuditFinding[]
  }): Promise<AuditPlanRecord> {
    planLog.info(
      `[audit-plan] Generating plan for run=${params.runId} from ${params.findings.length} findings`
    )

    if (params.findings.length === 0) {
      throw new Error('No findings provided for plan generation')
    }

    // 1. Build the prompt from the selected findings
    const prompt = this.buildPrompt(params.findings)

    // 2. Resolve model — reuse the plan-synthesis model action.
    const model = modelConfigService.getModelById(params.workspaceId, 'grill:plan')

    // 3. Call Claude via CLI one-shot
    const responseText = await this.callClaude(prompt, model)

    // 4. Parse the structured plan
    const plan = this.parsePlan(responseText, params.findings)
    if (!plan) {
      throw new Error('Failed to parse structured plan from model response')
    }

    // 5. Persist
    const record = auditPlanRepository.savePlan(params.runId, plan)
    planLog.info(`[audit-plan] ✓ Plan generated: ${plan.items.length} items, id=${record.id}`)
    return record
  }

  /** Build the user prompt from the selected findings. */
  private buildPrompt(findings: AuditFinding[]): string {
    const sections: string[] = []
    sections.push(`# Audit Findings → Remediation Plan\n`)
    sections.push(`You are given ${findings.length} selected audit finding(s):\n`)

    findings.forEach((f, i) => {
      sections.push(`## ${i + 1}. [${f.severity.toUpperCase()}] ${f.title}`)
      sections.push(`- **id**: ${f.id}`)
      sections.push(`- **description**: ${f.description}`)
      if (f.filePath) sections.push(`- **file**: ${f.filePath}`)
      if (f.recommendation) sections.push(`- **recommendation**: ${f.recommendation}`)
      sections.push('')
    })

    sections.push(
      `\n---\nGenerate a comprehensive AuditPlan that addresses these findings, grouped into actionable remediation items.`
    )
    return sections.join('\n')
  }

  /** Call Claude CLI in one-shot mode. */
  private async callClaude(prompt: string, model: string): Promise<string> {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)

    try {
      const { stdout } = await execFileAsync(
        'claude',
        [
          '-p',
          prompt,
          '--model',
          model,
          '--system-prompt',
          PLAN_GENERATION_SYSTEM_PROMPT,
          '--permission-mode',
          'plan',
          '--max-turns',
          '1',
          '--output-format',
          'text'
        ],
        {
          encoding: 'utf-8',
          timeout: 180_000, // 3 minutes — plan generation is heavier
          maxBuffer: 1024 * 1024 * 10 // 10MB buffer for large plans
        }
      )
      return stdout
    } catch (err) {
      planLog.error('[audit-plan] Claude CLI call failed:', err)
      throw new Error(`Plan generation failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Parse the audit-plan JSON block from the model response. */
  private parsePlan(text: string, findings: AuditFinding[]): AuditPlan | null {
    const regex = /```audit-plan\n([\s\S]*?)```/g
    let lastMatch: RegExpExecArray | null = null
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      lastMatch = match
    }
    if (!lastMatch) {
      planLog.error('[audit-plan] No ```audit-plan``` block found in response')
      return null
    }

    try {
      const parsed = JSON.parse(lastMatch[1]) as AuditPlan
      if (!parsed.title || !Array.isArray(parsed.items)) {
        planLog.error('[audit-plan] Parsed plan missing required fields')
        return null
      }
      parsed.version = 1
      parsed.summary = parsed.summary ?? ''
      parsed.risks = Array.isArray(parsed.risks) ? parsed.risks : []
      // Default sourceFindingIds to the provided findings if the model omitted them.
      if (!Array.isArray(parsed.sourceFindingIds) || parsed.sourceFindingIds.length === 0) {
        parsed.sourceFindingIds = findings.map((f) => f.id)
      }
      parsed.requirementDocument = parsed.requirementDocument ?? ''
      return parsed
    } catch (err) {
      planLog.error('[audit-plan] Failed to parse audit-plan JSON:', err)
      return null
    }
  }
}

export const auditPlanGeneratorService = new AuditPlanGeneratorService()
