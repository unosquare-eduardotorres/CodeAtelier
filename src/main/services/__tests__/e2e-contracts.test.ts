/**
 * E2E Contracts Test — validates that scenario catalog tool-name references,
 * chunk types, slash commands, and runner keys stay in sync with the real codebase.
 *
 * Runs without Electron or any LLM — pure static analysis of source files.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { test, describe, summaryAsync } from './test-harness'
import { SCENARIO_CATALOG } from '../e2e-testing/scenario-catalog'

// ── Helpers ──

/** Read a file relative to workspace root */
function readSource(relPath: string): string {
  // Walk up from __tests__ → services → main → src → project root
  const projectRoot = join(__dirname, '..', '..', '..', '..')
  return readFileSync(join(projectRoot, relPath), 'utf-8')
}

/** Extract all `server.tool(` registrations from MCP server files */
function extractMcpToolNames(): string[] {
  const projectRoot = join(__dirname, '..', '..', '..', '..')
  const mcpDir = join(projectRoot, 'src', 'main', 'mcp-servers')
  const files = readdirSync(mcpDir).filter(
    (f) => f.endsWith('.ts') && !f.includes('__tests__') && !f.includes('.test.')
  )

  const toolNames: string[] = []
  const toolCallRegex = /server\.tool\(/g

  for (const file of files) {
    const source = readFileSync(join(mcpDir, file), 'utf-8')
    const lines = source.split('\n')

    for (let i = 0; i < lines.length; i++) {
      if (toolCallRegex.test(lines[i])) {
        // Tool name is on this line or the next line, in single quotes
        const combined = lines[i] + (lines[i + 1] ?? '')
        const match = combined.match(/'([^']+)'/)
        if (match) toolNames.push(match[1])
      }
      toolCallRegex.lastIndex = 0
    }
  }

  return [...new Set(toolNames)].sort()
}

/** Extract slash command definitions from useSlashCommands.ts */
function extractSlashCommands(): string[] {
  const source = readSource('src/renderer/src/components/chat/message-input/useSlashCommands.ts')
  const commands: string[] = []
  const regex = /command:\s*'(\/[^']+)'/g
  let match
  while ((match = regex.exec(source)) !== null) {
    commands.push(match[1])
  }
  return [...new Set(commands)].sort()
}

/** Extract StreamChunk type union members from agent-base.service.ts */
function extractStreamChunkTypes(): string[] {
  const source = readSource('src/main/services/agent-base.service.ts')
  // Find the StreamChunk interface's `type:` union
  const interfaceMatch = source.match(
    /export interface StreamChunk\s*\{[\s\S]*?type:\s*([\s\S]*?)\n\s+\w/
  )
  if (!interfaceMatch) return []

  const unionBlock = interfaceMatch[1]
  const types: string[] = []
  const regex = /\|\s*'([^']+)'/g
  let match
  while ((match = regex.exec(unionBlock)) !== null) {
    types.push(match[1])
  }
  return types.sort()
}

/** Extract case labels from chunkToTranscriptEntry in stream-helper.ts */
function extractHandledChunkTypes(): string[] {
  const source = readSource('src/main/services/e2e-testing/stream-helper.ts')
  const handledTypes: string[] = []
  const regex = /case '([^']+)':/g
  let match
  while ((match = regex.exec(source)) !== null) {
    handledTypes.push(match[1])
  }
  return [...new Set(handledTypes)].sort()
}

// ── SDK-native tools (provided by the Claude/OpenCode SDK, not our MCP servers) ──
const SDK_NATIVE_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'Grep',
  'Glob',
  'Bash',
  'Task',
  'TaskCreate',
  'task_create',
  'emit_plan',
  'ask_user',
  'websearch',
  'webfetch',
  'web_search',
  'web_fetch'
])

// Tool name aliases in the catalog that don't exactly match MCP server registration names
// but work at runtime via contains-match or are deliberately loose.
// Each entry documents the real MCP tool name for auditability.
const CATALOG_TOOL_ALIASES: Record<string, string> = {
  // All stale aliases removed — catalog now uses real tool names
}

// ── Tests ──

describe('E2EContracts', () => {
  // ── 1. Tool Names Sync ──

  test('all catalog tool-name references map to real MCP tool names or SDK-native tools', () => {
    const mcpToolNames = new Set(extractMcpToolNames())

    // Collect every tool name referenced in catalog assertions
    const referencedTools = new Set<string>()
    for (const scenario of SCENARIO_CATALOG) {
      for (const assertion of scenario.assertions) {
        // Extract tool names from assertion names like:
        //   toolCalled(Read), toolNotCalled(Bash),
        //   anyToolCalled([search_identifiers, graph_map, ...]),
        //   toolCalledTimes(emit_plan, 2)
        const toolCalledMatch = assertion.name.match(/^toolCalled(?:Times)?\(([^,)]+)/)
        if (toolCalledMatch) referencedTools.add(toolCalledMatch[1])

        const toolNotCalledMatch = assertion.name.match(/^toolNotCalled\(([^)]+)\)/)
        if (toolNotCalledMatch) referencedTools.add(toolNotCalledMatch[1])

        // anyToolCalled([tool1, tool2, ...]) — strip the square brackets first
        const anyToolMatch = assertion.name.match(/^anyToolCalled\(\[(.+)\]\)$/)
        if (anyToolMatch) {
          anyToolMatch[1]
            .split(',')
            .map((t) => t.trim())
            .forEach((t) => referencedTools.add(t))
        }
      }
    }

    const unknownTools: string[] = []
    for (const tool of referencedTools) {
      // Exact match only. The previous contains-match existed to paper over
      // registry drift (catalog said 'checkpoint_list', registry said
      // 'list_checkpoints') and would silently accept a ghost tool name again.
      const inMcp = mcpToolNames.has(tool)
      const isAlias = tool in CATALOG_TOOL_ALIASES
      if (!inMcp && !SDK_NATIVE_TOOLS.has(tool) && !isAlias) {
        unknownTools.push(tool)
      }
    }

    assert.deepEqual(
      unknownTools,
      [],
      `Catalog references tool names not found in MCP servers or SDK-native list: ${unknownTools.join(', ')}`
    )
  })

  // ── 2. Chunk Types Coverage ──

  test('all StreamChunk types have an explicit handler or fall through to default bucket', () => {
    const allChunkTypes = extractStreamChunkTypes()
    const handledTypes = new Set(extractHandledChunkTypes())

    // Types intentionally handled by the `default` case in chunkToTranscriptEntry
    const defaultBucketAllowlist = new Set([
      'tool_progress',
      'subagent_start',
      'subagent_progress',
      'subagent_complete',
      'rate_limit',
      'api_retry',
      'prompt_suggestion',
      'files_persisted',
      'hook_lifecycle',
      'session_state',
      'auth_status',
      'tool_use_summary',
      'session_recovery',
      'structured_output',
      'lsp_diagnostics',
      'turn_limit'
    ])

    const uncovered: string[] = []
    for (const chunkType of allChunkTypes) {
      if (!handledTypes.has(chunkType) && !defaultBucketAllowlist.has(chunkType)) {
        uncovered.push(chunkType)
      }
    }

    assert.deepEqual(
      uncovered,
      [],
      `StreamChunk types with no explicit case or default-bucket entry: ${uncovered.join(', ')}. ` +
        `Add a case in stream-helper.ts chunkToTranscriptEntry or add to defaultBucketAllowlist.`
    )
  })

  // ── 3. Commands Sync ──

  test('catalog commands.* scenario IDs map to real slash commands', () => {
    const realCommands = new Set(extractSlashCommands())

    const commandScenarios = SCENARIO_CATALOG.filter((s) => s.category === 'commands')
    const mismatches: string[] = []

    for (const scenario of commandScenarios) {
      // Extract the command name from scenario ID: commands.recap → /recap
      const cmdName = scenario.id.replace('commands.', '')

      // Some backend-covered commands map to other scenarios (e.g. /effort → chat-core.effort-high)
      // Only check that the command exists as a real slash command OR has explicit description noting backend coverage
      const slashCmd = `/${cmdName}`
      const isRealCommand = realCommands.has(slashCmd)
      const isBackendCovered =
        scenario.description.includes('Backend coverage:') ||
        scenario.description.includes('backend coverage')
      const isAuditStyle = scenario.id === 'commands.audit' // audit prompt, not /audit command

      if (!isRealCommand && !isBackendCovered && !isAuditStyle) {
        mismatches.push(`${scenario.id} → ${slashCmd} not in useSlashCommands.ts`)
      }
    }

    assert.deepEqual(
      mismatches,
      [],
      `Catalog command scenarios reference non-existent slash commands: ${mismatches.join('; ')}`
    )
  })

  // ── 4. Runner Keys Sync ──

  test('SERVICE_RUNNERS keys include all catalog runner references', () => {
    // Import the registry keys (file-level import would pull Electron deps — read the file instead)
    const registrySource = readSource('src/main/services/e2e-testing/service-runners/index.ts')

    // Extract keys from `SERVICE_RUNNERS: Record<...> = {`
    const registryKeys = new Set<string>()
    const keyRegex = /'([^']+)':\s*\w/g
    let match
    while ((match = keyRegex.exec(registrySource)) !== null) {
      registryKeys.add(match[1])
    }

    // Collect all runner references from the catalog
    const catalogRunners = new Set<string>()
    for (const scenario of SCENARIO_CATALOG) {
      if (scenario.runner) catalogRunners.add(scenario.runner)
    }

    const missingFromRegistry: string[] = []
    for (const runner of catalogRunners) {
      if (!registryKeys.has(runner)) {
        missingFromRegistry.push(runner)
      }
    }

    // Note: We allow registry to have MORE keys than catalog (forward-compatibility)
    // but catalog must not reference keys that don't exist in registry.
    // For now we only warn on new runners that haven't been registered yet.
    // These will be registered as runner implementations are built in later waves.
    if (missingFromRegistry.length > 0) {
      // Instead of hard-failing, emit a status so we know which runners need registration
      // Hard-fail only on runners from existing waves (wave 1-4)
      const existingRunners = new Set([
        'blueprint-create',
        'blueprint-phase-management',
        'blueprint-progress-tracking',
        'blueprint-task-execution',
        'mpa-preflight',
        'mpa-goal-conditions',
        'mpa-orchestration',
        'mpa-cancellation',
        'code-intel-code-graph-index',
        'code-intel-embedding-generation',
        'code-intel-semantic-search',
        'grill-evaluate',
        'grill-multi-track',
        'grill-iteration',
        'grill-condense-requirement',
        'grill-generate-plan',
        'audit-start-run',
        'audit-findings',
        'audit-coverage',
        'council-start-session',
        'council-advisor-opinions',
        'council-synthesis',
        'council-structured-output',
        'memory-tiers'
      ])

      const brokenExisting = missingFromRegistry.filter((r) => existingRunners.has(r))
      assert.deepEqual(
        brokenExisting,
        [],
        `Existing runner keys missing from SERVICE_RUNNERS registry: ${brokenExisting.join(', ')}`
      )

      // Future runners (waves B-F) — informational only, not a hard failure
      const futureRunners = missingFromRegistry.filter((r) => !existingRunners.has(r))
      if (futureRunners.length > 0) {
        console.log(
          `  [info] Future runner keys not yet registered (expected): ${futureRunners.join(', ')}`
        )
      }
    }
  })

  // ── 5. MCP Tool Names Extracted Successfully ──

  test('MCP tool name extraction finds a reasonable count', () => {
    const toolNames = extractMcpToolNames()
    assert.ok(
      toolNames.length >= 30,
      `Expected at least 30 MCP tool names, found ${toolNames.length}: ${toolNames.join(', ')}`
    )
    // Spot-check known tools
    assert.ok(toolNames.includes('memory_record'), 'Should include memory_record')
    assert.ok(toolNames.includes('git_log'), 'Should include git_log')
    assert.ok(toolNames.includes('search_identifiers'), 'Should include search_identifiers')
    assert.ok(toolNames.includes('emit_plan'), 'Should include emit_plan')
  })

  // ── 6. Slash Commands Extracted Successfully ──

  test('slash command extraction finds the expected set', () => {
    const commands = extractSlashCommands()
    assert.ok(
      commands.length >= 10,
      `Expected at least 10 slash commands, found ${commands.length}: ${commands.join(', ')}`
    )
    assert.ok(commands.includes('/recap'), 'Should include /recap')
    assert.ok(commands.includes('/grillme'), 'Should include /grillme')
    assert.ok(commands.includes('/council'), 'Should include /council')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
