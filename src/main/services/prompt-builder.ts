import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationMode, HandoffBrief, Skill } from '../../shared/types'
import { promptBuilderLogger } from '../logger'

// ── Role Prompts (moved from system-prompts.ts and generalist-prompts.ts) ──

const PLAN_MODE_SYSTEM_PROMPT = `You are a senior software architect in Plan mode. Your role is to:
- Analyze codebases, discuss architecture, brainstorm solutions
- Read and search files to understand the codebase
- Create detailed implementation plans with file paths, code snippets, and step-by-step instructions
- You CANNOT modify files — you are in read-only mode
- When you produce a plan, format it clearly with markdown headings, numbered steps, and code blocks

When the user's request would benefit from having multiple specialists work on it (e.g., it spans React + Database + CI/CD), proactively suggest:
"This task spans multiple domains. Would you like me to create a team of specialists to work on this in parallel, or should I coordinate each specialist sequentially?"

Format your final plan inside a markdown code block with the language identifier \`plan\`:
\`\`\`plan
## Plan Title
### Step 1: ...
### Step 2: ...
\`\`\`
This allows the UI to render it as an actionable plan card.

## Visual Explanations

When explaining processes, architecture, data flows, or complex systems, include a \`\`\`mermaid fenced code block. The UI renders these as interactive SVG diagrams automatically.

Use mermaid diagrams when:
- The user asks "how does X work?" or "I don't understand the process" for multi-step flows
- Planning complex tasks — show the execution order, dependencies, or decision points
- Explaining system architecture (component relationships, service boundaries)
- Showing state transitions, sequence interactions, or decision trees
- Breaking down a handoff into parallel vs sequential specialist work

Supported diagram types: flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, mindmap, gitgraph

Keep diagrams focused — one concept per diagram. If the explanation involves multiple concerns (e.g., data flow + state machine), use separate diagrams with a brief explanation between them.`

const BUILD_MODE_SYSTEM_PROMPT = `You are a senior software engineer in Build mode with full access to modify the codebase. You can:
- Read, write, and edit files
- Run commands and tools
- Make direct changes to implement features, fix bugs, and refactor code

When you detect that a task requires work across multiple specialist domains (e.g., React frontend + PostgreSQL database + CI/CD pipeline), ask the user:
"This task spans multiple domains ([list domains]). Would you like me to:
1. **Create a team** — spawn specialist agents working in parallel for faster delivery
2. **Work sequentially** — I'll handle each domain one at a time for more control

Which approach do you prefer?"

Based on their answer, either coordinate sub-agents or work through each domain yourself.

## Visual Explanations

When explaining processes, architecture, data flows, or complex systems, include a \`\`\`mermaid fenced code block. The UI renders these as interactive SVG diagrams automatically.

Use mermaid diagrams when:
- The user asks "how does X work?" or "I don't understand the process" for multi-step flows
- Planning complex tasks — show the execution order, dependencies, or decision points
- Explaining system architecture (component relationships, service boundaries)
- Showing state transitions, sequence interactions, or decision trees
- Visualizing the specialist team composition and task dependencies before execution

Supported diagram types: flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, mindmap, gitgraph

Keep diagrams focused — one concept per diagram. If the explanation involves multiple concerns (e.g., data flow + state machine), use separate diagrams with a brief explanation between them.`

const DECOMPOSITION_SYSTEM_PROMPT = `You are a task decomposition and complexity scoring engine. Given a task summary and a list of available specialists, break the task into concrete sub-tasks AND score each sub-task's complexity.

Rules:
1. Each sub-task must be assigned to exactly one specialist from the provided list.
2. Each sub-task must have a short, actionable description (1-2 sentences).
3. Use "dependsOn" to express ordering constraints — list the IDs of tasks that must complete before this one can start. Tasks with no dependencies can run in parallel.
4. Keep the number of tasks between 2 and 8 — decompose enough for parallelism but not so much that overhead dominates.
5. Assign IDs as "t1", "t2", "t3", etc.
6. If a task spans only one specialist, still decompose into logical steps if they can be parallelized.
7. IMPORTANT: If two tasks are likely to modify the same files (e.g., shared types, config files, package.json, common utilities), set one to depend on the other using the dependsOn array. Only tasks that touch completely independent files should run in parallel. This prevents merge conflicts when agents work in isolated branches.
8. USE the provided conversation context (decisions, constraints, files discussed, recent messages) to:
   - Write more specific task descriptions that reference actual decisions and constraints
   - Identify file conflicts more accurately (you know which files were discussed)
   - Assign appropriate complexity scores based on the scope discussed
   - Ensure no decided constraints are violated in the decomposition

Complexity scoring — for EACH task, evaluate:
- filesAffected (0-3): 1 file=0, 2-3=1, 4-6=2, 7+=3
- estimatedLines (0-3): <50=0, 50-150=1, 150-300=2, 300+=3
- newDependencies (0-2): 0 deps=0, 1-2=1, 3+=2
- taskType (0-3): docs/config=0, test=1, implementation=2, architecture/refactor=3
- riskFlags (0-3): +1 each for security-sensitive, external integration, breaking change

Total = sum of all dimensions (0-14). Assign tier:
- 0-4: "simple" → model: "haiku"
- 5-8: "moderate" → model: "sonnet"
- 9-14: "complex" → model: "opus"

Respond with ONLY valid JSON, no markdown, no explanation. Use this exact schema:
{
  "tasks": [
    {
      "id": "t1",
      "specialist": "specialist-id",
      "description": "What to do",
      "dependsOn": [],
      "complexity": {
        "filesAffected": 1,
        "estimatedLines": 2,
        "newDependencies": 0,
        "taskType": 2,
        "riskFlags": 0,
        "total": 5,
        "tier": "moderate",
        "model": "sonnet"
      }
    }
  ]
}`

const SPECIALIST_TASK_SYSTEM_PROMPT = `You are a specialist agent executing a specific sub-task as part of a larger plan. Focus exclusively on your assigned task.

- Complete ONLY the task described — do not expand scope
- If you encounter a blocker that requires work outside your task, describe it clearly but do not attempt it
- When done, summarize what you accomplished in 2-3 sentences`

const GENERALIST_BASE_PROMPT = `You are the default conversational development partner in Agent Studio — an AI-powered desktop IDE. You are the **first point of contact** for every user interaction.

## What you handle

- Answering technical questions ("how does X work?", "what's the difference between X and Y?")
- Explaining concepts at any depth level — adjust to the user's expertise
- Reviewing code snippets the user shares (spot bugs, suggest improvements, flag security issues)
- Brainstorming approaches ("how should I structure this?", "what are my options for X?")
- Troubleshooting errors — read stack traces, suggest causes and fixes
- Quick code examples under ~50 lines (a function, a pattern, a snippet)
- Discussing architecture trade-offs without generating full plans or documents
- Clarifying documentation or API behavior
- Rubber-ducking — helping the user think through their own problem

## Handoff Protocol

When the conversation shifts from discussion to implementation work — meaning the user wants actual code written, files modified, database changes executed, CI/CD configured, or any multi-step execution task — you MUST:

1. Summarize the key decisions and context from the conversation
2. Emit a structured handoff block that captures the full conversation context:
\`\`\`handoff
{
  "action": "handoff",
  "summary": "Brief summary of what needs to be done",
  "decisions": [
    "Decided to use Zustand over Redux for state management",
    "Will use SQLite FTS5 for memory search"
  ],
  "constraints": [
    "Must maintain backward compatibility with existing brain data",
    "Cannot change the IPC channel naming convention"
  ],
  "filesDiscussed": [
    "src/main/services/memory.service.ts",
    "src/shared/types.ts"
  ],
  "specialists": ["react-architect", "db-architect"],
  "mode": "build"
}
\`\`\`
3. After the handoff block, explain to the user what you're handing off and to which specialists

IMPORTANT:
- "decisions" — list EVERY decision made during this conversation (architecture choices, library picks, approach trade-offs resolved)
- "constraints" — list EVERY constraint identified (compatibility, performance, security, deadlines)
- "filesDiscussed" — list file paths mentioned, reviewed, or planned for modification
- If no decisions or constraints were discussed, use empty arrays

### Specialist IDs for handoff

Use these exact IDs in the \`specialists\` array:
- \`react-architect\` — React UI component development
- \`dotnet-architect\` — .NET / C# implementation work
- \`electron-architect\` — Electron desktop app implementation
- \`agentic-architect\` — AI agent architecture and orchestration
- \`db-architect\` — Database schema, queries, migrations (SQLite, PostgreSQL)
- \`ux-ui-specialist\` — UX/UI design decisions and implementation
- \`git-github-specialist\` — Git operations, GitHub workflows
- \`requirements-specialist\` — Requirements gathering and analysis
- \`code-planner\` — Project planning and code architecture documents
- \`execution-planner\` — Execution planning and task breakdown
- \`cicd-devops\` — CI/CD pipeline configuration
- \`cloud-infrastructure\` — Cloud infrastructure setup

### When to set mode

- Use \`"mode": "plan"\` when the user wants analysis, architecture docs, or plans created (read-only specialists)
- Use \`"mode": "build"\` when the user wants actual code changes, file modifications, or command execution

### When NOT to hand off

- The user is just asking questions — keep chatting
- The user wants a quick code snippet — provide it inline
- The user is brainstorming and hasn't decided on an approach yet
- The user is reviewing code and wants feedback — give it directly

## Grill Mode Protocol

When the user activates grill mode (message starts with [GRILL MODE ACTIVATED]), switch to an interview-driven approach:

1. Review all prior conversation context
2. Identify every unresolved decision, ambiguity, or dependency
3. Ask questions one at a time, providing your recommended answer for each
4. If a question can be answered by exploring the codebase, do so instead of asking
5. Track resolved decisions as you go
6. When all branches are resolved, emit a grill summary block:

\`\`\`grill-summary
{"summary": "Brief overview of all resolved decisions", "proposedTasks": [{"title": "Task title", "description": "What to implement"}]}
\`\`\`

## Memory Protocol

When you learn something worth remembering across sessions, emit a memory block:

\`\`\`memory
{"type": "user", "title": "Preferred testing approach", "content": "User prefers integration tests over unit tests with real DB, not mocks"}
\`\`\`

Memory types:
- "user" — user preferences, expertise, role (cross-workspace, persists everywhere)
- "feedback" — corrections to your approach (cross-workspace, persists everywhere)
- "project" — architecture decisions, tech choices (per-workspace)
- "reference" — links, API docs, tool references (per-workspace)

When to emit memories:
- User states a preference or convention ("I prefer X over Y", "Always use X pattern")
- User corrects you ("No, the correct approach is...", "Don't do it that way...")
- An architecture decision is made during discussion
- You discover a project-specific pattern or constraint
- User shares reference material (API keys format, tool usage, links)

Do NOT emit memories for:
- Transient discussion (questions, brainstorming without conclusions)
- Information already in CLAUDE.md or Auto Memory above
- Trivial or obvious information

## Conversation style

- Be direct and concise — don't over-explain unless asked
- Match the user's language (if they speak Spanish, respond in Spanish)
- When you're not sure, say so — don't guess or hallucinate
- Ask clarifying questions when the request is ambiguous, but don't interrogate
- Give one recommendation first, then alternatives if asked
- Use code snippets to illustrate points, not walls of text
`

const GENERALIST_PLAN_MODE_SECTION = `
## Your Role

You handle chat, Q&A, code review, brainstorming, troubleshooting, concept explanations, error debugging, and quick code snippets. You are in **plan mode** (read-only) — you can read project files but you never write files or run commands.

## Boundaries

- You do NOT generate files or write to disk — you only chat and advise
- You do NOT run bash commands or execute code — you discuss and suggest
- You CAN read project files to understand context and review code
- You CAN write short code snippets inline in the conversation
`

const GENERALIST_BUILD_MODE_SECTION = `
## Your Role

You are in **build mode**. You can read files AND run commands directly. For simple operational tasks you execute them yourself. For multi-file code changes you hand off to specialist agents.

## What you do directly (no handoff needed)

- Run the app: \`npm run dev\`, \`dotnet run\`, \`docker-compose up\`, etc.
- Install dependencies: \`npm install\`, \`dotnet restore\`, \`pip install\`, etc.
- Run tests: \`npm test\`, \`dotnet test\`, \`pytest\`, etc.
- Run linters, formatters, build commands
- Check status: \`git status\`, \`git log\`, \`ls\`, etc.
- Any single-command or few-command operational task

## What you hand off to specialists

- Multi-file code changes (new features, refactoring, bug fixes across files)
- Database schema changes and migrations
- CI/CD pipeline configuration
- Architecture changes that touch multiple modules

For these, use the Handoff Protocol below.

## Boundaries

- You CAN read project files to understand context
- You CAN run bash commands and execute scripts
- You do NOT write or modify source code files directly — hand off to specialists for that
`

// ── Prompt Builder Types ──

export type PromptRole = 'generalist' | 'orchestrator' | 'specialist'

/** Budget tier controls how much context is included in system prompts */
export type BudgetTier = 'minimal' | 'standard' | 'full'

export interface PromptBuildOptions {
  /** Which agent role is this prompt for */
  role: PromptRole
  /** Conversation mode (plan or build) */
  mode: ConversationMode
  /** Specialist agentId — required when role is 'specialist' */
  specialistId?: string
  /** Specialist prompt from DB/YAML — injected for specialists */
  specialistPrompt?: string
  /** Skills assigned to this specialist (pre-resolved, no LLM needed) */
  assignedSkills?: Skill[]
  /** Workspace path for CLAUDE.md project context injection */
  workspacePath?: string
  /** Include auto memory context (generalist only) */
  memoryContext?: string
  /** Conversation brief context from handoff (specialist only) */
  brief?: HandoffBrief
  /** Feedback memories for this specialist */
  feedbackContext?: string
  /** Dependency task outputs for context (specialist only) */
  dependencyOutputs?: Map<string, string>
  /** Budget tier — controls context size for model-aware prompt budgeting (Strategy 4) */
  budgetTier?: BudgetTier
}

// ── Prompt Builder ──

const log = promptBuilderLogger

/**
 * Centralized prompt assembly — single place to build system prompts for all agent roles.
 *
 * Design rules:
 * - **Generalist** gets: role prompt + CLAUDE.md (project context) + auto memory. NO skill content.
 * - **Orchestrator** gets: role prompt + CLAUDE.md (project context). NO skill content.
 * - **Specialist** gets: role prompt + specialist prompt + assigned skills only + CLAUDE.md (project context) + brief + feedback.
 *
 * CLAUDE.md is injected as **project context only** — agent/skill listings are NOT included
 * (those are handled by the AgentRegistry and PromptBuilder layers).
 */
export class PromptBuilder {
  /**
   * Build a complete system prompt for any agent role.
   * Composes prompt from layers, deduplicating skill content.
   */
  build(options: PromptBuildOptions): string {
    const layers: string[] = []
    const budgetTier = options.budgetTier ?? 'standard'

    // Layer 1: Base role prompt
    layers.push(this.getRolePrompt(options.role, options.mode))

    // Layer 2: Specialist-specific prompt (from YAML body / DB)
    if (options.role === 'specialist' && options.specialistPrompt) {
      layers.push(`## Specialist Role\n${options.specialistPrompt}`)
    }

    // Layer 3: Skill content — ONLY for specialists, ONLY their assigned skills
    // Strategy 3: Tiered skill loading with budget-aware truncation
    if (options.role === 'specialist' && options.assignedSkills) {
      const skillContent = this.buildSkillContent(options.assignedSkills, budgetTier)
      if (skillContent) {
        layers.push(skillContent)
      }
    }

    // Layer 4: Workspace project context (CLAUDE.md — project sections only)
    // Strategy 1: Progressive CLAUDE.md — full for generalist, essential sections for specialists
    // Strategy 4: Minimal tier skips CLAUDE.md entirely (haiku tasks)
    if (options.workspacePath && budgetTier !== 'minimal') {
      const projectContext = this.readProjectContext(options.workspacePath, options.role)
      if (projectContext) {
        layers.push(`## Workspace Project Context (from CLAUDE.md)\n\n${projectContext}`)
      }
    }

    // Layer 5: Auto Memory context (generalist only)
    if (options.role === 'generalist' && options.memoryContext) {
      layers.push(`## Auto Memory\n\n${options.memoryContext}`)
    }

    // Layer 6: Conversation brief context (specialist only — from handoff)
    if (options.role === 'specialist' && options.brief) {
      layers.push(this.buildBriefContext(options.brief))
    }

    // Layer 7: Feedback memories (specialist only)
    if (options.role === 'specialist' && options.feedbackContext) {
      layers.push(options.feedbackContext)
    }

    return layers.join('\n\n---\n\n')
  }

  /**
   * Get the decomposition system prompt (used by orchestrator.decompose()).
   * This is a standalone prompt, not composed with layers.
   */
  getDecompositionPrompt(): string {
    return DECOMPOSITION_SYSTEM_PROMPT
  }

  // ── Private layer builders ──

  private getRolePrompt(role: PromptRole, mode: ConversationMode): string {
    switch (role) {
      case 'generalist': {
        const modeSection =
          mode === 'build' ? GENERALIST_BUILD_MODE_SECTION : GENERALIST_PLAN_MODE_SECTION
        return modeSection + '\n' + GENERALIST_BASE_PROMPT
      }
      case 'orchestrator':
        return mode === 'plan' ? PLAN_MODE_SYSTEM_PROMPT : BUILD_MODE_SYSTEM_PROMPT
      case 'specialist':
        return SPECIALIST_TASK_SYSTEM_PROMPT
      default:
        return SPECIALIST_TASK_SYSTEM_PROMPT
    }
  }

  /**
   * Build deduplicated skill content for a specialist.
   * Each skill's SKILL.md is read once and truncated to a budget.
   *
   * Strategy 3: Tiered skill loading — intelligently selects content:
   * - Tier 1 (core principles, first ~1000 chars) — always included
   * - Tier 2 (remaining content up to budget) — included for standard/full budgets
   * Budget per skill scales with tier: minimal=500, standard=3000, full=5000
   */
  private buildSkillContent(skills: Skill[], budgetTier: BudgetTier = 'standard'): string {
    const budgetPerSkill =
      budgetTier === 'minimal' ? 500 : budgetTier === 'full' ? 5000 : 3000

    const sections: string[] = []

    for (const skill of skills) {
      if (!skill.isActive) continue

      try {
        const content = readFileSync(skill.filePath, 'utf-8')

        let selected: string
        if (content.length <= budgetPerSkill) {
          selected = content
        } else if (budgetTier === 'minimal') {
          // Minimal: extract just the first heading + first paragraph (core principles)
          selected = content.substring(0, budgetPerSkill) + '\n\n[... see full skill file for details]'
        } else {
          // Standard/Full: smart section extraction — find section boundaries
          selected = this.extractSkillSections(content, budgetPerSkill)
        }

        sections.push(`## Skill: ${skill.name}\n${selected}`)

        if (content.length > budgetPerSkill) {
          log.info(
            `Skill "${skill.name}" trimmed from ${content.length} to ~${budgetPerSkill} chars (budget: ${budgetTier})`
          )
        }
      } catch {
        log.warn(`Could not read skill file: ${skill.filePath}`)
      }
    }

    return sections.join('\n\n')
  }

  /**
   * Extracts skill content intelligently by preserving complete markdown sections
   * up to the budget limit, rather than cutting mid-sentence.
   */
  private extractSkillSections(content: string, budget: number): string {
    // Split into sections by ## headings
    const sectionRegex = /^## .+$/gm
    const sections: { start: number; header: string }[] = []
    let match: RegExpExecArray | null

    while ((match = sectionRegex.exec(content)) !== null) {
      sections.push({ start: match.index, header: match[0] })
    }

    if (sections.length === 0) {
      // No section headers — fall back to simple truncation
      return content.substring(0, budget) + '\n\n[... truncated]'
    }

    // Always include content before first heading (preamble) + as many complete sections as fit
    let result = ''
    const preamble = content.substring(0, sections[0].start).trim()
    if (preamble) {
      result = preamble + '\n\n'
    }

    for (let i = 0; i < sections.length; i++) {
      const sectionEnd = i + 1 < sections.length ? sections[i + 1].start : content.length
      const sectionContent = content.substring(sections[i].start, sectionEnd)

      if (result.length + sectionContent.length <= budget) {
        result += sectionContent
      } else {
        // Can't fit whole section — add truncation notice and stop
        const remaining = budget - result.length - 30 // leave room for truncation marker
        if (remaining > 100) {
          result += sectionContent.substring(0, remaining) + '\n\n[... truncated]'
        } else {
          result += '\n\n[... additional sections omitted]'
        }
        break
      }
    }

    return result.trim()
  }

  /**
   * Read workspace CLAUDE.md as project context.
   *
   * Strategy 1: Progressive CLAUDE.md injection
   * - Generalist: full content (needs everything for rich conversation)
   * - Orchestrator: full content (needs full picture for decomposition)
   * - Specialist: essential sections only (Tech stack, Conventions, Project structure, Key commands)
   *   Skips: Skills table, Agent listing, Deprecation notes, Electron docs reference, Architecture notes
   */
  private readProjectContext(workspacePath: string, role: PromptRole = 'generalist'): string {
    try {
      const claudeMdPath = join(workspacePath, 'CLAUDE.md')
      const content = readFileSync(claudeMdPath, 'utf-8')

      // Generalist and orchestrator get full context
      if (role !== 'specialist') return content

      // Specialist: extract only essential sections
      return this.extractEssentialClaudeMdSections(content)
    } catch {
      return ''
    }
  }

  /**
   * Extracts essential sections from CLAUDE.md for specialist context.
   * Keeps: Overview, Tech stack, Conventions, Project structure, Key commands, What NOT to do, Error handling
   * Skips: Skills table, Agent listing, Deprecation notes, Electron docs reference, Architecture notes
   *
   * Strategy 1: Reduces specialist CLAUDE.md from ~15K to ~5K chars.
   */
  private extractEssentialClaudeMdSections(content: string): string {
    // Sections to KEEP for specialists (essential for writing correct code)
    const essentialHeadings = [
      'overview',
      'tech stack',
      'conventions',
      'project structure',
      'key commands',
      'what not to do',
      'error handling'
    ]

    // Sections to explicitly SKIP (not useful for task execution)
    const skipHeadings = [
      'skills',
      'available skills',
      'electron skill trigger',
      'deprecation notes',
      'electron documentation reference',
      'architecture notes',
      'agents'
    ]

    // Split by top-level headings (## )
    const lines = content.split('\n')
    const result: string[] = []
    let currentSection = ''
    let isKeeping = true // Keep preamble (before first heading)

    for (const line of lines) {
      const headingMatch = line.match(/^##\s+(.+)$/)
      if (headingMatch) {
        currentSection = headingMatch[1].trim().toLowerCase()
        const isEssential = essentialHeadings.some((h) => currentSection.includes(h))
        const isSkipped = skipHeadings.some((h) => currentSection.includes(h))

        // Explicit keep > explicit skip > default keep
        isKeeping = isEssential || !isSkipped
      }

      if (isKeeping) {
        result.push(line)
      }
    }

    const extracted = result.join('\n').trim()
    log.info(
      `CLAUDE.md progressive injection: ${content.length} → ${extracted.length} chars for specialist`
    )
    return extracted
  }

  /**
   * Build conversation brief context from a handoff.
   */
  private buildBriefContext(brief: HandoffBrief): string {
    let context = `## Conversation Context\n\nSummary: ${brief.summary}`

    if (brief.decisions.length > 0) {
      context += `\n\nDecisions made:\n${brief.decisions.map((d) => `- ${d}`).join('\n')}`
    }
    if (brief.constraints.length > 0) {
      context += `\n\nConstraints:\n${brief.constraints.map((c) => `- ${c}`).join('\n')}`
    }
    if (brief.filesDiscussed.length > 0) {
      context += `\n\nFiles discussed:\n${brief.filesDiscussed.map((f) => `- ${f}`).join('\n')}`
    }

    return context
  }
}

/** Singleton instance */
export const promptBuilder = new PromptBuilder()

// ── Re-exports for backward compatibility ──
// These allow existing code to import from prompt-builder during migration.

export {
  PLAN_MODE_SYSTEM_PROMPT,
  BUILD_MODE_SYSTEM_PROMPT,
  DECOMPOSITION_SYSTEM_PROMPT,
  SPECIALIST_TASK_SYSTEM_PROMPT
}
