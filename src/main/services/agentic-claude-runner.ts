/**
 * agentic-claude-runner.ts — Shared helper to spawn Claude CLI as an agentic sub-process.
 *
 * Used by:
 *   - Deep Scan (memory-bootstrap.service.ts) — agent-driven codebase exploration
 *   - CLAUDE.md regeneration (memory-extraction.service.ts) — agentic file generation
 *
 * Responsibilities:
 *   1. Write a minimal MCP config (memory + code-graph servers only) to a temp file
 *   2. Spawn `claude` CLI with --mcp-config, --permission-mode bypassPermissions,
 *      and a strict --allowedTools whitelist (read + MCP only; no Write/Edit)
 *   3. Stream stdout lines to an optional callback; honor AbortSignal
 *   4. Clean up the temp config in a `finally` block
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import log from 'electron-log'
import { buildEnvWithPath } from './env-utils'

const runnerLog = log.scope('agentic-runner')

// ── Constants ────────────────────────────────────────────────────────────────

/** Sentinel markers for structured output extraction. */
export const SENTINELS = {
  BEGIN: '===CLAUDE_MD_BEGIN===',
  END: '===CLAUDE_MD_END==='
} as const

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgenticRunnerOptions {
  /** Workspace ID — used in MCP server env vars. */
  workspaceId: string
  /** Absolute path to the workspace root. */
  workspacePath: string
  /** The prompt to pass to `claude -p`. */
  prompt: string
  /** Allowed tool names (Claude CLI --allowedTools format). */
  allowedTools: string[]
  /** Claude model to use. */
  model: string
  /** Max agentic turns (default 30). */
  maxTurns?: number
  /** Overall timeout in ms (default 10 min). */
  timeoutMs?: number
  /** AbortSignal for external cancellation. */
  signal?: AbortSignal
  /** Optional callback for stdout line streaming. */
  onLine?: (line: string) => void
  /**
   * Which MCP servers to include (default: ['memory', 'code-graph']).
   * Pass a subset to omit servers the task doesn't need.
   */
  mcpServers?: Array<'memory' | 'code-graph'>
}

export interface AgenticRunnerResult {
  stdout: string
  exitCode: number | null
}

// ── MCP Config Builder ───────────────────────────────────────────────────────

interface McpServerEntry {
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * Build a minimal MCP config object with only the servers the agentic task needs.
 * Reuses the same packaged-vs-dev `serverBasePath` logic from cli-mcp-config-writer.ts.
 */
export function buildMinimalMcpConfig(
  workspaceId: string,
  workspacePath: string,
  servers: Array<'memory' | 'code-graph'> = ['memory', 'code-graph']
): { mcpServers: Record<string, McpServerEntry> } {
  const serverBasePath = app.isPackaged
    ? join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'out', 'main', 'mcp-servers')
    : join(__dirname, 'mcp-servers')

  const dbDir = app.getPath('userData')
  const mcpServers: Record<string, McpServerEntry> = {}

  if (servers.includes('code-graph')) {
    mcpServers['code-graph'] = {
      command: 'node',
      args: [join(serverBasePath, 'code-graph-server.js')],
      env: {
        WORKSPACE_ID: workspaceId,
        WORKSPACE_PATH: workspacePath,
        DB_PATH: dbDir
      }
    }
  }

  if (servers.includes('memory')) {
    mcpServers['memory'] = {
      command: 'node',
      args: [join(serverBasePath, 'memory-server.js')],
      env: {
        WORKSPACE_ID: workspaceId,
        DB_PATH: dbDir
      }
    }
  }

  return { mcpServers }
}

// ── Sentinel Parsing ─────────────────────────────────────────────────────────

/**
 * Extract content between sentinel markers from stdout.
 * Returns the inner content if found, or null if sentinels are missing.
 */
export function parseSentinelBlock(stdout: string): string | null {
  const beginIdx = stdout.indexOf(SENTINELS.BEGIN)
  const endIdx = stdout.indexOf(SENTINELS.END)

  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    return null
  }

  return stdout.substring(beginIdx + SENTINELS.BEGIN.length, endIdx).trim()
}

// ── Runner ───────────────────────────────────────────────────────────────────

/**
 * Spawn Claude CLI as an agentic sub-process with a minimal MCP config
 * and a strict read-only tool whitelist.
 */
export async function runAgenticClaude(opts: AgenticRunnerOptions): Promise<AgenticRunnerResult> {
  const {
    workspaceId,
    workspacePath,
    prompt,
    allowedTools,
    model,
    maxTurns = 30,
    timeoutMs = 10 * 60 * 1000,
    signal,
    onLine,
    mcpServers = ['memory', 'code-graph']
  } = opts

  // ── Write temp MCP config ──
  const tempDir = join(tmpdir(), 'agent-studio-agentic', workspaceId.slice(0, 16))
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true })
  }
  const configPath = join(tempDir, `mcp-config-${Date.now()}.json`)
  const mcpConfig = buildMinimalMcpConfig(workspaceId, workspacePath, mcpServers)

  writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2), 'utf-8')
  runnerLog.info(
    `[runAgenticClaude] MCP config written: ${configPath} (servers: ${Object.keys(mcpConfig.mcpServers).join(', ')})`
  )

  try {
    return await spawnClaudeProcess({
      configPath,
      prompt,
      allowedTools,
      model,
      maxTurns,
      timeoutMs,
      workspacePath,
      signal,
      onLine
    })
  } finally {
    // Clean up temp config
    try {
      unlinkSync(configPath)
    } catch {
      /* file may already be gone */
    }
  }
}

// ── Internal spawn ───────────────────────────────────────────────────────────

interface SpawnOptions {
  configPath: string
  prompt: string
  allowedTools: string[]
  model: string
  maxTurns: number
  timeoutMs: number
  workspacePath: string
  signal?: AbortSignal
  onLine?: (line: string) => void
}

function spawnClaudeProcess(opts: SpawnOptions): Promise<AgenticRunnerResult> {
  const {
    configPath,
    prompt,
    allowedTools,
    model,
    maxTurns,
    timeoutMs,
    workspacePath,
    signal,
    onLine
  } = opts

  return new Promise<AgenticRunnerResult>((resolve, reject) => {
    // Check abort before spawning
    if (signal?.aborted) {
      reject(new Error('Agentic run cancelled before start'))
      return
    }

    const args = buildClaudeArgs({ configPath, prompt, allowedTools, model, maxTurns })

    const env = {
      ...buildEnvWithPath(),
      MCP_TIMEOUT: '30000'
    }

    const child: ChildProcess = spawn('claude', args, {
      cwd: workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true
    })

    runnerLog.info(
      `[runAgenticClaude] Spawned claude (model=${model}, maxTurns=${maxTurns}, allowedTools=${allowedTools.length})`
    )

    let stdout = ''
    let lineBuffer = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout += text

      // Stream lines to callback
      if (onLine) {
        lineBuffer += text
        const lines = lineBuffer.split('\n')
        // Keep the last partial line in the buffer
        lineBuffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed.length > 0) {
            onLine(trimmed)
          }
        }
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) {
        runnerLog.info(`[agentic:stderr] ${text.substring(0, 300)}`)
      }
    })

    // ── Timeout ──
    const timer = setTimeout(() => {
      runnerLog.warn(`[runAgenticClaude] Timed out after ${timeoutMs}ms — killing process`)
      child.kill('SIGTERM')
    }, timeoutMs)

    // ── Abort handling ──
    const onAbort = (): void => {
      child.kill('SIGTERM')
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)

      // Flush remaining buffer
      if (onLine && lineBuffer.trim()) {
        onLine(lineBuffer.trim())
      }

      if (signal?.aborted) {
        reject(new Error('Agentic run cancelled'))
        return
      }

      resolve({ stdout, exitCode: code })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`))
    })
  })
}

// ── Arg builder (exported for testing) ───────────────────────────────────────

export interface ClaudeArgsBuildInput {
  configPath: string
  prompt: string
  allowedTools: string[]
  model: string
  maxTurns: number
}

/**
 * Build the CLI arguments array for `claude`.
 * Exported for unit testing — asserts correct flags are present.
 */
export function buildClaudeArgs(input: ClaudeArgsBuildInput): string[] {
  return [
    '-p',
    input.prompt,
    '--mcp-config',
    input.configPath,
    '--permission-mode',
    'bypassPermissions',
    '--allowedTools',
    input.allowedTools.join(','),
    '--model',
    input.model,
    '--output-format',
    'text',
    '--max-turns',
    String(input.maxTurns)
  ]
}
