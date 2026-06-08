import type { GrillDecision, MpaPlanArtifact, MpaVerifyReport } from '../../shared/mpa-types'
import { sanitizePromptInput } from './sanitize-prompt-input'
import { resolvePromptVerbosity } from '../../shared/constants'

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
  const isLean = resolvePromptVerbosity(params.model ?? '') === 'lean'

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

  if (isLean) {
    prompt += `
## Instructions
Investigate the codebase with code graph and search tools. Produce one \`goal-plan\` JSON block:
{goalType, summary, items: [{id, title, description, files, scope, dependsOn, includesTests}], risks, existingPatterns}

## Rules
Read-only. Reference specific file paths. Order by dependency chain. Include tests within items (not separate). Reference existing patterns. Specific enough for an unfamiliar agent. One \`goal-plan\` block only.`
  } else {
    prompt += `
## What to Do
Investigate the codebase using code graph and search tools to understand the architecture, existing patterns, and integration points. Then produce a structured implementation plan.

## Output Format
Emit exactly one fenced JSON code block tagged \`goal-plan\`:

\`\`\`goal-plan
{
  "goalType": "feature" | "refactor" | "bugfix" | "tests",
  "summary": "2-3 sentence approach summary",
  "items": [
    {
      "id": "P1",
      "title": "Short descriptive title",
      "description": "What to implement, referencing existing patterns found in the codebase",
      "files": ["src/services/user.service.ts"],
      "scope": "backend" | "frontend" | "database" | "shared" | "tests",
      "dependsOn": [],
      "includesTests": true
    }
  ],
  "risks": ["Risk if any"],
  "existingPatterns": ["Pattern found in file X — follow for consistency"]
}
\`\`\`

## Constraints
- Read-only — do not create, modify, or delete files.
- Every item must reference specific file paths, not vague descriptions.
- Order items by dependency chain (dependsOn references other item IDs).
- Include test writing within implementation items (includesTests: true), not as separate items.
- Reference existing patterns you find — the builder should follow them.
- The plan must be specific enough for an agent that has never seen the codebase.
- Emit exactly one \`goal-plan\` block. No optional or nice-to-have items.`
  }

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
  const isLean = resolvePromptVerbosity(params.model ?? '') === 'lean'

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

  if (isLean) {
    prompt += `
## Instructions
Implement every plan item in dependency order. Read existing code first, then implement. Write tests where includesTests: true. Run tests after all implementation, fix failures.

## Rules
Implement all items. No extras beyond plan. No TODOs or stubs. Match existing style. Report test command, pass/fail count, and failures.`
  } else {
    prompt += `
## What to Do
Implement every plan item in dependency order. For each item, read existing code first to understand patterns, then implement. Write tests where items have includesTests: true. After implementing everything, run the project's test command and fix any failures.

## Constraints
- Implement every plan item — do not skip any.
- Do not add features beyond the plan.
- No TODOs, stubs, or placeholder code — every function must be complete.
- Match existing code style, naming, and import conventions.
- Run tests after all implementation is complete. Fix failures before stopping.
- After running tests, report the command used, pass/fail count, and any failure messages in your response.`
  }

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
  const isLean = resolvePromptVerbosity(params.model ?? '') === 'lean'

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

  let prompt: string

  if (isLean) {
    prompt = `You are the Goal Verifier — a read-only auditor checking plan implementation. Fresh pair of eyes.

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
Read-only. Verify every item. Read files before marking implemented. Run actual tests.`
  } else {
    prompt = `You are the Goal Verifier — a read-only auditor checking whether every plan item was actually implemented. You did not write this code. You are a fresh pair of eyes.

## Goal
${sanitizePromptInput(params.goal)}

## Plan to Verify
${planItems}

## What to Do
For each plan item, verify: files exist, functionality is present (read the code), pieces are integrated (routes registered, services imported), and tests exist where expected. Also check cross-layer connections: frontend calls correct APIs, backend uses correct models, routes are accessible. Run the project test command and report results.
${criteriaSection}

## Output Format
For each plan item, emit a verification block:

\`\`\`goal-verify-item
{"planItemId": "P1", "status": "implemented" | "partial" | "missing", "detail": "What was found or missing", "filesChecked": ["path"]}
\`\`\`

After all items, emit the final report:

\`\`\`goal-verify-report
{
  "allComplete": true | false,
  "totalItems": ${params.plan.items.length},
  "implemented": 0,
  "partial": 0,
  "missing": 0,
  "issues": [
    {"planItemId": "P3", "status": "partial", "detail": "Route exists but error handler is a stub", "filesChecked": ["path"]}
  ],
  "crossCutting": {
    "frontendBackendConnected": true | false,
    "backendDatabaseConnected": true | false,
    "routesRegistered": true | false,
    "testsPass": true | false
  },
  "testOutput": "summary of test results"${
    hasCriteria
      ? ',\n  "criteriaResults": [\n    {"criterion": "<exact criterion text>", "status": "pass" | "fail", "detail": "evidence from the codebase"}\n  ]'
      : ''
  }
}
\`\`\`

## Constraints
- Read-only. Do not modify any files, even if you find issues — only report them.
- Verify every plan item. Do not skip any.
- Read actual files before marking items as implemented — do not assume.
- Run the actual test command — do not guess at results.`
  }

  return prompt
}
