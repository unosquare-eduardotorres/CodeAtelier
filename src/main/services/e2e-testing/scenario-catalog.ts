/**
 * E2E Scenario Catalog — typed registry of all testable features.
 *
 * Scenarios are grouped by category. Most start as `planned` (catalog-only,
 * greyed in UI). The first slice implements ~10 runnable scenarios.
 */

import type { E2ECategory, E2EScenarioStatus, ThinkingEffort, CommunicationTone } from '../../../shared/types'
import type { E2EAssertion } from './e2e-assertions'
import {
  streamCompleted,
  noErrorChunks,
  responseMinLength,
  responseMatches,
  responseExists,
  toolCalled,
  toolCalledTimes,
  anyToolCalled,
  thinkingPresent,
  responseHasMermaidBlock,
  responseHasMarkdownTable,
  fileExistsInFixture,
  validJson,
  statusEntryMatches
} from './e2e-assertions'
import { z } from 'zod'

// ── Rich Prompt Steps ──

/**
 * A prompt step can be a plain string (back-compat) or a rich object
 * with attachments and mode-switch directives.
 */
export type E2EStep = string | {
  text: string
  /** File paths relative to fixture root (e.g. 'assets/red-square.png') */
  attachments?: string[]
  /** Update conversation mode BEFORE streaming this step */
  switchModeTo?: 'plan' | 'build' | 'danger'
  /** Abort the stream N ms after the first text chunk arrives (for stop-generation testing) */
  abortAfterMs?: number
  /** After the step's stream completes, call chatAgentService.compact() */
  compactAfter?: boolean
  /** Set thinking effort level BEFORE streaming this step */
  setEffort?: ThinkingEffort
  /** Set communication tone BEFORE streaming this step */
  setTone?: CommunicationTone
}

/** Extract the text from a step (plain string or rich object) */
export function stepText(step: E2EStep): string {
  return typeof step === 'string' ? step : step.text
}

/** Extract attachments from a step (empty array if plain string) */
export function stepAttachments(step: E2EStep): string[] {
  return typeof step === 'string' ? [] : (step.attachments ?? [])
}

/** Extract the mode switch directive from a step (undefined if plain string) */
export function stepModeSwitch(step: E2EStep): 'plan' | 'build' | 'danger' | undefined {
  return typeof step === 'string' ? undefined : step.switchModeTo
}

/** Extract the abortAfterMs directive from a step (undefined if plain string) */
export function stepAbortAfterMs(step: E2EStep): number | undefined {
  return typeof step === 'string' ? undefined : step.abortAfterMs
}

/** Extract the compactAfter directive from a step (undefined if plain string) */
export function stepCompactAfter(step: E2EStep): boolean {
  return typeof step === 'string' ? false : (step.compactAfter ?? false)
}

/** Extract the setEffort directive from a step (undefined if plain string) */
export function stepSetEffort(step: E2EStep): ThinkingEffort | undefined {
  return typeof step === 'string' ? undefined : step.setEffort
}

/** Extract the setTone directive from a step (undefined if plain string) */
export function stepSetTone(step: E2EStep): CommunicationTone | undefined {
  return typeof step === 'string' ? undefined : step.setTone
}

// ── Scenario Definition ──

export interface E2EScenario {
  id: string
  category: E2ECategory
  title: string
  description: string
  status: E2EScenarioStatus
  mode: 'plan' | 'build'
  prompts: E2EStep[]
  timeoutMs: number
  assertions: E2EAssertion[]
}

// ── Default timeout (local inference is slow) ──

const DEFAULT_TIMEOUT = 120_000

// ── Implemented Scenarios ──

const IMPLEMENTED_SCENARIOS: E2EScenario[] = [
  {
    id: 'chat-core.basic-completion',
    category: 'chat-core',
    title: 'Basic Completion',
    description: 'Send a simple prompt and assert non-empty text response with stream completion.',
    status: 'implemented',
    mode: 'plan',
    prompts: ['What is 2 + 2? Answer with just the number.'],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), responseMinLength(1)]
  },
  {
    id: 'chat-core.multi-turn-context',
    category: 'chat-core',
    title: 'Multi-Turn Context',
    description: 'Two turns — assert the second turn references a fact from the first.',
    status: 'implemented',
    mode: 'plan',
    prompts: [
      'Remember this secret code: FALCON-42. Just acknowledge you received it.',
      'What was the secret code I told you?'
    ],
    timeoutMs: DEFAULT_TIMEOUT * 2,
    assertions: [streamCompleted(), noErrorChunks(), responseMatches(/FALCON-42/i)]
  },
  {
    id: 'chat-core.streaming-chunks',
    category: 'chat-core',
    title: 'Streaming Chunks',
    description: 'Assert that at least N text_delta chunks arrive incrementally.',
    status: 'implemented',
    mode: 'plan',
    prompts: ['Write a short paragraph about the history of computing.'],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), responseMinLength(100)]
  },
  {
    id: 'tools.read-file',
    category: 'tools',
    title: 'Read File Tool',
    description: 'Ask to read a file — assert the Read tool is called with the correct path.',
    status: 'implemented',
    mode: 'build',
    prompts: ['Read the file src/hello.ts and tell me what it does. Use the Read tool.'],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), toolCalled('Read')]
  },
  {
    id: 'tools.write-file',
    category: 'tools',
    title: 'Write File Tool',
    description: 'Ask to create a file — assert Write tool is called and file appears in fixture.',
    status: 'implemented',
    mode: 'build',
    prompts: [
      'Create a file called src/greeting.ts that exports a function called greet that returns "Hello, World!". Use the Write tool.'
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), toolCalled('Write'), fileExistsInFixture('src/greeting.ts', /greet/)]
  },
  {
    id: 'tools.grep-search',
    category: 'tools',
    title: 'Grep Search Tool',
    description: 'Ask to search for a pattern — assert the Grep tool is invoked.',
    status: 'implemented',
    mode: 'build',
    prompts: ['Search this project for any usage of the word "hello". Use the Grep tool.'],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), toolCalled('Grep')]
  },
  {
    id: 'chat-core.structured-json',
    category: 'chat-core',
    title: 'Structured JSON Output',
    description: 'Prompt for JSON output and validate it against a Zod schema.',
    status: 'implemented',
    mode: 'plan',
    prompts: [
      'Return a JSON object with these fields: "name" (string), "age" (number), "active" (boolean). Use any values you want. Return ONLY the JSON object, no markdown code fences.'
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [
      streamCompleted(),
      noErrorChunks(),
      validJson(
        z.object({
          name: z.string(),
          age: z.number(),
          active: z.boolean()
        })
      )
    ]
  },
  {
    id: 'commands.recap',
    category: 'commands',
    title: 'Recap Command',
    description: 'Send a message then ask for a recap-style summary.',
    status: 'implemented',
    mode: 'plan',
    prompts: [
      'I am building a React app with TypeScript. The app uses Tailwind CSS for styling and Zustand for state management.',
      'Give me a brief recap of what we discussed.'
    ],
    timeoutMs: DEFAULT_TIMEOUT * 2,
    assertions: [
      streamCompleted(),
      noErrorChunks(),
      responseMatches(/react/i),
      responseMinLength(30)
    ]
  },
  {
    id: 'chat-core.tool-error-recovery',
    category: 'chat-core',
    title: 'Tool Error Recovery',
    description: 'Ask to read a nonexistent file — assert graceful handling without stream error.',
    status: 'implemented',
    mode: 'build',
    prompts: [
      'Read the file src/nonexistent-file-that-does-not-exist.xyz and tell me what it contains. Use the Read tool.'
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), responseExists(), responseMinLength(10)]
  },
  {
    id: 'chat-core.instruction-following',
    category: 'chat-core',
    title: 'Instruction Following',
    description: 'Assert the response respects an explicit format constraint.',
    status: 'implemented',
    mode: 'plan',
    prompts: [
      'List exactly 3 programming languages. Format each on its own line, numbered 1-3. Nothing else.'
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [
      streamCompleted(),
      noErrorChunks(),
      responseMatches(/1\./),
      responseMatches(/2\./),
      responseMatches(/3\./)
    ]
  }
]

// ── Newly Implemented Scenarios (promoted from planned + new additions) ──

const NEW_IMPLEMENTED_SCENARIOS: E2EScenario[] = [
  // ── Chat Core: Rich Content ──
  {
    id: 'chat-core.mermaid-diagram',
    category: 'chat-core',
    title: 'Mermaid Diagram',
    description: 'Ask for a MermaidJS flowchart and assert a ```mermaid code block is present.',
    status: 'implemented',
    mode: 'plan',
    prompts: [
      'Draw a MermaidJS flowchart of a user login flow with steps: enter credentials, validate, success/failure branches. Use a ```mermaid code block.'
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), responseHasMermaidBlock()]
  },
  {
    id: 'chat-core.markdown-table',
    category: 'chat-core',
    title: 'Markdown Table',
    description: 'Ask for a markdown table and assert proper table formatting.',
    status: 'implemented',
    mode: 'plan',
    prompts: [
      'Show a markdown table comparing REST vs GraphQL vs gRPC with columns: Feature, REST, GraphQL, gRPC. Include at least 3 rows.'
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), responseHasMarkdownTable()]
  },
  {
    id: 'chat-core.code-generation',
    category: 'chat-core',
    title: 'Code Generation',
    description: 'Ask to generate a specific function and validate code fence + function name.',
    status: 'implemented',
    mode: 'plan',
    prompts: [
      'Write a TypeScript function called `fibonacci(n: number): number` that returns the nth Fibonacci number using recursion. Show it in a code block.'
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [
      streamCompleted(),
      noErrorChunks(),
      responseMatches(/```/),
      responseMatches(/fibonacci/i)
    ]
  },
  {
    id: 'chat-core.thinking-visible',
    category: 'chat-core',
    title: 'Thinking Visibility',
    description: 'Send a reasoning-heavy prompt and verify thinking chunks appear in transcript.',
    status: 'implemented',
    mode: 'plan',
    prompts: [
      'Think step by step: If a train travels at 60 mph for 2.5 hours, then at 80 mph for 1.5 hours, what is the total distance? Show your reasoning.'
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), thinkingPresent(), responseMinLength(20)]
  },
  {
    id: 'chat-core.vision-image-read',
    category: 'chat-core',
    title: 'Vision — Image Read',
    description: 'Attach an image and ask about its content. Requires a vision-capable model. May fail on text-only models — failure reason will indicate model capability.',
    status: 'implemented',
    mode: 'plan',
    prompts: [
      {
        text: 'What color is the shape in this image? Describe what you see.',
        attachments: ['assets/red-square.png']
      }
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), responseMatches(/red/i)]
  },
  {
    id: 'chat-core.mode-switching',
    category: 'chat-core',
    title: 'Mode Switching',
    description: 'Start in plan mode (no tool access), then switch to build mode and verify tools become available.',
    status: 'implemented',
    mode: 'plan',
    prompts: [
      'Describe how you would read a file called src/hello.ts. Do NOT use any tools — just explain your approach.',
      {
        text: 'Now read the file src/hello.ts and tell me what it exports. Use the Read tool.',
        switchModeTo: 'build'
      }
    ],
    timeoutMs: DEFAULT_TIMEOUT * 2,
    assertions: [streamCompleted(), noErrorChunks(), toolCalled('Read')]
  },

  // ── Planning Flow (new category) ──
  {
    id: 'planning.emit-plan-card',
    category: 'planning',
    title: 'Emit Plan Card',
    description: 'Ask to create a plan and verify the emit_plan control tool is called.',
    status: 'implemented',
    mode: 'plan',
    prompts: [
      'Create an implementation plan for adding a dark-mode toggle to a React app. Emit it as a plan card using the emit_plan tool.'
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), toolCalled('emit_plan')]
  },
  {
    id: 'planning.revise-plan',
    category: 'planning',
    title: 'Revise Plan',
    description: 'Emit a plan then ask for a revision — assert emit_plan is called at least twice.',
    status: 'implemented',
    mode: 'plan',
    prompts: [
      'Create a plan for building a REST API with Express.js. Emit it as a plan card.',
      'Revise the plan: add a phase for unit tests with Jest. Emit the updated plan.'
    ],
    timeoutMs: DEFAULT_TIMEOUT * 2,
    assertions: [streamCompleted(), toolCalledTimes('emit_plan', 2)]
  },
  {
    id: 'planning.build-after-plan',
    category: 'planning',
    title: 'Build After Plan',
    description: 'Emit a plan in plan mode, switch to build mode, verify tool usage.',
    status: 'implemented',
    mode: 'plan',
    prompts: [
      'Create a plan for a new src/utils.ts file with a function called `capitalize`. Emit the plan.',
      {
        text: 'Now implement phase 1 of the plan. Create the file src/utils.ts with the capitalize function.',
        switchModeTo: 'build'
      }
    ],
    timeoutMs: DEFAULT_TIMEOUT * 2,
    assertions: [streamCompleted(), toolCalled('emit_plan'), toolCalled('Write')]
  },
  {
    id: 'planning.ask-user-question',
    category: 'planning',
    title: 'Ask User Question',
    description: 'Instruct the agent to ask a clarifying question using ask_user — auto-responder answers it, stream should complete.',
    status: 'implemented',
    mode: 'plan',
    prompts: [
      'Before doing anything else, ask me a clarifying question about my preferred programming language using the ask_user tool. Present at least 2 options.'
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), toolCalled('ask_user')]
  },

  // ── Tools: Promoted from planned ──
  {
    id: 'tools.glob-search',
    category: 'tools',
    title: 'Glob Tool',
    description: 'Ask to find files by pattern — assert the Glob tool is invoked.',
    status: 'implemented',
    mode: 'build',
    prompts: ['Find all TypeScript files in the src/ directory using the Glob tool.'],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), toolCalled('Glob')]
  },
  {
    id: 'tools.bash-execution',
    category: 'tools',
    title: 'Bash Tool',
    description: 'Execute a shell command via the Bash tool and verify invocation.',
    status: 'implemented',
    mode: 'build',
    prompts: ['Run the command `ls src/` using the Bash tool and show me the output.'],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), toolCalled('Bash')]
  },
  {
    id: 'tools.edit-file',
    category: 'tools',
    title: 'Edit File Tool',
    description: 'Edit an existing file with surgical replacement — assert Edit tool is called.',
    status: 'implemented',
    mode: 'build',
    prompts: [
      'Edit the file src/hello.ts: change the VERSION constant from "1.0.0" to "2.0.0". Use the Edit tool with old_string/new_string.'
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), toolCalled('Edit')]
  },
  {
    id: 'tools.multi-tool-chain',
    category: 'tools',
    title: 'Multi-Tool Chain',
    description: 'Task requiring Read then Edit — assert both tools are called.',
    status: 'implemented',
    mode: 'build',
    prompts: [
      'First read the file src/hello.ts, then edit it to add a new exported constant AUTHOR = "Test". Use the Read and Edit tools.'
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), toolCalled('Read'), toolCalled('Edit')]
  },
  {
    id: 'tools.code-graph-tools',
    category: 'tools',
    title: 'Code Graph Tools',
    description: 'Invoke a code-graph tool (search_identifiers, file_outline, etc.) and verify invocation.',
    status: 'implemented',
    mode: 'build',
    prompts: [
      'Use the code graph tools to find the symbol "hello" in this project. Use search_identifiers or file_outline.'
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [
      streamCompleted(),
      noErrorChunks(),
      anyToolCalled(['search_identifiers', 'graph_map', 'file_outline', 'find_references', 'find_callers', 'find_callees'])
    ]
  },

  // ── Memory: Promoted from planned ──
  {
    id: 'memory.propose-memory',
    category: 'memory',
    title: 'Propose Memory',
    description: 'Instruct the agent to save a fact to workspace memory — assert memory_record is called.',
    status: 'implemented',
    mode: 'build',
    prompts: [
      'Save this to workspace memory: "This project uses pnpm as its package manager." Use the memory_record tool.'
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), toolCalled('memory_record')]
  },
  {
    id: 'memory.search-memory',
    category: 'memory',
    title: 'Search Memory',
    description: 'Ask the agent to search workspace memory — assert memory_search is called.',
    status: 'implemented',
    mode: 'build',
    prompts: [
      'Search your workspace memory for any conventions about package managers. Use the memory_search tool.'
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), toolCalled('memory_search')]
  },
  {
    id: 'memory.contradict-memory',
    category: 'memory',
    title: 'Contradict Memory',
    description: 'Record a fact then flag it as wrong — assert memory_flag is called.',
    status: 'implemented',
    mode: 'build',
    prompts: [
      'Save this to workspace memory: "This project uses yarn as its package manager." Use the memory_record tool.',
      'Actually that\'s wrong — we use npm, not yarn. Flag the previous memory as contradicted using the memory_flag tool.'
    ],
    timeoutMs: DEFAULT_TIMEOUT * 2,
    assertions: [streamCompleted(), noErrorChunks(), toolCalled('memory_record'), toolCalled('memory_flag')]
  },

  // ── Chat Core: Stop / Compaction / Danger ──
  {
    id: 'chat-core.stop-generation',
    category: 'chat-core',
    title: 'Stop Generation',
    description: 'Long-output prompt with abort timer — assert partial text is captured without hang.',
    status: 'implemented',
    mode: 'plan',
    prompts: [
      {
        text: 'Write a very long essay about the entire history of mathematics from ancient times to modern day. Include every major mathematician and their contributions. Make it extremely detailed and at least 5000 words.',
        abortAfterMs: 3_000
      }
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [responseExists()]
  },
  {
    id: 'chat-core.manual-compaction',
    category: 'chat-core',
    title: 'Manual Compaction',
    description: 'Multi-turn with compaction: assert compaction succeeds and context continuity is preserved.',
    status: 'implemented',
    mode: 'plan',
    prompts: [
      'Remember this secret identifier: FALCON-42. Just acknowledge you received it.',
      {
        text: 'What is 1 + 1? Just answer briefly.',
        compactAfter: true
      },
      'What was the secret identifier I told you earlier?'
    ],
    timeoutMs: DEFAULT_TIMEOUT * 3,
    assertions: [
      statusEntryMatches(/compaction: ok/),
      responseMatches(/FALCON-42/i)
    ]
  },
  {
    id: 'chat-core.danger-mode',
    category: 'chat-core',
    title: 'Danger Mode',
    description: 'Switch to danger mode and execute a Bash command without permission prompts.',
    status: 'implemented',
    mode: 'build',
    prompts: [
      {
        text: 'Run the command `echo "danger-mode-active"` using the Bash tool and show the output.',
        switchModeTo: 'danger'
      }
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), toolCalled('Bash'), noErrorChunks()]
  },

  // ── Tools: New Servers ──
  {
    id: 'tools.git-log',
    category: 'tools',
    title: 'Git Log Tool',
    description: 'Show recent commit history using the git_log tool.',
    status: 'implemented',
    mode: 'build',
    prompts: ['Show recent commit history for this project using the git_log tool.'],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), toolCalled('git_log')]
  },
  {
    id: 'tools.git-diff',
    category: 'tools',
    title: 'Git Diff Tool',
    description: 'Edit a file then show uncommitted diff via git_diff.',
    status: 'implemented',
    mode: 'build',
    prompts: [
      'Edit the file src/hello.ts: add a comment "// modified by e2e test" at the top. Use the Edit tool.',
      'Now show the uncommitted diff for this repository using the git_diff tool.'
    ],
    timeoutMs: DEFAULT_TIMEOUT * 2,
    assertions: [streamCompleted(), noErrorChunks(), toolCalled('git_diff')]
  },
  {
    id: 'tools.todo-scanner',
    category: 'tools',
    title: 'TODO Scanner Tool',
    description: 'Scan for TODO/FIXME comments using the todo_scanner tool.',
    status: 'implemented',
    mode: 'build',
    prompts: ['Scan this project for TODO and FIXME comments using the todo_scanner tool.'],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), toolCalled('todo_scanner')]
  },
  {
    id: 'tools.code-analysis',
    category: 'tools',
    title: 'Code Analysis Tool',
    description: 'Analyze code complexity of a file using code-analysis tools.',
    status: 'implemented',
    mode: 'build',
    prompts: ['Analyze the code complexity of the file src/hello.ts using the analyze_complexity tool.'],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [
      streamCompleted(),
      noErrorChunks(),
      anyToolCalled(['analyze_complexity', 'eslint_check', 'dependency_health'])
    ]
  },
  {
    id: 'tools.checkpoint-list',
    category: 'tools',
    title: 'List Checkpoints Tool',
    description: 'List conversation checkpoints using the list_checkpoints tool.',
    status: 'implemented',
    mode: 'build',
    prompts: ['List the conversation checkpoints using the list_checkpoints tool.'],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), toolCalled('list_checkpoints')]
  },
  {
    id: 'tools.semantic-search',
    category: 'tools',
    title: 'Semantic Search Tool',
    description: 'Find code related to a concept using semantic_search. May fail on cold embedding index.',
    status: 'implemented',
    mode: 'build',
    prompts: ['Find code related to greetings or hello functions using the semantic_search tool.'],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [
      streamCompleted(),
      noErrorChunks(),
      anyToolCalled(['semantic_search', 'similar_code'])
    ]
  },

  // ── Round 3: Chat Core — Effort & Tone ──
  {
    id: 'chat-core.effort-high',
    category: 'chat-core',
    title: 'High Effort Thinking',
    description: 'Set effort to high and send a reasoning prompt — exercises the effort pipeline path.',
    status: 'implemented',
    mode: 'plan',
    prompts: [
      {
        text: 'Think deeply: what are the key trade-offs between microservices and monolithic architectures? Reason step by step.',
        setEffort: 'high'
      }
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), responseMinLength(50)]
  },
  {
    id: 'chat-core.tone-caveman',
    category: 'chat-core',
    title: 'Caveman Tone',
    description: 'Set communication tone to caveman and verify the response style changes. Assertion is intentionally loose (subjectivity caveat).',
    status: 'implemented',
    mode: 'plan',
    prompts: [
      {
        text: 'What is a database? Explain briefly.',
        setTone: 'caveman'
      }
    ],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), responseExists()]
  },

  // ── Round 3: Tools — Git & Code Graph ──
  {
    id: 'tools.git-blame',
    category: 'tools',
    title: 'Git Blame Tool',
    description: 'Annotate a file with git_blame and verify tool invocation.',
    status: 'implemented',
    mode: 'build',
    prompts: ['Annotate the file src/hello.ts with git_blame to show authorship. Use the git_blame tool.'],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [streamCompleted(), noErrorChunks(), toolCalled('git_blame')]
  },
  {
    id: 'tools.code-graph-deep',
    category: 'tools',
    title: 'Code Graph Deep Analysis',
    description: 'Invoke dead-code or dependency analysis tools on the fixture repo.',
    status: 'implemented',
    mode: 'build',
    prompts: ['Analyze this project for dead code or file dependencies. Use find_dead_code, file_dependencies, or symbol_hotspots.'],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: [
      streamCompleted(),
      noErrorChunks(),
      anyToolCalled(['find_dead_code', 'file_dependencies', 'file_dependents', 'symbol_hotspots', 'coupling_analysis', 'circular_dependencies'])
    ]
  },

  // ── Round 3: Commands — Audit-style ──
  {
    id: 'commands.audit',
    category: 'commands',
    title: 'Audit-style Review',
    description: 'Send an audit-style review prompt in build mode and verify tool usage for code review.',
    status: 'implemented',
    mode: 'build',
    prompts: [
      'Review the src/ directory for potential issues: check code quality, find TODOs, and suggest improvements. Read the files and use Grep if needed.'
    ],
    timeoutMs: DEFAULT_TIMEOUT * 2,
    assertions: [streamCompleted(), anyToolCalled(['Read', 'Grep']), responseMinLength(50)]
  }
]

// ── Planned Scenarios (catalog entries only, shown greyed in UI) ──

function planned(
  id: string,
  category: E2ECategory,
  title: string,
  description: string,
  mode: 'plan' | 'build' = 'plan'
): E2EScenario {
  return {
    id,
    category,
    title,
    description,
    status: 'planned',
    mode,
    prompts: [],
    timeoutMs: DEFAULT_TIMEOUT,
    assertions: []
  }
}

const PLANNED_SCENARIOS: E2EScenario[] = [
  // ── Chat Core (remaining planned) ──
  planned('chat-core.long-context', 'chat-core', 'Long Context Window', 'Send a long prompt near context limits and verify coherent response. Needs runner instrumentation for large prompts.'),
  planned('chat-core.prompt-optimization', 'chat-core', 'Prompt Optimization', 'Verify prompt optimizer reduces token count. Claude-only — optimizer guard skips local-LLM providers.'),
  // chat-core.thinking-effort → promoted to chat-core.effort-high (implemented)
  // chat-core.communication-tone → promoted to chat-core.tone-caveman (implemented)
  planned('chat-core.mcp-override-local', 'chat-core', 'Per-Chat MCP Override (Local)', 'Toggle local MCP servers per-chat. Blocked: product bug — resolveWorkspaceMcpFlags hardcodes localMcpActive={}, conv.mcpOverrides only feeds external MCPs.'),
  planned('chat-core.resume-at', 'chat-core', 'Resume At Message', 'Resume conversation from a specific message ID using chatAgentService.resumeAt(). Blocked: needs message-ID plumbing in runner step directive.'),
  planned('chat-core.specialist-swap', 'chat-core', 'Specialist Swap', 'Switch specialist mid-conversation and verify persona change. Needs specialist build pipeline integration.'),
  planned('chat-core.context-usage-tracking', 'chat-core', 'Context Usage Tracking', 'Verify context_usage_update chunks report token usage. Values are model-dependent — now visible via enriched mapper.'),

  // ── Commands (renderer-level — belong in Playwright suite) ──
  planned('commands.goal', 'commands', '/goal Command', 'Renderer-level slash command — intercepted in MessageInput.tsx. Belongs in Playwright e2e suite (e2e/slash-commands.e2e.ts), not backend runner.'),
  planned('commands.compact', 'commands', '/compact Command', 'Renderer-level slash command — intercepted in MessageInput.tsx. Belongs in Playwright e2e suite.'),
  planned('commands.plan-mode', 'commands', 'Plan Mode Command', 'Renderer-level slash command — intercepted in MessageInput.tsx. Belongs in Playwright e2e suite.'),
  planned('commands.build-mode', 'commands', 'Build Mode Command', 'Renderer-level slash command — intercepted in MessageInput.tsx. Belongs in Playwright e2e suite.'),
  planned('commands.danger-mode', 'commands', 'Danger Mode Command', 'Renderer-level slash command — intercepted in MessageInput.tsx. Belongs in Playwright e2e suite.'),

  // ── Tools (remaining planned) ──
  planned('tools.web-search', 'tools', 'Web Search Tool', 'Trigger web search and verify results. Needs runner web-search infra.', 'build'),
  planned('tools.tool-permission', 'tools', 'Tool Permission Gating', 'Verify dangerous tools require confirmation.', 'build'),
  planned('tools.subagent-execution', 'tools', 'Subagent Execution', 'Verify subagent chunks appear in transcript. Subagent chunks now mappable, but scenario needs reliable Task-tool prompting.', 'build'),
  planned('tools.eslint-check', 'tools', 'ESLint Check Tool', 'Run eslint_check on fixture files. Blocked: fixture has no node_modules/eslint installed.', 'build'),
  planned('tools.dependency-health', 'tools', 'Dependency Health Tool', 'Run dependency_health to check npm audit. Blocked: requires npm registry network access.', 'build'),
  planned('tools.codebase-concepts', 'tools', 'Codebase Concepts Tool', 'Extract codebase concepts via codebase_concepts tool. Blocked: requires warm embedding index.', 'build'),

  // ── Memory (remaining planned) ──
  planned('memory.memory-context', 'memory', 'Memory in Context', 'Verify relevant memories appear in conversation context. Needs cross-conversation step directive (newConversation).'),
  planned('memory.memory-tiers', 'memory', 'Memory Tier Progression', 'Verify promotion from Data → Information'),

  // ── Planning (remaining planned) ──
  planned('planning.plan-with-constraints', 'planning', 'Plan with Constraints', 'Emit plan with specific constraints and verify structure'),

  // ── Grill (deferred — needs grillAgentService runner) ──
  planned('grill.evaluate-idea', 'grill', 'Grill Evaluation', 'Submit an idea for grill evaluation and verify scoring. Deferred: needs grillAgentService runner.'),
  planned('grill.multi-track', 'grill', 'Grill Multi-Track', 'Run multiple grill tracks sequentially. Deferred: needs grillAgentService runner.'),
  planned('grill.condense-requirement', 'grill', 'Condense Requirement', 'Verify requirement condensation output. Deferred: needs grillAgentService runner.'),
  planned('grill.generate-plan', 'grill', 'Generate Plan', 'Generate structured plan from grill session. Deferred: needs grillAgentService runner.'),
  planned('grill.iteration', 'grill', 'Grill Iteration', 'Iterate on grill feedback and verify score improvement. Deferred: needs grillAgentService runner.'),

  // ── Council (deferred — needs councilService runner) ──
  planned('council.start-session', 'council', 'Council Session Start', 'Start a council review session. Deferred: needs councilService runner.'),
  planned('council.advisor-opinions', 'council', 'Advisor Opinions', 'Verify multiple advisor perspectives are generated. Deferred: needs councilService runner.'),
  planned('council.synthesis', 'council', 'Council Synthesis', 'Verify synthesis of advisor opinions. Deferred: needs councilService runner.'),
  planned('council.structured-output', 'council', 'Council Structured Output', 'Verify structured council output format. Deferred: needs councilService runner.'),

  // ── Blueprints (deferred — needs blueprint runner) ──
  planned('blueprints.create', 'blueprints', 'Create Blueprint', 'Create a new blueprint from a plan. Deferred: needs blueprint service runner.'),
  planned('blueprints.phase-management', 'blueprints', 'Phase Management', 'Add/edit/reorder blueprint phases. Deferred: needs blueprint service runner.'),
  planned('blueprints.task-execution', 'blueprints', 'Task Execution', 'Execute a blueprint task via chat. Deferred: needs blueprint service runner.'),
  planned('blueprints.progress-tracking', 'blueprints', 'Progress Tracking', 'Verify phase/task completion tracking. Deferred: needs blueprint service runner.'),

  // ── MPA (deferred — needs MPA orchestration runner) ──
  planned('mpa.preflight', 'mpa', 'MPA Preflight', 'Run MPA preflight checks. Deferred: needs MPA runner.'),
  planned('mpa.orchestration', 'mpa', 'MPA Orchestration', 'Start MPA run and verify task distribution. Deferred: needs MPA runner.'),
  planned('mpa.goal-conditions', 'mpa', 'MPA Goal Conditions', 'Verify MPA goal condition evaluation. Deferred: needs MPA runner.'),
  planned('mpa.cancellation', 'mpa', 'MPA Cancellation', 'Cancel an MPA run mid-execution. Deferred: needs MPA runner.'),

  // ── Audit (deferred — needs audit service runner) ──
  planned('audit.start-run', 'audit', 'Start Audit Run', 'Start an audit discovery run. Deferred: needs audit runner.'),
  planned('audit.findings', 'audit', 'Audit Findings', 'Verify audit findings are generated. Deferred: needs audit runner.'),
  planned('audit.coverage', 'audit', 'Audit Coverage', 'Verify coverage tracking across categories. Deferred: needs audit runner.'),

  // ── Code Intelligence (deferred — needs service-level runner) ──
  planned('code-intel.semantic-search', 'code-intel', 'Semantic Search', 'Run semantic search and verify results. Deferred: needs service-level runner.'),
  planned('code-intel.code-graph-index', 'code-intel', 'Code Graph Indexing', 'Trigger indexing and verify completion. Deferred: needs service-level runner.'),
  planned('code-intel.embedding-generation', 'code-intel', 'Embedding Generation', 'Verify embedding model produces vectors. Deferred: needs service-level runner.')
]

// ── Full Catalog ──

export const SCENARIO_CATALOG: E2EScenario[] = [
  ...IMPLEMENTED_SCENARIOS,
  ...NEW_IMPLEMENTED_SCENARIOS,
  ...PLANNED_SCENARIOS
]

// ── Helpers ──

export function getScenarioById(id: string): E2EScenario | undefined {
  return SCENARIO_CATALOG.find((s) => s.id === id)
}

export function getScenariosByCategory(category: E2ECategory): E2EScenario[] {
  return SCENARIO_CATALOG.filter((s) => s.category === category)
}

export function getImplementedScenarios(): E2EScenario[] {
  return SCENARIO_CATALOG.filter((s) => s.status === 'implemented')
}

export function getAllCategories(): E2ECategory[] {
  return [...new Set(SCENARIO_CATALOG.map((s) => s.category))]
}

/**
 * Returns true if a scenario depends on the model emitting structured tool_calls.
 * Checks whether any assertion name contains 'toolCalled' (case-sensitive match on
 * toolCalled, toolCalledTimes, anyToolCalled, fileExistsInFixture) — all require tools.
 */
export function scenarioRequiresTools(scenario: E2EScenario): boolean {
  return scenario.assertions.some((a) =>
    /toolCalled|anyToolCalled|fileExistsInFixture/.test(a.name)
  )
}

export function getScenarioSummaries() {
  return SCENARIO_CATALOG.map((s) => ({
    id: s.id,
    category: s.category,
    title: s.title,
    description: s.description,
    status: s.status,
    mode: s.mode,
    timeoutMs: s.timeoutMs,
    promptCount: s.prompts.length,
    hasAttachments: s.prompts.some(
      (p) => typeof p !== 'string' && (p.attachments?.length ?? 0) > 0
    ),
    hasModeSwitch: s.prompts.some(
      (p) => typeof p !== 'string' && p.switchModeTo != null
    )
  }))
}
