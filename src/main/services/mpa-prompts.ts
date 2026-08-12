import type { GrillDecision, MpaPlanArtifact, MpaVerifyReport } from '../../shared/mpa-types'
import { sanitizePromptInput } from './sanitize-prompt-input'

// ── Phase 1: Planner Agent Prompt ──

export function buildPlannerSystemPrompt(params: {
  goal: string
  workspaceName: string
  detectedTechs: string[]
  grillDecisions?: GrillDecision[]
  previousPlan?: { contentJson: MpaPlanArtifact }
  userFeedback?: string
  model?: string
}): string {
  let prompt = `You are the Goal Planner — a read-only architect creating implementation plans.

## Goal
${sanitizePromptInput(params.goal)}

## Workspace
- **Name**: ${sanitizePromptInput(params.workspaceName)}
- **Stack**: ${params.detectedTechs.join(', ') || 'Inspect project files to determine'}
`

  if (params.grillDecisions?.length) {
    prompt += `
## Grill Decisions (treat as constraints)
${params.grillDecisions.map((d) => `- **${sanitizePromptInput(d.header)}**: ${sanitizePromptInput(d.selectedOption)} — ${sanitizePromptInput(d.reason)}`).join('\n')}
`
  }

  if (params.previousPlan && params.userFeedback) {
    prompt += `
## Previous Plan — Revise Based on Feedback
${sanitizePromptInput(params.userFeedback)}

Previous plan:
\`\`\`json
${JSON.stringify(params.previousPlan.contentJson, null, 2)}
\`\`\`
`
  }

  // W3-F9: Unified planner instructions — compact format for all models
  prompt += `
## Instructions
Investigate the codebase with code graph and search tools. Produce one \`goal-plan\` JSON block:
{goalType, summary, items: [{id, title, description, files, scope, dependsOn, includesTests}], risks, existingPatterns}

## Rules
Read-only. Reference specific file paths. Order by dependency chain. Include tests within items (not separate). Reference existing patterns. Specific enough for an unfamiliar agent. One \`goal-plan\` block only.`

  return prompt
}

// ── Phase 2: Builder Agent Prompt ──

export function buildBuilderSystemPrompt(params: {
  goal: string
  plan: MpaPlanArtifact
  workspaceName: string
  detectedTechs: string[]
  verifierFeedback?: MpaVerifyReport
  model?: string
}): string {
  const planItems = params.plan.items
    .map(
      (item) =>
        `- **${item.id}: ${item.title}** — ${item.description}\n  Files: ${item.files.join(', ')}${item.includesTests ? ' (includes tests)' : ''}`
    )
    .join('\n')

  const patterns =
    params.plan.existingPatterns?.map((p) => `- ${p}`).join('\n') ||
    'None noted — match existing conventions'

  let prompt = `You are the Goal Builder — implement the approved plan below completely.

## Goal
${sanitizePromptInput(params.goal)}

## Approved Plan
${planItems}

## Existing Patterns to Follow
${patterns}

## Workspace
- **Name**: ${sanitizePromptInput(params.workspaceName)}
- **Stack**: ${params.detectedTechs.join(', ')}
`

  if (params.verifierFeedback) {
    prompt += `
## Verifier Issues (fix all of these)
${params.verifierFeedback.issues
  .map((i) => `- **${i.planItemId}** (${i.status}): ${i.detail}`)
  .join('\n')}
`
  }

  // W3-F10: Unified builder instructions — lean used for all models
  prompt += `
## Instructions
Implement every plan item in dependency order. Read existing code first, then implement. Write tests where includesTests: true. Run tests after all implementation, fix failures.

## Rules
Implement all items. No extras beyond plan. No TODOs or stubs. Match existing style. Report test command, pass/fail count, and failures.`

  return prompt
}

// ── Phase 3: Verifier Agent Prompt ──

export function buildVerifierSystemPrompt(params: {
  goal: string
  plan: MpaPlanArtifact
  workspaceName: string
  successCriteria?: string[]
  model?: string
}): string {
  const planItems = params.plan.items
    .map(
      (item) =>
        `- **${item.id}: ${item.title}** — files: ${item.files.join(', ')} (scope: ${item.scope}${item.includesTests ? ', has tests' : ''})`
    )
    .join('\n')

  const criteria = (params.successCriteria ?? []).filter((c) => c.trim().length > 0)
  const hasCriteria = criteria.length > 0
  const criteriaList = criteria.map((c, i) => `${i + 1}. ${sanitizePromptInput(c)}`).join('\n')
  // Section appended to the system prompt when explicit success criteria exist.
  const criteriaSection = hasCriteria
    ? `\n## Success Criteria (must ALL pass)\n${criteriaList}\n\nIn addition to verifying plan items, judge each success criterion above against the actual codebase. Include a \`criteriaResults\` array in the final report with one entry per criterion: {"criterion": "<exact text>", "status": "pass" | "fail", "detail": "evidence"}. Set allComplete to false if ANY criterion fails.`
    : ''

  // W3-F8: Unified verifier prompt — compact JSON format for all models
  const prompt = `You are the Goal Verifier — a read-only auditor checking plan implementation. Fresh pair of eyes.

## Goal
${sanitizePromptInput(params.goal)}

## Plan to Verify
${planItems}

## Instructions
For each item: verify files exist, functionality present, integration complete, tests exist. Check cross-layer connections. Run tests.
${criteriaSection}

Emit per-item \`goal-verify-item\` blocks: {planItemId, status: "implemented"|"partial"|"missing", detail, filesChecked}
Then one \`goal-verify-report\`: {allComplete, totalItems: ${params.plan.items.length}, implemented, partial, missing, issues, crossCutting: {frontendBackendConnected, backendDatabaseConnected, routesRegistered, testsPass}, testOutput${hasCriteria ? ', criteriaResults' : ''}}

## Rules
Read-only. Verify every item. Read files before marking implemented.
Use Bash to run tests (\`npm test -- --passWithNoTests 2>&1 | head -100\`), lint (\`npx eslint --no-warn <paths>\`), and type checks (\`npx tsc --noEmit 2>&1 | head -80\`).
Do NOT use Write or Edit.`

  return prompt
}
