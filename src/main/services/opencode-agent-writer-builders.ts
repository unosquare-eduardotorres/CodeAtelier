/**
 * Pure template builders extracted from OpenCodeAgentWriter.
 *
 * These functions assemble markdown content, YAML frontmatter, and agent
 * configuration strings. They are stateless and have no I/O side effects,
 * making them directly testable.
 *
 * Phase 4A — coverage extraction from opencode-agent-writer.ts (519 LOC, 27%).
 */

import type { OpenCodeProviderConfig } from './opencode-executor'

// ── Types ──

export interface AgentContentOptions {
  provider: OpenCodeProviderConfig
  mode: 'plan' | 'build' | 'danger'
  maxTurns?: number
  davinciSystemPrompt?: string
  specialistSystemPrompt?: string
  specialistName?: string
}

// ── Permission Block ──

/**
 * Build YAML permission block matching plan/build/danger mode.
 * Deduplicates the identical logic from writeDaVinciAgent and writeSpecialistAgent.
 */
export function buildPermissionBlock(mode: 'plan' | 'build' | 'danger'): string {
  return mode === 'build' || mode === 'danger'
    ? 'permission:\n  Write: allow\n  Edit: allow\n  Bash: allow\n  task: allow'
    : 'permission:\n  Write: ask\n  Edit: ask\n  Bash: ask\n  task: deny'
}

// ── Agent Turns ──

/**
 * Resolve maxTurns and steps from optional input and mode.
 * Build mode gets full turns; plan mode caps steps at 30.
 */
export function calculateAgentTurns(
  maxTurns: number | undefined,
  mode: string
): { maxTurns: number; steps: number } {
  const resolved = maxTurns ?? (mode === 'build' ? 50 : 30)
  const steps = mode === 'build' ? resolved : Math.min(resolved, 30)
  return { maxTurns: resolved, steps }
}

// ── Provider Options ──

/**
 * Generate provider-specific YAML frontmatter options for agent files.
 *
 * F-1: Anthropic extended thinking budget (budgetTokens)
 * F-2: OpenAI reasoning effort (reasoningEffort)
 * F-3: Per-agent tool restrictions
 */
export function buildProviderOptions(
  providerId: string,
  mode: 'plan' | 'build' | 'danger'
): string {
  const lines: string[] = []

  switch (providerId) {
    case 'anthropic':
      lines.push('thinking:')
      lines.push('  type: enabled')
      lines.push(`  budgetTokens: ${mode === 'build' || mode === 'danger' ? 32000 : 16000}`)
      break

    case 'openai':
      lines.push(`reasoningEffort: ${mode === 'build' || mode === 'danger' ? 'high' : 'medium'}`)
      break

    case 'ollama':
    case 'omlx':
      lines.push('temperature: 0.6')
      break
  }

  // F-3: Per-agent tool restrictions — disable question tool (we use our own)
  lines.push('tools:')
  lines.push('  question: false')

  return lines.join('\n')
}

// ── DaVinci Content ──

/**
 * Assemble the full DaVinci agent markdown content from resolved options.
 * This is the pure template logic extracted from writeDaVinciAgent().
 */
export function buildDaVinciContent(opts: AgentContentOptions): string {
  const model = `${opts.provider.providerId}/${opts.provider.modelId}`
  const { maxTurns, steps } = calculateAgentTurns(opts.maxTurns, opts.mode)
  const permissionBlock = buildPermissionBlock(opts.mode)
  const providerOptions = buildProviderOptions(opts.provider.providerId, opts.mode)

  return `---
name: DaVinci
description: Expert AI development partner for Code Atelier — analyzes, plans, and builds software.
mode: primary
model: ${model}
steps: ${steps}
max_turns: ${maxTurns}
temperature: 0.7
color: "#4A9EFF"
${permissionBlock}
${providerOptions}
---

# DaVinci — Expert Development Partner

You are **DaVinci**, the default AI development partner for Code Atelier.

## Core Identity

You are an expert-level software engineer who pairs with the developer to
analyze, plan, and build software. You combine deep technical knowledge with
practical experience across the full stack.

## Behavioral Guidelines

- **Plan Mode**: Analyze codebases, create plans, answer questions. Read-only
  tools only (Read, Glob, Grep, CodeGraph). Never modify files without explicit
  permission.
- **Build Mode**: Implement plans, write code, run tests, fix bugs. Full tool
  access including Write, Edit, Bash.
- Always read files before editing them.
- Use CodeGraph tools before Grep for code navigation.
- Keep responses focused and actionable.
- When creating plans, structure them with clear phases and tasks.

## Tool Usage Constraints

- Maximum ${maxTurns} tool calls per interaction
- Use \`Read\` with \`limit: 300\` for large files
- Background long-running commands with \`&\`
- Never access files outside the workspace directory

## Built-in Subagents (GAP-18)

When appropriate, delegate to OpenCode's built-in subagents:
- **Scout** — Read-only. Use for external docs lookup, dependency research, API exploration.
  Invoke via the \`task\` tool when you need background research without modifying files.
- **Explore** — Read-only, fast. Use for codebase navigation and structure discovery when
  CodeGraph tools aren't sufficient (e.g. cross-repo or unfamiliar codebases).
- **General** — Full access. Use for multi-step parallel tasks (e.g. run tests while
  refactoring, or generate docs while implementing).

## System Prompt Delivery

C-2: Workspace-specific instructions are injected via the
\`experimental.chat.system.transform\` plugin hook into the real system prompt
position. They are NOT duplicated here to avoid token waste.
`
}

// ── Specialist Content ──

/**
 * Assemble the full Specialist agent markdown content from resolved options.
 * This is the pure template logic extracted from writeSpecialistAgent().
 */
export function buildSpecialistContent(opts: AgentContentOptions): string {
  const model = `${opts.provider.providerId}/${opts.provider.modelId}`
  const name = opts.specialistName ?? 'Project Specialist'
  const { maxTurns, steps } = calculateAgentTurns(opts.maxTurns, opts.mode)
  const permissionBlock = buildPermissionBlock(opts.mode)
  const providerOptions = buildProviderOptions(opts.provider.providerId, opts.mode)

  return `---
name: ${name}
description: LLM-tailored expert configured for this workspace's technology stack and conventions.
mode: primary
model: ${model}
steps: ${steps}
max_turns: ${maxTurns}
temperature: 0.7
color: "#FF6B35"
${permissionBlock}
${providerOptions}
---

# ${name} — LLM-Tailored Expert

You are a **${name}**, an AI expert specifically configured for this workspace's
technology stack. Your expertise has been built from analyzing this project's
CLAUDE.md, dependencies, architecture, and coding conventions.

## Specialization

${opts.specialistSystemPrompt ?? 'No specialization prompt available.'}

## Behavioral Guidelines

- Follow all workspace conventions from CLAUDE.md
- Use CodeGraph tools for code navigation before text search
- Respect the current conversation mode (plan vs build)
- Keep responses aligned with the project's established patterns

## Tool Usage Constraints

- Maximum ${maxTurns} tool calls per interaction
- Use \`Read\` with \`limit: 300\` for large files
- Background long-running commands with \`&\`
- Never access files outside the workspace directory

## Built-in Subagents (GAP-18)

- **Scout** — Read-only research agent for docs and dependency exploration.
- **Explore** — Fast read-only codebase navigation.
- **General** — Full-access multi-step parallel worker for background tasks.

Use the \`task\` tool to spawn subagents when beneficial.
`
}
