#!/usr/bin/env node
/**
 * Process Manager MCP Server — resilient background process management.
 *
 * Exposes four tools: run_background, check_process, stop_process, list_processes.
 * Designed for dev servers, watchers, and tunnels that never exit.
 *
 * **Key design:** Processes are spawned `detached` with log-file stdio so they
 * survive MCP server restarts.  A JSON manifest persists PIDs to disk; on startup
 * the server re-discovers still-running processes and reconnects to their logs.
 *
 * Environment variables:
 *   WORKSPACE_PATH — Absolute workspace path (default cwd)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  appendFileSync,
  renameSync,
  readdirSync
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const WORKSPACE_PATH = process.env.WORKSPACE_PATH ?? process.cwd()

// ── Configuration ──

const MAX_TRACKED_PROCESSES = 5
const RING_BUFFER_MAX_LINES = 200
const MAX_LINE_LENGTH = 500
const INITIAL_OUTPUT_WAIT_MS = 2000
const SIGTERM_GRACE_MS = 3000
const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB
const LOG_TRUNCATE_KEEP_BYTES = 1024 * 1024 // keep last 1 MB on truncation

/**
 * Kill a process and its descendants cross-platform.
 *
 * Unix: sends a signal to the process group (negative PID) — works because
 * children are spawned `detached: true` making them process group leaders.
 *
 * Windows: `process.kill(-pid)` throws ESRCH because negative PIDs are a
 * Unix-only concept.  Instead we shell out to `taskkill /T` which kills the
 * entire process tree rooted at `pid`.  See electron/electron#24520.
 */
function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (process.platform === 'win32') {
    try {
      const forceFlag = signal === 'SIGKILL' ? ' /F' : ''
      execSync(`taskkill /PID ${pid} /T${forceFlag}`, { stdio: 'ignore' })
    } catch {
      /* process may already be dead */
    }
  } else {
    try {
      process.kill(-pid, signal)
    } catch {
      /* group may not exist */
    }
  }
}

/**
 * Check whether a process is still alive cross-platform.
 *
 * Unix: `process.kill(pid, 0)` — signal 0 tests existence without sending a signal.
 * We use positive PID here (not group) since we just want to check the leader.
 *
 * Windows: `tasklist` with a PID filter — exits 0 if the process exists.
 */
function isProcessAlive(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      execSync(`tasklist /FI "PID eq ${pid}" /NH`, { stdio: 'ignore' })
      return true
    }
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

// ── Command Allowlist ──
// Only commands whose first token matches this list (or ends with one of these
// after a path separator) are permitted.  This limits the blast radius of the
// `run_background` tool which executes commands with `shell: true`.
//
// THREAT MODEL: The allowlist prevents direct shell/network tool execution
// (curl, wget, sh, bash, powershell, rm, etc.) but does NOT prevent
// argument-level injection within allowed commands (e.g., `node -e "..."`
// or `npm run "$(malicious)"`).  This is intentional — the MCP trust
// boundary is the AI agent itself, and blocking argument injection would
// break legitimate use cases (npm scripts with arguments, node -e for
// quick tests, etc.).  The allowlist exists to prevent accidental execution
// of system-level tools by a misguided LLM, not to sandbox arbitrary code.
const ALLOWED_COMMAND_PREFIXES = [
  'npm', 'npx', 'yarn', 'pnpm', 'node', 'python', 'python3',
  'go', 'cargo', 'make', 'gradle', 'mvn', 'dotnet', 'ruby',
  'docker', 'docker-compose', 'supabase', 'firebase',
  'bun', 'deno', 'tsx', 'ts-node', 'jest', 'vitest', 'playwright'
]

// ── State Directory ──

const STATE_DIR = join(WORKSPACE_PATH, '.pm-state')
const MANIFEST_PATH = join(STATE_DIR, 'manifest.json')
const LOGS_DIR = join(STATE_DIR, 'logs')

// ── Manifest Types ──

interface ProcessManifestEntry {
  pid: number
  label: string
  command: string
  cwd: string
  startedAt: number
  logFile: string // filename relative to LOGS_DIR
}

// ── Ring Buffer ──

export class RingBuffer {
  private lines: string[] = []
  private capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
  }

  push(line: string): void {
    const trimmed = line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + '…' : line
    if (this.lines.length >= this.capacity) {
      this.lines.shift()
    }
    this.lines.push(trimmed)
  }

  pushMultiline(data: string): void {
    const dataLines = data.split('\n')
    for (const line of dataLines) {
      if (line.length > 0) {
        this.push(line)
      }
    }
  }

  getRecent(count: number): string[] {
    return this.lines.slice(-count)
  }

  getAll(): string[] {
    return [...this.lines]
  }

  get length(): number {
    return this.lines.length
  }
}

// ── Tracked Process ──

export interface TrackedProcess {
  pid: number
  child: ChildProcess | null // null for reconnected processes
  label: string
  command: string
  cwd: string
  startedAt: number
  logFile: string // filename in LOGS_DIR
  output: RingBuffer
  exitCode: number | null
  exited: boolean
  reconnected: boolean // true if rediscovered on startup
}

const trackedProcesses = new Map<number, TrackedProcess>()

// ── State Directory & Manifest Helpers ──

let gitignorePatched = false

function ensureStateDir(): void {
  mkdirSync(LOGS_DIR, { recursive: true })

  // Auto-append .pm-state/ to .gitignore if it exists and doesn't already contain it
  if (!gitignorePatched) {
    try {
      const gitignorePath = join(WORKSPACE_PATH, '.gitignore')
      if (existsSync(gitignorePath)) {
        const content = readFileSync(gitignorePath, 'utf-8')
        if (content.includes('.pm-state')) {
          gitignorePatched = true // already there
        } else {
          appendFileSync(gitignorePath, '\n# Process manager state (auto-generated)\n.pm-state/\n')
          gitignorePatched = true
        }
      } else {
        gitignorePatched = true // no .gitignore — nothing to patch
      }
    } catch {
      /* non-critical */
    }
  }
}

function readManifest(): ProcessManifestEntry[] {
  try {
    if (!existsSync(MANIFEST_PATH)) return []
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
  } catch {
    return []
  }
}

function writeManifest(): void {
  try {
    ensureStateDir()
    const entries: ProcessManifestEntry[] = [...trackedProcesses.values()]
      .filter((p) => !p.exited)
      .map((p) => ({
        pid: p.pid,
        label: p.label,
        command: p.command,
        cwd: p.cwd,
        startedAt: p.startedAt,
        logFile: p.logFile
      }))
    writeFileSync(MANIFEST_PATH, JSON.stringify(entries, null, 2))
  } catch {
    /* non-critical — manifest write failure shouldn't crash the server */
  }
}

// ── Log Hygiene ──

function truncateLogIfNeeded(logPath: string): void {
  try {
    const stats = statSync(logPath)
    if (stats.size > MAX_LOG_SIZE_BYTES) {
      const content = readFileSync(logPath, 'utf-8')
      const truncated = content.slice(-LOG_TRUNCATE_KEEP_BYTES)
      writeFileSync(logPath, truncated)
    }
  } catch {
    /* ignore — file may not exist or be locked */
  }
}

function deleteLogFile(logFile: string): void {
  try {
    const logPath = join(LOGS_DIR, logFile)
    if (existsSync(logPath)) {
      unlinkSync(logPath)
    }
  } catch {
    /* ignore */
  }
}

function refreshOutputFromLog(tracked: TrackedProcess): void {
  if (!tracked.logFile) return
  try {
    const logPath = join(LOGS_DIR, tracked.logFile)
    if (existsSync(logPath)) {
      truncateLogIfNeeded(logPath)
      const content = readFileSync(logPath, 'utf-8')
      const lines = content.split('\n').filter(Boolean).slice(-RING_BUFFER_MAX_LINES)
      tracked.output = new RingBuffer(RING_BUFFER_MAX_LINES)
      for (const line of lines) tracked.output.push(line)
    }
  } catch {
    /* log read failed */
  }
}

// ── PID Ownership Validation ──

function validatePidOwnership(pid: number, expectedCommand: string): boolean {
  try {
    const comm = execSync(`ps -o comm= -p ${pid}`, {
      encoding: 'utf-8',
      timeout: 2000
    }).trim()
    // Check if the process executable name appears in the original command.
    // e.g., command "npm run dev" → shell spawns "node" → comm is "node"
    // We check both directions: comm in command, or command contains comm's basename.
    const commBase = comm.split('/').pop() ?? comm
    return (
      expectedCommand.includes(commBase) ||
      commBase === 'sh' ||
      commBase === 'bash' ||
      commBase === 'zsh'
    )
  } catch {
    return false // ps failed — treat as PID reuse (conservative)
  }
}

// ── Startup Reconnection ──

function reconnectFromManifest(): void {
  const entries = readManifest()
  let reconnected = 0

  for (const entry of entries) {
    // Check if process is still alive
    let alive = false
    try {
      process.kill(entry.pid, 0) // signal 0 = liveness check
      alive = true
    } catch {
      /* dead */
    }

    if (alive) {
      // Validate this is actually our process (not PID reuse)
      if (!validatePidOwnership(entry.pid, entry.command)) {
        console.error(`[process-manager] PID ${entry.pid} reused by another process — discarding "${entry.label}"`)
        deleteLogFile(entry.logFile)
        continue // skip reconnection
      }

      const output = new RingBuffer(RING_BUFFER_MAX_LINES)

      // Load recent output from log file
      try {
        const logPath = join(LOGS_DIR, entry.logFile)
        if (existsSync(logPath)) {
          const content = readFileSync(logPath, 'utf-8')
          const lines = content
            .split('\n')
            .filter(Boolean)
            .slice(-RING_BUFFER_MAX_LINES)
          for (const line of lines) {
            output.push(line)
          }
        }
      } catch {
        /* log file may be gone */
      }

      trackedProcesses.set(entry.pid, {
        pid: entry.pid,
        child: null, // no ChildProcess handle for reconnected processes
        label: entry.label,
        command: entry.command,
        cwd: entry.cwd,
        startedAt: entry.startedAt,
        logFile: entry.logFile,
        output,
        exitCode: null,
        exited: false,
        reconnected: true
      })
      reconnected++
    } else {
      // Dead process — clean up its log file
      deleteLogFile(entry.logFile)
    }
  }

  // Rewrite manifest (removes dead entries)
  writeManifest()

  if (reconnected > 0) {
    console.error(`[process-manager] Reconnected to ${reconnected} running process(es)`)
  }

  // Sweep orphan log files not referenced by any tracked process
  sweepOrphanLogs()
}

function sweepOrphanLogs(): void {
  try {
    const logFiles = readdirSync(LOGS_DIR).filter((f) => f.endsWith('.log'))
    const knownLogFiles = new Set([...trackedProcesses.values()].map((p) => p.logFile))
    let swept = 0
    for (const file of logFiles) {
      if (!knownLogFiles.has(file)) {
        deleteLogFile(file)
        swept++
      }
    }
    if (swept > 0) {
      console.error(`[process-manager] Swept ${swept} orphan log file(s)`)
    }
  } catch {
    /* non-critical */
  }
}

// ── Exit Handler (persist manifest, do NOT kill children) ──

function onExit(): void {
  writeManifest()
}

process.on('exit', onExit)
process.on('SIGTERM', () => {
  onExit()
  process.exit(0)
})
process.on('SIGINT', () => {
  onExit()
  process.exit(0)
})

// ── MCP Server ──

const server = new McpServer({
  name: 'process-manager',
  version: '1.0.0'
})

// ── Tool: run_background ──

server.tool(
  'run_background',
  'Spawn a command in the background and return immediately. Use instead of Bash for dev servers, watchers, and commands that don\'t exit. Processes survive across sessions.',
  {
    command: z.string().describe('Shell command to run (e.g., "npm run dev")'),
    cwd: z.string().optional().describe('Working directory (defaults to workspace root)'),
    label: z.string().optional().describe('Human label for tracking (e.g., "Vite dev server")')
  },
  async ({ command, cwd, label }) => {
    // Enforce command allowlist — mitigates shell injection surface
    const firstToken = command.trim().split(/\s+/)[0]
    if (
      !ALLOWED_COMMAND_PREFIXES.some(
        (p) => firstToken === p || firstToken.endsWith(`/${p}`)
      )
    ) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: `Command "${firstToken}" is not in the allowed command list. Allowed prefixes: ${ALLOWED_COMMAND_PREFIXES.join(', ')}`
            })
          }
        ]
      }
    }

    // Enforce max concurrent processes
    const aliveCount = [...trackedProcesses.values()].filter((p) => !p.exited).length
    if (aliveCount >= MAX_TRACKED_PROCESSES) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: `Maximum ${MAX_TRACKED_PROCESSES} concurrent background processes reached. Use stop_process to terminate one first.`,
              running: [...trackedProcesses.values()]
                .filter((p) => !p.exited)
                .map((p) => ({ pid: p.pid, label: p.label, command: p.command }))
            })
          }
        ]
      }
    }

    const workingDir = cwd ?? WORKSPACE_PATH
    const processLabel = label ?? command.slice(0, 60)

    ensureStateDir()

    // Create log file for process output (survives parent exit)
    const logFileName = `${Date.now()}-pending.log`
    const logPath = join(LOGS_DIR, logFileName)
    const logFd = openSync(logPath, 'a')

    const child = spawn(command, {
      shell: true,
      cwd: workingDir,
      detached: true, // own process group — survives MCP server exit
      stdio: ['ignore', logFd, logFd] // stdout+stderr → log file
    })

    // Close the fd in the parent — the child inherited it
    closeSync(logFd)

    if (!child.pid) {
      // Clean up the empty log file
      deleteLogFile(logFileName)
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: 'Failed to spawn process — no PID returned' })
          }
        ]
      }
    }

    // Rename log file to include the actual PID
    const finalLogFileName = `${Date.now()}-${child.pid}.log`
    const finalLogPath = join(LOGS_DIR, finalLogFileName)
    try {
      renameSync(logPath, finalLogPath)
    } catch {
      /* rename failed — use original name */
    }
    const actualLogFile = existsSync(finalLogPath) ? finalLogFileName : logFileName

    // Let the parent not wait for the child
    child.unref()

    const output = new RingBuffer(RING_BUFFER_MAX_LINES)
    const tracked: TrackedProcess = {
      pid: child.pid,
      child,
      label: processLabel,
      command,
      cwd: workingDir,
      startedAt: Date.now(),
      logFile: actualLogFile,
      output,
      exitCode: null,
      exited: false,
      reconnected: false
    }

    trackedProcesses.set(child.pid, tracked)

    child.on('exit', (code) => {
      tracked.exitCode = code
      tracked.exited = true
      writeManifest()
    })

    child.on('error', (err) => {
      output.push(`[process error] ${err.message}`)
      tracked.exited = true
      writeManifest()
    })

    // Persist to manifest immediately
    writeManifest()

    // Wait briefly for initial output (catches immediate errors like EADDRINUSE)
    await new Promise((resolve) => setTimeout(resolve, INITIAL_OUTPUT_WAIT_MS))

    // Read initial output from log file
    refreshOutputFromLog(tracked)
    const initialOutput = tracked.output.getAll().join('\n')

    // Refresh liveness — process may have exited during the wait
    if (!tracked.exited) {
      try {
        process.kill(child.pid, 0)
      } catch {
        tracked.exited = true
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            pid: child.pid,
            label: processLabel,
            status: tracked.exited ? 'exited' : 'running',
            exitCode: tracked.exitCode,
            initialOutput: initialOutput || '(no output yet)'
          })
        }
      ]
    }
  }
)

// ── Tool: check_process ──

server.tool(
  'check_process',
  'Check if a background process is still running and get its recent output (from log files — works across sessions).',
  {
    pid: z.number().describe('Process ID to check')
  },
  async ({ pid }) => {
    const tracked = trackedProcesses.get(pid)
    if (!tracked) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: `No tracked process with PID ${pid}. Use list_processes to see all tracked processes.`
            })
          }
        ]
      }
    }

    // Double-check liveness via signal 0
    let alive = !tracked.exited
    if (alive) {
      try {
        process.kill(pid, 0)
      } catch {
        alive = false
        tracked.exited = true
        writeManifest()
      }
    }

    // Refresh output from log file (works for both spawned and reconnected processes)
    refreshOutputFromLog(tracked)

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            pid: tracked.pid,
            label: tracked.label,
            command: tracked.command,
            alive,
            exitCode: tracked.exitCode,
            uptimeMs: Date.now() - tracked.startedAt,
            reconnected: tracked.reconnected,
            recentOutput: tracked.output.getRecent(50).join('\n')
          })
        }
      ]
    }
  }
)

// ── Tool: stop_process ──

server.tool(
  'stop_process',
  'Stop a background process. Sends SIGTERM, then SIGKILL after 3 seconds if still alive.',
  {
    pid: z.number().describe('Process ID to stop')
  },
  async ({ pid }) => {
    const tracked = trackedProcesses.get(pid)
    if (!tracked) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: `No tracked process with PID ${pid}. Use list_processes to see all tracked processes.`
            })
          }
        ]
      }
    }

    if (tracked.exited) {
      trackedProcesses.delete(pid)
      deleteLogFile(tracked.logFile)
      writeManifest()
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              pid,
              stopped: true,
              exitCode: tracked.exitCode,
              note: 'Process had already exited'
            })
          }
        ]
      }
    }

    // Kill the entire process group (negative PID) so shell children are also terminated.
    // detached: true makes the child the process group leader, so PGID == PID.
    if (tracked.reconnected || !tracked.child) {
      // Reconnected processes — no ChildProcess handle, kill process tree directly
      killProcessTree(pid, 'SIGTERM')

      // Wait for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, SIGTERM_GRACE_MS))

      // Check if still alive, escalate to SIGKILL
      if (isProcessAlive(pid)) {
        killProcessTree(pid, 'SIGKILL')
      }

      await new Promise((resolve) => setTimeout(resolve, 200))
    } else {
      // Spawned processes — kill the entire process tree rooted at child's PID
      killProcessTree(tracked.pid, 'SIGTERM')

      // Wait for graceful shutdown
      const exitedGracefully = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), SIGTERM_GRACE_MS)
        tracked.child!.on('exit', () => {
          clearTimeout(timeout)
          resolve(true)
        })
        // Already exited during the wait
        if (tracked.exited) {
          clearTimeout(timeout)
          resolve(true)
        }
      })

      if (!exitedGracefully) {
        killProcessTree(tracked.pid, 'SIGKILL')
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }

    // Capture final output before deleting log
    refreshOutputFromLog(tracked)
    const finalOutput = tracked.output.getRecent(30).join('\n')

    trackedProcesses.delete(pid)
    deleteLogFile(tracked.logFile)
    writeManifest()

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            pid,
            stopped: true,
            exitCode: tracked.exitCode,
            method: tracked.reconnected ? 'process.kill' : 'child.kill',
            finalOutput: finalOutput || '(no output captured)'
          })
        }
      ]
    }
  }
)

// ── Tool: list_processes ──

server.tool(
  'list_processes',
  'List all tracked background processes with their status (includes processes from previous sessions).',
  {},
  async () => {
    // Collect dead PIDs for auto-reap
    const deadPids: number[] = []

    const processes = [...trackedProcesses.values()].map((p) => {
      // Refresh liveness
      let alive = !p.exited
      if (alive) {
        try {
          process.kill(p.pid, 0)
        } catch {
          alive = false
          p.exited = true
        }
      }

      if (!alive) deadPids.push(p.pid)

      return {
        pid: p.pid,
        label: p.label,
        command: p.command,
        alive,
        exitCode: p.exitCode,
        uptimeMs: Date.now() - p.startedAt,
        reconnected: p.reconnected
      }
    })

    // Auto-reap dead processes — free up slots
    for (const deadPid of deadPids) {
      const dead = trackedProcesses.get(deadPid)
      if (dead) {
        deleteLogFile(dead.logFile)
        trackedProcesses.delete(deadPid)
      }
    }

    writeManifest()

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            count: processes.length,
            aliveCount: processes.filter((p) => p.alive).length,
            maxAllowed: MAX_TRACKED_PROCESSES,
            reaped: deadPids.length,
            processes
          })
        }
      ]
    }
  }
)

// ── Start ──

async function main(): Promise<void> {
  ensureStateDir()
  reconnectFromManifest()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[process-manager-server] Started — workspace:', WORKSPACE_PATH)
}

main().catch((err) => {
  console.error('[process-manager-server] Fatal:', err)
  process.exit(1)
})
