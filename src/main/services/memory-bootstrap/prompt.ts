/**
 * Deep Scan agent prompt + adaptive budget.
 */

export interface AgentBudget {
  maxTurns: number
  maxFacts: number
  timeoutMs: number
}

export function computeAgentBudget(metrics: {
  fileCount: number
  docCount: number
  hasDeepDocs: boolean
  codebaseSize: 'small' | 'medium' | 'large'
}): AgentBudget {
  if (metrics.codebaseSize === 'large' || metrics.docCount > 50) {
    return { maxTurns: 80, maxFacts: 40, timeoutMs: 20 * 60 * 1000 }
  }
  if (
    metrics.codebaseSize === 'medium' ||
    metrics.docCount > 20 ||
    (metrics.hasDeepDocs && metrics.docCount > 10)
  ) {
    return { maxTurns: 50, maxFacts: 25, timeoutMs: 15 * 60 * 1000 }
  }
  return { maxTurns: 30, maxFacts: 15, timeoutMs: 10 * 60 * 1000 }
}

export function buildDeepScanPrompt(
  topFilesContext: string,
  existingFactsSummary: string,
  budget: { maxFacts: number }
): string {
  return `You are a codebase exploration agent. Your job is to systematically explore this project and record non-obvious architectural facts using the mcp__memory__memory_record tool.

## Instructions

1. Start by reading the project's main entry points, configuration files, and README.
2. Use the code-graph tools (mcp__code-graph__graph_map, mcp__code-graph__file_outline, mcp__code-graph__find_callers, mcp__code-graph__find_references) to understand the architecture.
3. For each important discovery, call mcp__memory__memory_record with:
   - A clear, concise title (5-15 words)
   - Actionable content (1-3 sentences)
   - Appropriate category: "decision", "convention", "gotcha", "preference", or "reference"
   - Relevant tags and scope paths

## Focus Areas
- Service boundaries and responsibilities
- Data flow patterns (IPC, events, stores)
- Configuration and environment conventions
- Error handling patterns
- Database schema and migration conventions
- Testing patterns and infrastructure
- Build and deployment pipeline
- Shared utilities and helper patterns
- Security conventions (validation, auth, input sanitization)
- Naming conventions and code organization

## Rules
- Record up to ${budget.maxFacts} facts — be thorough for large projects
- Prioritize depth on rich documentation files (CLAUDE.md, ARCHITECTURE.md, etc.)
- For each documentation file, extract ALL non-obvious conventions and decisions
- Only skip facts that are trivially discoverable from a single file read
- Each fact must be self-contained and actionable
- Use mcp__memory__memory_search before recording to avoid duplicates
- Focus on decisions, constraints, and gotchas — not descriptions
${topFilesContext}
${existingFactsSummary}

Begin by reading the project root files, then explore the most central modules.`
}
