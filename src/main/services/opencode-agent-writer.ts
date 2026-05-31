/**
 * OpenCode Agent Writer — generates .opencode/agents/*.md files.
 *
 * #6: OpenCode supports custom agent definitions that let us map our
 * DaVinci and Project Specialist roles to native OpenCode agents with:
 *   - Per-agent model overrides
 *   - Role-specific system prompts
 *   - Permission configs matching our plan/build mode
 *   - Tab-switchable in the OpenCode TUI
 *
 * These agent files are generated on workspace initialization and updated
 * when the specialist is rebuilt or settings change.
 *
 * Reference: https://opencode.ai/docs/agents/
 * Phase 5D — OpenCode Enhancement: Custom agent definitions.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import type { OpenCodeProviderConfig } from './opencode-executor'

const agentLog = log.scope('OpenCodeAgentWriter')

// ── Types ──

export interface OpenCodeAgentOptions {
  /** Workspace root path */
  workspacePath: string
  /** Provider config for model resolution */
  provider: OpenCodeProviderConfig
  /** DaVinci system prompt (from the adapter's prompt assembler) */
  davinciSystemPrompt?: string
  /** Project Specialist system prompt (from the specialist adapter) */
  specialistSystemPrompt?: string
  /** Specialist display name (e.g. "React Expert" / "Django Architect") */
  specialistName?: string
  /** Current conversation mode — drives permission config */
  mode: 'plan' | 'build' | 'danger'
  /** Max turns for the agent loop */
  maxTurns?: number
}

// ── Writer ──

export class OpenCodeAgentWriter {
  /**
   * Generate both agent definition files and custom commands for the workspace.
   *
   * Creates:
   *   - .opencode/agents/davinci.md — default expert partner
   *   - .opencode/agents/project-specialist.md — LLM-tailored specialist (if available)
   *   - .opencode/commands/*.md — custom slash commands for Code Atelier workflows
   */
  writeAgents(opts: OpenCodeAgentOptions): void {
    const agentDir = join(opts.workspacePath, '.opencode', 'agents')
    if (!existsSync(agentDir)) {
      mkdirSync(agentDir, { recursive: true })
    }

    // Always write DaVinci
    this.writeDaVinciAgent(agentDir, opts)

    // Write specialist if available
    if (opts.specialistSystemPrompt) {
      this.writeSpecialistAgent(agentDir, opts)
    }

    // D-3: Disable specialist agent if prompt is gone but file remains
    if (!opts.specialistSystemPrompt) {
      this.disableSpecialistIfExists(agentDir)
    }

    // E-2: Generate custom commands
    this.writeCommands(opts.workspacePath, opts)

    // E-3: Validate skills frontmatter for OpenCode compatibility
    this.validateSkillsFrontmatter(opts.workspacePath)

    agentLog.info(
      `[opencode-agents] Wrote agent definitions to ${agentDir} ` +
        `(specialist=${!!opts.specialistSystemPrompt})`
    )
  }

  /**
   * Clean up agent definition files.
   */
  dispose(workspacePath: string): void {
    // Agent files are part of the workspace's .opencode directory —
    // we don't delete them since they may be tracked in git or
    // useful for standalone OpenCode usage.
    agentLog.info(`[opencode-agents] Dispose called for ${workspacePath} (no-op — files preserved)`)
  }

  // ── Private ──

  private writeDaVinciAgent(agentDir: string, opts: OpenCodeAgentOptions): void {
    const model = `${opts.provider.providerId}/${opts.provider.modelId}`
    const maxTurns = opts.maxTurns ?? (opts.mode === 'build' ? 50 : 30)
    const steps = opts.mode === 'build' ? maxTurns : Math.min(maxTurns, 30)

    // ENH-2: Build per-agent permission block matching our plan/build mode
    // GAP-18: task: allow in build mode enables subagent spawning
    const permissionBlock =
      opts.mode === 'build'
        ? 'permission:\n  Write: allow\n  Edit: allow\n  Bash: allow\n  task: allow'
        : 'permission:\n  Write: ask\n  Edit: ask\n  Bash: ask\n  task: deny'

    // F-1/F-2/F-3: Provider-specific frontmatter options
    const providerOptions = this.buildProviderOptions(opts.provider.providerId, opts.mode)
    const content = `---
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

    writeFileSync(join(agentDir, 'davinci.md'), content, 'utf-8')
  }

  private writeSpecialistAgent(agentDir: string, opts: OpenCodeAgentOptions): void {
    const model = `${opts.provider.providerId}/${opts.provider.modelId}`
    const name = opts.specialistName ?? 'Project Specialist'
    const maxTurns = opts.maxTurns ?? (opts.mode === 'build' ? 50 : 30)
    const steps = opts.mode === 'build' ? maxTurns : Math.min(maxTurns, 30)

    // ENH-2: Per-agent permission block
    // GAP-18: task: allow in build mode enables subagent spawning
    const permissionBlock =
      opts.mode === 'build'
        ? 'permission:\n  Write: allow\n  Edit: allow\n  Bash: allow\n  task: allow'
        : 'permission:\n  Write: ask\n  Edit: ask\n  Bash: ask\n  task: deny'

    const content = `---
name: ${name}
description: LLM-tailored expert configured for this workspace's technology stack and conventions.
mode: primary
model: ${model}
steps: ${steps}
max_turns: ${maxTurns}
temperature: 0.7
color: "#FF6B35"
${permissionBlock}
${this.buildProviderOptions(opts.provider.providerId, opts.mode)}
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

    writeFileSync(join(agentDir, 'project-specialist.md'), content, 'utf-8')
  }

  // ── D-3: Disable Specialist When Prompt Removed ──

  /**
   * D-3: When specialistSystemPrompt is undefined but a specialist.md file exists,
   * write `disable: true` in its frontmatter instead of leaving an orphaned file.
   */
  private disableSpecialistIfExists(agentDir: string): void {
    const specialistPath = join(agentDir, 'project-specialist.md')
    if (!existsSync(specialistPath)) return

    try {
      const content = readFileSync(specialistPath, 'utf-8')
      // Check if already disabled
      if (content.includes('disable: true')) return

      // Add disable: true to frontmatter
      const disabledContent = content.replace(/^---\n/, '---\ndisable: true\n')
      writeFileSync(specialistPath, disabledContent, 'utf-8')
      agentLog.info('[opencode-agents] Disabled orphaned specialist agent (no system prompt)')
    } catch (err) {
      agentLog.warn(`[opencode-agents] Failed to disable specialist: ${(err as Error).message}`)
    }
  }

  // ── F-1/F-2/F-3: Provider-Specific Frontmatter Options ──

  /**
   * Generate provider-specific frontmatter options for agent files.
   *
   * F-1: Anthropic extended thinking budget (budgetTokens)
   * F-2: OpenAI reasoning effort (reasoningEffort)
   * F-3: Per-agent tool restrictions
   */
  private buildProviderOptions(providerId: string, mode: 'plan' | 'build' | 'danger'): string {
    const lines: string[] = []

    switch (providerId) {
      case 'anthropic':
        // F-1: Extended thinking for Anthropic models — higher budget in build mode
        // for complex multi-step implementations
        lines.push('thinking:')
        lines.push('  type: enabled')
        lines.push(`  budgetTokens: ${mode === 'build' ? 32000 : 16000}`)
        break

      case 'openai':
        // F-2: Reasoning effort for GPT-5+ models — higher in build mode
        lines.push(`reasoningEffort: ${mode === 'build' ? 'high' : 'medium'}`)
        break

      case 'ollama':
      case 'omlx':
        // Local models — no special options but reduce temperature for consistency
        lines.push('temperature: 0.5')
        break
    }

    // F-3: Per-agent tool restrictions — disable question tool (we use our own)
    lines.push('tools:')
    lines.push('  question: false')

    return lines.join('\n')
  }

  // ── E-3: Skills Frontmatter Validation ──

  /**
   * Validate that .claude/skills/ SKILL.md files have valid OpenCode-compatible
   * frontmatter. OpenCode requires:
   *   - `name`: lowercase, hyphenated, 1-64 chars, regex ^[a-z0-9]+(-[a-z0-9]+)*$
   *   - `description`: 1-1024 chars
   */
  private validateSkillsFrontmatter(workspacePath: string): void {
    const skillDirs = [
      join(workspacePath, '.claude', 'skills'),
      join(workspacePath, '.opencode', 'skills')
    ]

    const namePattern = /^[a-z0-9]+(-[a-z0-9]+)*$/
    let validCount = 0
    let invalidCount = 0

    for (const skillsDir of skillDirs) {
      if (!existsSync(skillsDir)) continue

      const entries = readdirSync(skillsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillFile = join(skillsDir, entry.name, 'SKILL.md')
        if (!existsSync(skillFile)) continue

        try {
          const content = readFileSync(skillFile, 'utf-8')
          const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
          if (!frontmatterMatch) {
            agentLog.warn(`[opencode-agents] Missing frontmatter: ${skillFile}`)
            invalidCount++
            continue
          }

          const frontmatter = frontmatterMatch[1]
          const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
          const descMatch = frontmatter.match(/^description:/m)

          if (!nameMatch) {
            agentLog.warn(`[opencode-agents] Missing 'name' in frontmatter: ${skillFile}`)
            invalidCount++
            continue
          }

          const name = nameMatch[1].trim().replace(/['"]*/g, '')
          if (!namePattern.test(name)) {
            agentLog.warn(
              `[opencode-agents] Invalid skill name "${name}" in ${skillFile} — ` +
                `must match ^[a-z0-9]+(-[a-z0-9]+)*$`
            )
            invalidCount++
            continue
          }

          if (!descMatch) {
            agentLog.warn(`[opencode-agents] Missing 'description' in frontmatter: ${skillFile}`)
            invalidCount++
            continue
          }

          validCount++
        } catch (err) {
          agentLog.warn(
            `[opencode-agents] Failed to read skill: ${skillFile}: ${(err as Error).message}`
          )
        }
      }
    }

    if (invalidCount > 0) {
      agentLog.warn(
        `[opencode-agents] Skills validation: ${validCount} valid, ${invalidCount} invalid — ` +
          `invalid skills will silently fail to load in OpenCode`
      )
    } else if (validCount > 0) {
      agentLog.info(
        `[opencode-agents] Skills validation: all ${validCount} skills have valid frontmatter`
      )
    }
  }

  // ── E-2: Custom Commands ──

  /**
   * Generate .opencode/commands/ with Code Atelier workflow shortcuts.
   *
   * Custom commands support $ARGUMENTS, $1/$2 positional params, !command shell
   * injection, @filename file references, agent/model overrides, and subtask: true
   * for subagent isolation.
   */
  private writeCommands(workspacePath: string, _opts: OpenCodeAgentOptions): void {
    const commandDir = join(workspacePath, '.opencode', 'commands')
    if (!existsSync(commandDir)) {
      mkdirSync(commandDir, { recursive: true })
    }

    // /audit — Trigger workspace health audit
    writeFileSync(
      join(commandDir, 'audit.md'),
      `---
description: Run a workspace health audit scanning code quality, test coverage, security, and dependencies.
agent: DaVinci
---

Perform a comprehensive workspace health audit for scope: $ARGUMENTS

Analyze:
1. Code quality issues (complexity, dead code, naming)
2. Test coverage gaps
3. Security concerns (exposed secrets, unsafe patterns)
4. Dependency health (outdated, vulnerable, unused)

Use the code_atelier_audit tool to record findings.
If no scope is specified, audit the entire workspace.

!git diff --stat HEAD~5
`,
      'utf-8'
    )

    // /plan — Create a structured implementation plan
    writeFileSync(
      join(commandDir, 'plan.md'),
      `---
description: Create a structured implementation plan for a feature or change.
agent: DaVinci
---

Create a structured implementation plan for: $ARGUMENTS

Follow this structure:
1. Analyze the current codebase state relevant to this change
2. Break down into phases with clear tasks
3. Identify risks and dependencies
4. Estimate effort for each task

Use the code_atelier_plan tool to emit the plan for UI tracking.
Read CLAUDE.md and relevant source files before planning.
`,
      'utf-8'
    )

    // /review — Code review a specific file or directory
    writeFileSync(
      join(commandDir, 'review.md'),
      `---
description: Perform a thorough code review of a file or directory.
agent: DaVinci
subtask: true
---

Perform a thorough code review of: $ARGUMENTS

Check for:
- Correctness and edge cases
- Performance issues
- Security vulnerabilities
- Adherence to project conventions (read CLAUDE.md)
- Test coverage
- Code clarity and maintainability

Use CodeGraph tools (find_callers, find_references) to understand impact.
@$1
`,
      'utf-8'
    )

    // /test — Run and analyze tests
    writeFileSync(
      join(commandDir, 'test.md'),
      `---
description: Run tests and analyze results, fixing failures if found.
agent: DaVinci
---

Run and analyze tests for: $ARGUMENTS

1. Run the relevant test suite
2. Analyze any failures
3. If tests fail, diagnose the root cause
4. Suggest or implement fixes

!npm test -- $ARGUMENTS 2>&1 | head -100
`,
      'utf-8'
    )

    // /grill — Challenge assumptions about a file
    writeFileSync(
      join(commandDir, 'grill.md'),
      `---
description: Challenge assumptions and find hidden issues in a file or component.
agent: DaVinci
subtask: true
---

Grill this code — challenge every assumption and find hidden issues: $ARGUMENTS

Be adversarial. Look for:
- Implicit assumptions that could break
- Missing error handling
- Race conditions
- Untested edge cases
- Security issues
- Performance cliffs
- API misuse

@$1
`,
      'utf-8'
    )

    agentLog.info(`[opencode-agents] Wrote 5 custom commands to ${commandDir}`)
  }
}

/** Singleton instance */
export const openCodeAgentWriter = new OpenCodeAgentWriter()
