/**
 * claude-md-generator — AI-powered CLAUDE.md generation for new projects.
 *
 * Uses a one-shot SDK query to generate a comprehensive CLAUDE.md
 * from the project description and grill session decisions.
 * Falls back to a template-based output if the AI call fails.
 */

import log from 'electron-log'
import type { GrillDecision, GrillTrackScore } from '../../shared/types'
import { runOneShotClaude } from './one-shot-claude'
import { modelConfigService } from './model-config.service'

const genLog = log.scope('claude-md-gen')

// ── Public API ─────────────────────────────────────────────────────────────

export async function generateClaudeMd(params: {
  projectName: string
  description: string
  grillDecisions: GrillDecision[]
  trackScores: GrillTrackScore[]
}): Promise<string> {
  const { projectName, description, grillDecisions, trackScores } = params

  genLog.info(
    `[claude-md-gen] Generating CLAUDE.md for "${projectName}" — ` +
      `${grillDecisions.length} decisions, ${trackScores.length} track scores`
  )

  // If no grill decisions, use template directly
  if (grillDecisions.length === 0) {
    genLog.info('[claude-md-gen] No grill decisions — using template fallback')
    return buildTemplateFallback(projectName, description)
  }

  try {
    const decisionsText = formatDecisions(grillDecisions)
    const scoresText = formatTrackScores(trackScores)

    const prompt = `Generate a comprehensive CLAUDE.md project blueprint for the following project.

## Project Name
${projectName}

## Description
${description}

## Grill Session Decisions
${decisionsText}

## Track Scores
${scoresText}

Generate the CLAUDE.md now. Output ONLY the markdown content — no code fences around the entire output.`

    const systemPrompt = `You are an expert technical writer generating a CLAUDE.md file — a project blueprint that will guide AI agents working on this codebase.

## Output Format

Generate a well-structured markdown document with the following sections:

### Required Sections:
1. **# Project: {name}** — title
2. **## Overview** — 2-3 paragraph description of the project, its purpose, and target audience
3. **## Tech Stack** — table or list of technologies chosen during the grill session
4. **## Architecture** — high-level architecture decisions, module boundaries, patterns
5. **## Conventions** — coding conventions, naming patterns, file organization
6. **## Key Requirements** — functional and non-functional requirements captured during grilling
7. **## Constraints & Trade-offs** — decisions made and their rationale
8. **## What NOT to do** — anti-patterns and decisions explicitly rejected

### Optional Sections (include if grill decisions cover them):
- **## Security** — auth strategy, input validation, secret management
- **## Testing** — test strategy, coverage targets, testing pyramid
- **## Infrastructure** — CI/CD, deployment, monitoring
- **## UX/UI** — user flows, accessibility, responsive design
- **## Data** — schema design, migration strategy

## Rules:
- Be specific and actionable — reference actual technology choices from the grill decisions
- Use bullet points and tables for scannability
- Include the WHY behind each decision (from the grill rationale)
- Write for an AI agent audience — clear, unambiguous, machine-parseable
- Do NOT invent decisions that weren't made — mark gaps with "TBD" if the grill didn't cover them
- Keep total length between 200-500 lines`

    // Use modelConfigService to resolve the model — respects user overrides
    // and avoids hardcoding a specific model version.
    const resolvedModel = modelConfigService.getModel(undefined, 'activation')

    const { text: content } = await runOneShotClaude({
      feature: 'claude_md',
      model: resolvedModel,
      workspaceId: null, // greenfield — no workspace yet
      args: [
        '-p',
        prompt,
        '--model',
        resolvedModel,
        '--system-prompt',
        systemPrompt,
        '--permission-mode',
        'plan',
        '--max-turns',
        '1'
      ],
      cli: {
        timeout: 60_000
      }
    })

    const trimmed = content.trim()
    if (trimmed.length < 50) {
      genLog.warn('[claude-md-gen] AI output too short — using template fallback')
      return buildTemplateFallback(projectName, description, grillDecisions)
    }

    genLog.info(`[claude-md-gen] Generated ${trimmed.length} chars`)
    return trimmed
  } catch (err) {
    genLog.error('[claude-md-gen] AI generation failed, using template fallback:', err)
    return buildTemplateFallback(projectName, description, grillDecisions)
  }
}

// ── Private helpers ────────────────────────────────────────────────────────

function formatDecisions(decisions: GrillDecision[]): string {
  if (decisions.length === 0) return 'No decisions captured.'

  // Group decisions by track
  const byTrack = new Map<string, GrillDecision[]>()
  for (const d of decisions) {
    const list = byTrack.get(d.trackId) ?? []
    list.push(d)
    byTrack.set(d.trackId, list)
  }

  const parts: string[] = []
  for (const [trackId, trackDecisions] of byTrack) {
    parts.push(`### ${trackId}`)
    for (const d of trackDecisions) {
      parts.push(
        `- **${d.questionText}**: ${d.selectedOption}${d.otherText ? ` (${d.otherText})` : ''}`
      )
    }
    parts.push('')
  }

  return parts.join('\n')
}

function formatTrackScores(scores: GrillTrackScore[]): string {
  if (scores.length === 0) return 'No track scores available.'

  return scores
    .map((s) => `- **${s.trackId}**: ${s.score}/100 (${s.scoreLabel}) — ${s.lastFeedback}`)
    .join('\n')
}

function buildTemplateFallback(
  projectName: string,
  description: string,
  decisions?: GrillDecision[]
): string {
  const decisionsSection = decisions?.length
    ? `\n## Key Decisions\n\n${decisions.map((d) => `- **${d.questionText}**: ${d.selectedOption}${d.otherText ? ` (${d.otherText})` : ''}`).join('\n')}\n`
    : ''

  return `# Project: ${projectName}

## Overview

${description || 'No description provided.'}

## Tech Stack

TBD — to be determined during development.

## Conventions

- TypeScript strict mode
- ESLint + Prettier for code formatting
- Conventional commits for version control
${decisionsSection}
## What NOT to do

- Do not commit secrets or API keys
- Do not skip error handling

## Key Commands

\`\`\`bash
# TBD — fill in as the project scaffolding is set up
\`\`\`
`
}
