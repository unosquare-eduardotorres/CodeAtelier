#!/usr/bin/env node
/**
 * Process Manager MCP Server — fire-and-forget for long-running commands.
 *
 * Exposes four tools: run_background, check_process, stop_process, list_processes.
 * Designed for dev servers, watchers, and tunnels that never exit.
 *
 * Environment variables:
 *   WORKSPACE_PATH — Absolute workspace path (default cwd)
 *
 * Cleanup: all tracked child processes are killed on exit/SIGTERM/SIGINT.
 * Processes use `detached: false` so they share the MCP server's process group.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { z } from 'zod'

const WORKSPACE_PATH = process.env.WORKSPACE_PATH ?? process.cwd()

// ── Configuration ──

const MAX_TRACKED_PROCESSES = 5
const RING_BUFFER_MAX_LINES = 200
const MAX_LINE_LENGTH = 500
const INITIAL_OUTPUT_WAIT_MS = 2000
const SIGTERM_GRACE_MS = 3000

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
  child: ChildProcess
  label: string
  command: string
  startedAt: number
  output: RingBuffer
  exitCode: number | null
  exited: boolean
}

const trackedProcesses = new Map<number, TrackedProcess>()

// ── Cleanup ──

let cleaningUp = false

function cleanupAll(): void {
  if (cleaningUp) return
  cleaningUp = true

  for (const [, proc] of trackedProcesses) {
    try {
      proc.child.kill('SIGTERM')
    } catch {
      /* already dead */
    }
  }

  // Force kill after grace period
  setTimeout(() => {
    for (const [, proc] of trackedProcesses) {
      try {
        proc.child.kill('SIGKILL')
      } catch {
        /* already dead */
      }
    }
    trackedProcesses.clear()
  }, 2000)
}

process.on('exit', cleanupAll)
process.on('SIGTERM', () => {
  cleanupAll()
  process.exit(0)
})
process.on('SIGINT', () => {
  cleanupAll()
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
  'Spawn a command in the background and return immediately. Use instead of Bash for dev servers, watchers, and commands that don\'t exit.',
  {
    command: z.string().describe('Shell command to run (e.g., "npm run dev")'),
    cwd: z.string().optional().describe('Working directory (defaults to workspace root)'),
    label: z.string().optional().describe('Human label for tracking (e.g., "Vite dev server")')
  },
  async ({ command, cwd, label }) => {
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

    const child = spawn(command, {
      shell: true,
      cwd: workingDir,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    if (!child.pid) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: 'Failed to spawn process — no PID returned' })
          }
        ]
      }
    }

    const output = new RingBuffer(RING_BUFFER_MAX_LINES)
    const tracked: TrackedProcess = {
      pid: child.pid,
      child,
      label: processLabel,
      command,
      startedAt: Date.now(),
      output,
      exitCode: null,
      exited: false
    }

    trackedProcesses.set(child.pid, tracked)

    // Capture stdout/stderr into ring buffer
    child.stdout?.on('data', (data: Buffer) => {
      output.pushMultiline(data.toString())
    })
    child.stderr?.on('data', (data: Buffer) => {
      output.pushMultiline(data.toString())
    })

    child.on('exit', (code) => {
      tracked.exitCode = code
      tracked.exited = true
    })

    child.on('error', (err) => {
      output.push(`[process error] ${err.message}`)
      tracked.exited = true
    })

    // Wait briefly for initial output (catches immediate errors like EADDRINUSE)
    await new Promise((resolve) => setTimeout(resolve, INITIAL_OUTPUT_WAIT_MS))

    const initialOutput = output.getAll().join('\n')

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
  'Check if a background process is still running and get its recent output.',
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
      }
    }

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

    // SIGTERM → wait → SIGKILL escalation
    try {
      tracked.child.kill('SIGTERM')
    } catch {
      /* already dead */
    }

    // Wait for graceful shutdown
    const exitedGracefully = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), SIGTERM_GRACE_MS)
      tracked.child.on('exit', () => {
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
      try {
        tracked.child.kill('SIGKILL')
      } catch {
        /* already dead */
      }
      // Brief wait for SIGKILL to take effect
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    trackedProcesses.delete(pid)

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            pid,
            stopped: true,
            exitCode: tracked.exitCode,
            method: exitedGracefully ? 'SIGTERM' : 'SIGKILL'
          })
        }
      ]
    }
  }
)

// ── Tool: list_processes ──

server.tool(
  'list_processes',
  'List all tracked background processes with their status.',
  {},
  async () => {
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

      return {
        pid: p.pid,
        label: p.label,
        command: p.command,
        alive,
        exitCode: p.exitCode,
        uptimeMs: Date.now() - p.startedAt
      }
    })

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            count: processes.length,
            maxAllowed: MAX_TRACKED_PROCESSES,
            processes
          })
        }
      ]
    }
  }
)

// ── Start ──

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[process-manager-server] Started — workspace:', WORKSPACE_PATH)
}

main().catch((err) => {
  console.error('[process-manager-server] Fatal:', err)
  process.exit(1)
})
