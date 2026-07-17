/**
 * target-adapters — How each feature receives a handoff.
 *
 * Each target adapter transforms a HandoffEnvelope into the actions needed
 * to set up the receiving feature (create conversation, populate context, etc.).
 *
 * These are pure-function adapters that return action descriptors rather than
 * executing side effects directly — the HandoffService orchestrates execution.
 */

import type { HandoffEnvelope, HandoffRenderFormat } from '../../../shared/handoff-types'

// ── Rendering ────────────────────────────────────────────────────────

/**
 * Render a HandoffEnvelope as markdown for LLM consumption.
 * Three formats matching ContextWindowTier:
 *  - full:     ≤4K tokens — complete envelope
 *  - standard: ≤1.5K tokens — key sections only
 *  - compact:  ≤500 chars — summary for handoff_context column
 */
export function renderEnvelopeMarkdown(
  envelope: HandoffEnvelope,
  format: HandoffRenderFormat = 'standard'
): string {
  if (format === 'compact') {
    return renderCompact(envelope)
  }
  if (format === 'full') {
    return renderFull(envelope)
  }
  return renderStandard(envelope)
}

function renderCompact(env: HandoffEnvelope): string {
  const parts: string[] = []
  parts.push(`[Handoff: ${env.source} → ${env.target}] ${env.intent}`)
  if (env.completedWork.length > 0) {
    parts.push(`Done: ${env.completedWork.map((s) => s.title).join(', ')}`)
  }
  if (env.remainingWork.length > 0) {
    parts.push(`Todo: ${env.remainingWork.map((s) => s.title).join(', ')}`)
  }
  if (env.decisions.length > 0) {
    parts.push(`Decisions: ${env.decisions.length}`)
  }
  return parts.join(' | ').slice(0, 500)
}

function renderStandard(env: HandoffEnvelope): string {
  const lines: string[] = []
  lines.push(`## Handoff: ${env.source} → ${env.target}`)
  lines.push(`**Intent:** ${env.intent}`)
  lines.push(`**Confidence:** ${(env.confidence * 100).toFixed(0)}%`)
  lines.push(`**Priority:** ${env.priority}`)
  lines.push('')

  if (env.contextSummary) {
    lines.push(env.contextSummary)
    lines.push('')
  }

  if (env.completedWork.length > 0) {
    lines.push(`### Completed Work`)
    for (const step of env.completedWork.slice(0, 5)) {
      lines.push(`- ✓ **${step.title}**: ${step.outcome.slice(0, 100)}`)
    }
    lines.push('')
  }

  if (env.remainingWork.length > 0) {
    lines.push(`### Remaining Work`)
    for (const step of env.remainingWork.slice(0, 10)) {
      lines.push(`- **${step.title}** [${step.priority}]: ${step.description.slice(0, 100)}`)
    }
    lines.push('')
  }

  if (env.decisions.length > 0) {
    lines.push(`### Key Decisions`)
    for (const d of env.decisions.slice(0, 5)) {
      lines.push(`- **${d.what}** — ${d.why.slice(0, 100)}`)
    }
    lines.push('')
  }

  if (env.risks.length > 0) {
    lines.push(`### Risks`)
    for (const r of env.risks.slice(0, 5)) {
      lines.push(`- **[${r.severity}]** ${r.risk.slice(0, 100)}`)
    }
    lines.push('')
  }

  if (env.filesToReadFirst.length > 0) {
    lines.push(`### Files to Read First`)
    lines.push(env.filesToReadFirst.slice(0, 10).map((f) => `- \`${f}\``).join('\n'))
    lines.push('')
  }

  return lines.join('\n')
}

function renderFull(env: HandoffEnvelope): string {
  const lines: string[] = []
  lines.push(`## Handoff: ${env.source} → ${env.target}`)
  lines.push(`**ID:** ${env.id}`)
  lines.push(`**Intent:** ${env.intent}`)
  lines.push(`**Original Goal:** ${env.originalGoal.slice(0, 200)}`)
  lines.push(`**Confidence:** ${(env.confidence * 100).toFixed(0)}%`)
  lines.push(`**Priority:** ${env.priority}`)
  lines.push(`**Created:** ${env.createdAt}`)
  if (env.parentHandoffId) {
    lines.push(`**Parent Handoff:** ${env.parentHandoffId}`)
  }
  lines.push('')

  lines.push(env.contextSummary)
  lines.push('')

  if (env.completedWork.length > 0) {
    lines.push(`### Completed Work`)
    for (const step of env.completedWork) {
      lines.push(`- ✓ **${step.title}**: ${step.outcome}`)
      if (step.filesModified?.length) {
        lines.push(`  Files: ${step.filesModified.join(', ')}`)
      }
    }
    lines.push('')
  }

  if (env.remainingWork.length > 0) {
    lines.push(`### Remaining Work`)
    for (const step of env.remainingWork) {
      lines.push(`- **${step.title}** [${step.priority}${step.estimatedComplexity ? `, complexity: ${step.estimatedComplexity}` : ''}]`)
      lines.push(`  ${step.description}`)
    }
    lines.push('')
  }

  if (env.decisions.length > 0) {
    lines.push(`### Decisions Made`)
    for (const d of env.decisions) {
      lines.push(`- **${d.what}**`)
      lines.push(`  Why: ${d.why}`)
      if (d.alternatives?.length) {
        lines.push(`  Alternatives considered: ${d.alternatives.join(', ')}`)
      }
    }
    lines.push('')
  }

  if (env.constraints.length > 0) {
    lines.push(`### Constraints`)
    lines.push(env.constraints.map((c) => `- ${c}`).join('\n'))
    lines.push('')
  }

  if (env.risks.length > 0) {
    lines.push(`### Risks`)
    for (const r of env.risks) {
      lines.push(`- **[${r.severity}]** ${r.risk}`)
      if (r.mitigation) lines.push(`  Mitigation: ${r.mitigation}`)
    }
    lines.push('')
  }

  if (env.artifacts.length > 0) {
    lines.push(`### Artifacts`)
    for (const a of env.artifacts) {
      lines.push(`- [${a.type}] \`${a.path}\`: ${a.description}`)
    }
    lines.push('')
  }

  if (env.codeAnchors && env.codeAnchors.length > 0) {
    lines.push(`### Code Anchors`)
    for (const anchor of env.codeAnchors) {
      lines.push(`- \`${anchor.file}:${anchor.startLine}-${anchor.endLine}\` — ${anchor.title}`)
    }
    lines.push('')
  }

  if (env.filesToReadFirst.length > 0) {
    lines.push(`### Files to Read First`)
    lines.push(env.filesToReadFirst.map((f) => `- \`${f}\``).join('\n'))
    lines.push('')
  }

  if (env.commandsToRunFirst.length > 0) {
    lines.push(`### Commands to Run First`)
    lines.push(env.commandsToRunFirst.map((c) => `- \`${c}\``).join('\n'))
    lines.push('')
  }

  if (env.suggestedTools.length > 0) {
    lines.push(`### Suggested Tools`)
    lines.push(env.suggestedTools.map((t) => `- ${t}`).join('\n'))
    lines.push('')
  }

  if (env.suggestedSkills.length > 0) {
    lines.push(`### Suggested Skills`)
    lines.push(env.suggestedSkills.map((s) => `- ${s}`).join('\n'))
    lines.push('')
  }

  return lines.join('\n')
}

// ── Target Action Descriptors ────────────────────────────────────────
// These describe what should happen when a handoff targets a feature.
// The HandoffService calls the appropriate target handler.

export interface ChatTargetAction {
  type: 'chat'
  /** Markdown to inject as the first system/user message */
  contextMarkdown: string
  /** Compact summary for conversations.handoff_context column */
  handoffContextCompact: string
  /** Conversation mode to use */
  mode: 'plan' | 'build'
  /** Title for the new conversation */
  title: string
}

export interface GrillTargetAction {
  type: 'grill'
  /** Pre-populated idea title */
  ideaTitle: string
  /** Pre-populated idea description */
  ideaDescription: string
}

export interface AuditTargetAction {
  type: 'audit'
  /** Focus areas derived from envelope artifacts/risks */
  focusAreas: string[]
}

export interface CouncilTargetAction {
  type: 'council'
  /** Plan content for council review */
  planContent: string
}

export interface BlueprintTargetAction {
  type: 'blueprint'
  /** Spec seed from envelope context */
  specSeed: string
  /** Settings derived from decisions */
  settings: Record<string, unknown>
}

export interface GoalsTargetAction {
  type: 'goals'
  /** Pre-loaded goal from remaining work */
  goalTitle: string
  /** Goal description */
  goalDescription: string
}

export type TargetAction =
  | ChatTargetAction
  | GrillTargetAction
  | AuditTargetAction
  | CouncilTargetAction
  | BlueprintTargetAction
  | GoalsTargetAction

// ── Target Resolvers ─────────────────────────────────────────────────

export function resolveTargetAction(envelope: HandoffEnvelope): TargetAction {
  switch (envelope.target) {
    case 'chat':
      return resolveChatTarget(envelope)
    case 'grill':
      return resolveGrillTarget(envelope)
    case 'audit':
      return resolveAuditTarget(envelope)
    case 'council':
      return resolveCouncilTarget(envelope)
    case 'blueprint':
      return resolveBlueprintTarget(envelope)
    case 'goals':
      return resolveGoalsTarget(envelope)
    default:
      throw new Error(`Unknown handoff target: ${envelope.target}`)
  }
}

function resolveChatTarget(envelope: HandoffEnvelope): ChatTargetAction {
  return {
    type: 'chat',
    contextMarkdown: renderEnvelopeMarkdown(envelope, 'standard'),
    handoffContextCompact: renderEnvelopeMarkdown(envelope, 'compact'),
    mode: envelope.remainingWork.length > 0 ? 'plan' : 'build',
    title: `Handoff: ${envelope.intent}`,
  }
}

function resolveGrillTarget(envelope: HandoffEnvelope): GrillTargetAction {
  return {
    type: 'grill',
    ideaTitle: envelope.intent.slice(0, 100),
    ideaDescription: envelope.contextSummary,
  }
}

function resolveAuditTarget(envelope: HandoffEnvelope): AuditTargetAction {
  const focusAreas: string[] = []
  // Derive focus from risks (capped to 10)
  for (const risk of envelope.risks.slice(0, 10)) {
    focusAreas.push(risk.risk)
  }
  // Derive focus from remaining work
  for (const step of envelope.remainingWork.slice(0, 5)) {
    focusAreas.push(step.title)
  }
  return { type: 'audit', focusAreas }
}

function resolveCouncilTarget(envelope: HandoffEnvelope): CouncilTargetAction {
  return {
    type: 'council',
    planContent: renderEnvelopeMarkdown(envelope, 'full'),
  }
}

function resolveBlueprintTarget(envelope: HandoffEnvelope): BlueprintTargetAction {
  const settings: Record<string, unknown> = {}
  for (const d of envelope.decisions) {
    settings[d.what] = d.why
  }
  return {
    type: 'blueprint',
    specSeed: envelope.contextSummary,
    settings,
  }
}

function resolveGoalsTarget(envelope: HandoffEnvelope): GoalsTargetAction {
  const firstGoal = envelope.remainingWork[0]
  return {
    type: 'goals',
    goalTitle: firstGoal?.title ?? envelope.intent,
    goalDescription: firstGoal?.description ?? envelope.contextSummary,
  }
}
