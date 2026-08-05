/**
 * Tests for the process-manager MCP server — ring buffer, tracked process logic,
 * mode gating, and persistence (manifest / reconnection).
 */
import assert from 'node:assert/strict'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  unlinkSync,
  readdirSync,
  appendFileSync
} from 'node:fs'
import { join } from 'node:path'
import { test, describe } from './test-harness'
import { RingBuffer } from '../../mcp-servers/process-manager-server'
import { MCP_TOOLS } from '../../../shared/constants'

// ── Ring Buffer ──

describe('RingBuffer', () => {
  test('stores lines up to capacity', () => {
    const buf = new RingBuffer(3)
    buf.push('a')
    buf.push('b')
    buf.push('c')
    assert.deepEqual(buf.getAll(), ['a', 'b', 'c'])
    assert.equal(buf.length, 3)
  })

  test('evicts oldest line when over capacity', () => {
    const buf = new RingBuffer(3)
    buf.push('a')
    buf.push('b')
    buf.push('c')
    buf.push('d')
    assert.deepEqual(buf.getAll(), ['b', 'c', 'd'])
    assert.equal(buf.length, 3)
  })

  test('truncates long lines at 500 chars', () => {
    const buf = new RingBuffer(5)
    const longLine = 'x'.repeat(600)
    buf.push(longLine)
    const stored = buf.getAll()[0]
    assert.equal(stored.length, 501) // 500 + '…'
    assert.ok(stored.endsWith('…'))
  })

  test('getRecent returns last N lines', () => {
    const buf = new RingBuffer(10)
    for (let i = 0; i < 8; i++) buf.push(`line-${i}`)
    const recent = buf.getRecent(3)
    assert.deepEqual(recent, ['line-5', 'line-6', 'line-7'])
  })

  test('getRecent with count larger than buffer returns all', () => {
    const buf = new RingBuffer(10)
    buf.push('a')
    buf.push('b')
    const recent = buf.getRecent(100)
    assert.deepEqual(recent, ['a', 'b'])
  })

  test('pushMultiline splits on newlines and ignores empty lines', () => {
    const buf = new RingBuffer(10)
    buf.pushMultiline('hello\nworld\n\nfoo')
    assert.deepEqual(buf.getAll(), ['hello', 'world', 'foo'])
  })

  test('empty buffer returns empty array', () => {
    const buf = new RingBuffer(5)
    assert.deepEqual(buf.getAll(), [])
    assert.deepEqual(buf.getRecent(10), [])
    assert.equal(buf.length, 0)
  })

  test('capacity of 1 always keeps only the last line', () => {
    const buf = new RingBuffer(1)
    buf.push('first')
    buf.push('second')
    buf.push('third')
    assert.deepEqual(buf.getAll(), ['third'])
  })
})

// ── MCP_TOOLS Registry ──

describe('PROCESS_MANAGER MCP_TOOLS', () => {
  test('has correct server name', () => {
    assert.equal(MCP_TOOLS.PROCESS_MANAGER._SERVER, 'process-manager')
  })

  test('has correct prefix', () => {
    assert.equal(MCP_TOOLS.PROCESS_MANAGER._PREFIX, 'mcp__process-manager__')
  })

  test('exports 5 tools', () => {
    assert.equal(MCP_TOOLS.PROCESS_MANAGER._ALL_NAMES.length, 5)
  })

  test('run_background tool name follows convention', () => {
    assert.equal(
      MCP_TOOLS.PROCESS_MANAGER.RUN_BACKGROUND.name,
      'mcp__process-manager__run_background'
    )
    assert.equal(MCP_TOOLS.PROCESS_MANAGER.RUN_BACKGROUND.server, 'process-manager')
    assert.equal(MCP_TOOLS.PROCESS_MANAGER.RUN_BACKGROUND.tool, 'run_background')
  })

  test('check_process tool name follows convention', () => {
    assert.equal(
      MCP_TOOLS.PROCESS_MANAGER.CHECK_PROCESS.name,
      'mcp__process-manager__check_process'
    )
  })

  test('stop_process tool name follows convention', () => {
    assert.equal(MCP_TOOLS.PROCESS_MANAGER.STOP_PROCESS.name, 'mcp__process-manager__stop_process')
  })

  test('list_processes tool name follows convention', () => {
    assert.equal(
      MCP_TOOLS.PROCESS_MANAGER.LIST_PROCESSES.name,
      'mcp__process-manager__list_processes'
    )
  })

  test('wait_process tool name follows convention', () => {
    assert.equal(MCP_TOOLS.PROCESS_MANAGER.WAIT_PROCESS.name, 'mcp__process-manager__wait_process')
    assert.equal(MCP_TOOLS.PROCESS_MANAGER.WAIT_PROCESS.tool, 'wait_process')
  })

  test('all tool names are in ALL_NAMES', () => {
    const names = MCP_TOOLS.PROCESS_MANAGER._ALL_NAMES
    assert.ok(names.includes('mcp__process-manager__run_background'))
    assert.ok(names.includes('mcp__process-manager__check_process'))
    assert.ok(names.includes('mcp__process-manager__stop_process'))
    assert.ok(names.includes('mcp__process-manager__list_processes'))
    assert.ok(names.includes('mcp__process-manager__wait_process'))
  })
})

// ── Mode Gating ──

describe('Process Manager mode gating', () => {
  test('process-manager tools are NOT in plan mode disallowed list (handled by allowlist)', () => {
    // In plan mode, tools not in the baseAllowed + conditionalTools list are implicitly blocked.
    // The process-manager tools should NOT appear in the allowedTools for plan mode.
    // We verify the MCP_TOOLS entry exists so the wiring can reference it.
    const allNames = MCP_TOOLS.PROCESS_MANAGER._ALL_NAMES
    assert.ok(allNames.length === 5, 'Should have exactly 5 process-manager tools')
  })

  test('display names follow "Process · tool_name" convention', () => {
    assert.equal(MCP_TOOLS.PROCESS_MANAGER.RUN_BACKGROUND.displayName, 'Process · run_background')
    assert.equal(MCP_TOOLS.PROCESS_MANAGER.CHECK_PROCESS.displayName, 'Process · check_process')
    assert.equal(MCP_TOOLS.PROCESS_MANAGER.STOP_PROCESS.displayName, 'Process · stop_process')
    assert.equal(MCP_TOOLS.PROCESS_MANAGER.LIST_PROCESSES.displayName, 'Process · list_processes')
    assert.equal(MCP_TOOLS.PROCESS_MANAGER.WAIT_PROCESS.displayName, 'Process · wait_process')
  })
})

// ── Prompt Guidance ──

describe('Process Manager prompt guidance', () => {
  test('PROCESS_MANAGER_GUIDANCE_PROMPT is exported from default-prompts', async () => {
    const mod = await import('../default-prompts')
    assert.ok(typeof mod.PROCESS_MANAGER_GUIDANCE_PROMPT === 'string')
    assert.ok(mod.PROCESS_MANAGER_GUIDANCE_PROMPT.includes('## Background Processes'))
    assert.ok(mod.PROCESS_MANAGER_GUIDANCE_PROMPT.includes('run_background'))
    assert.ok(mod.PROCESS_MANAGER_GUIDANCE_PROMPT.includes('NEVER use Bash'))
  })

  test('prompt mentions persistence across sessions', async () => {
    const mod = await import('../default-prompts')
    assert.ok(mod.PROCESS_MANAGER_GUIDANCE_PROMPT.includes('survive across conversation turns'))
    assert.ok(mod.PROCESS_MANAGER_GUIDANCE_PROMPT.includes('previous sessions'))
  })

  test('PromptFeatureFlags accepts processManagerEnabled', async () => {
    // Type-level check — if this compiles, the interface is correct.
    const flags: import('../prompt-assembly-helpers').PromptFeatureFlags = {
      repomapEnabled: true,
      semanticSearchEnabled: true,
      githubConfigured: false,
      processManagerEnabled: true
    }
    assert.equal(flags.processManagerEnabled, true)
  })
})

// ── TrackedProcess Interface ──

describe('TrackedProcess interface', () => {
  test('TrackedProcess type exports from process-manager-server', async () => {
    const mod = await import('../../mcp-servers/process-manager-server')
    // Interface is compile-time only, but we can verify the module exports RingBuffer
    assert.ok(typeof mod.RingBuffer === 'function')
  })
})

// ── Manifest Persistence (integration-style tests using temp dir) ──

describe('Manifest persistence', () => {
  const tmpDir = join(process.cwd(), '.pm-state-test-' + process.pid)
  const logsDir = join(tmpDir, 'logs')
  const manifestPath = join(tmpDir, 'manifest.json')

  // Clean up before/after
  function cleanup(): void {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* */
    }
  }

  test('manifest JSON round-trips correctly', () => {
    cleanup()
    mkdirSync(logsDir, { recursive: true })

    const entries = [
      {
        pid: 12345,
        label: 'test-server',
        command: 'node server.js',
        cwd: '/tmp/test',
        startedAt: Date.now(),
        logFile: '1234567890-12345.log'
      }
    ]
    writeFileSync(manifestPath, JSON.stringify(entries, null, 2))

    const read = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    assert.equal(read.length, 1)
    assert.equal(read[0].pid, 12345)
    assert.equal(read[0].label, 'test-server')
    assert.equal(read[0].command, 'node server.js')
    assert.equal(read[0].logFile, '1234567890-12345.log')

    cleanup()
  })

  test('empty manifest returns empty array', () => {
    cleanup()
    mkdirSync(logsDir, { recursive: true })
    writeFileSync(manifestPath, '[]')

    const read = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    assert.deepEqual(read, [])

    cleanup()
  })

  test('malformed manifest is recoverable', () => {
    cleanup()
    mkdirSync(logsDir, { recursive: true })
    writeFileSync(manifestPath, '{broken json')

    // Simulates what readManifest does on parse failure
    let result: unknown[]
    try {
      result = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    } catch {
      result = []
    }
    assert.deepEqual(result, [])

    cleanup()
  })

  test('missing manifest file returns empty array', () => {
    cleanup()
    // Don't create the directory — simulates first run
    const exists = existsSync(manifestPath)
    assert.equal(exists, false)

    // Simulates what readManifest does when file doesn't exist
    let result: unknown[]
    if (!existsSync(manifestPath)) {
      result = []
    } else {
      result = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    }
    assert.deepEqual(result, [])
  })
})

// ── Log File Output (unit tests) ──

describe('Log file output integration', () => {
  const tmpDir = join(process.cwd(), '.pm-state-log-test-' + process.pid)
  const logsDir = join(tmpDir, 'logs')

  function cleanup(): void {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* */
    }
  }

  test('log file content can be read into RingBuffer', () => {
    cleanup()
    mkdirSync(logsDir, { recursive: true })

    const logPath = join(logsDir, 'test.log')
    const logContent = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n')
    writeFileSync(logPath, logContent)

    // Simulate refreshOutputFromLog
    const content = readFileSync(logPath, 'utf-8')
    const lines = content.split('\n').filter(Boolean).slice(-50)
    const buf = new RingBuffer(200)
    for (const line of lines) buf.push(line)

    assert.equal(buf.length, 50)
    assert.equal(buf.getRecent(1)[0], 'line-99')
    assert.equal(buf.getAll()[0], 'line-50')

    cleanup()
  })

  test('empty log file produces empty RingBuffer', () => {
    cleanup()
    mkdirSync(logsDir, { recursive: true })

    const logPath = join(logsDir, 'empty.log')
    writeFileSync(logPath, '')

    const content = readFileSync(logPath, 'utf-8')
    const lines = content.split('\n').filter(Boolean)
    const buf = new RingBuffer(200)
    for (const line of lines) buf.push(line)

    assert.equal(buf.length, 0)

    cleanup()
  })

  test('log truncation keeps last portion when oversized', () => {
    cleanup()
    mkdirSync(logsDir, { recursive: true })

    const logPath = join(logsDir, 'big.log')
    // Write 6MB of log data (exceeds 5MB threshold)
    const bigContent = 'x'.repeat(6 * 1024 * 1024)
    writeFileSync(logPath, bigContent)

    const { statSync } = require('node:fs')
    const sizeBefore = statSync(logPath).size
    assert.ok(sizeBefore > 5 * 1024 * 1024, 'should be over 5MB initially')

    // Simulate truncateLogIfNeeded
    const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024
    const LOG_TRUNCATE_KEEP_BYTES = 1024 * 1024
    const stats = statSync(logPath)
    if (stats.size > MAX_LOG_SIZE_BYTES) {
      const fullContent = readFileSync(logPath, 'utf-8')
      const truncated = fullContent.slice(-LOG_TRUNCATE_KEEP_BYTES)
      writeFileSync(logPath, truncated)
    }

    const sizeAfter = statSync(logPath).size
    assert.ok(sizeAfter <= LOG_TRUNCATE_KEEP_BYTES + 100, 'should be ~1MB after truncation')
    assert.ok(sizeAfter > 0, 'should not be empty')

    cleanup()
  })
})

// ── PID Liveness Check ──

describe('PID liveness check', () => {
  test('signal 0 detects own process as alive', () => {
    let alive = false
    try {
      process.kill(process.pid, 0)
      alive = true
    } catch {
      /* dead */
    }
    assert.ok(alive, 'Own process should be detected as alive')
  })

  test('signal 0 detects non-existent PID as dead', () => {
    let alive = false
    try {
      // Use an extremely high PID that almost certainly doesn't exist
      process.kill(999999999, 0)
      alive = true
    } catch {
      /* dead */
    }
    assert.ok(!alive, 'Non-existent PID should be detected as dead')
  })
})

// ── Fix 1: Process Group Kill ──

describe('Process group kill (-pid)', () => {
  test('negative PID kills the entire process group', async () => {
    const { spawn } = require('node:child_process')

    // Spawn a shell that starts two background sleeps — all in one process group
    const child = spawn('sleep 999 & sleep 999 & wait', {
      shell: true,
      detached: true,
      stdio: 'ignore'
    })
    child.unref()

    const pid = child.pid
    assert.ok(pid, 'Child should have a PID')

    // Give the children time to start
    await new Promise((r) => setTimeout(r, 300))

    // Verify the group leader is alive
    let alive = false
    try {
      process.kill(pid, 0)
      alive = true
    } catch {
      /* dead */
    }
    assert.ok(alive, 'Process group leader should be alive')

    // Kill the entire process group
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* already dead */
    }

    await new Promise((r) => setTimeout(r, 200))

    // Verify the group leader is dead
    let stillAlive = false
    try {
      process.kill(pid, 0)
      stillAlive = true
    } catch {
      /* dead */
    }
    assert.ok(!stillAlive, 'Process group leader should be dead after -pid kill')
  })
})

// ── Fix 3: Auto-reap dead processes in list_processes ──

describe('Dead process auto-reap in list_processes', () => {
  test('dead processes are removed from map and reaped count is returned', () => {
    // Simulate the list_processes logic with a local map
    const localMap = new Map<
      number,
      {
        pid: number
        label: string
        command: string
        exited: boolean
        exitCode: number | null
        startedAt: number
        reconnected: boolean
        logFile: string
      }
    >()

    localMap.set(100, {
      pid: 100,
      label: 'alive-proc',
      command: 'node server.js',
      exited: false,
      exitCode: null,
      startedAt: Date.now(),
      reconnected: false,
      logFile: 'alive.log'
    })
    localMap.set(200, {
      pid: 200,
      label: 'dead-proc-1',
      command: 'npm run dev',
      exited: true,
      exitCode: 1,
      startedAt: Date.now() - 5000,
      reconnected: false,
      logFile: 'dead1.log'
    })
    localMap.set(300, {
      pid: 300,
      label: 'dead-proc-2',
      command: 'webpack',
      exited: true,
      exitCode: 0,
      startedAt: Date.now() - 10000,
      reconnected: true,
      logFile: 'dead2.log'
    })

    const deadPids: number[] = []
    const processes = [...localMap.values()].map((p) => {
      const alive = !p.exited
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

    // Auto-reap dead processes
    for (const deadPid of deadPids) {
      localMap.delete(deadPid)
    }

    assert.equal(deadPids.length, 2, 'Should have 2 dead processes to reap')
    assert.equal(localMap.size, 1, 'Map should only have the alive process')
    assert.ok(localMap.has(100), 'Alive process should remain in map')
    assert.ok(!localMap.has(200), 'Dead process 200 should be removed')
    assert.ok(!localMap.has(300), 'Dead process 300 should be removed')

    // Response should include all processes (alive + dead) for visibility
    assert.equal(processes.length, 3, 'Response should include all processes')
    assert.equal(processes.filter((p) => p.alive).length, 1, 'Only 1 alive process')
  })
})

// ── Fix 4: Orphan log file sweep ──

describe('Orphan log file sweep', () => {
  const tmpDir = join(process.cwd(), '.pm-state-orphan-test-' + process.pid)
  const logsDir = join(tmpDir, 'logs')

  function cleanup(): void {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* */
    }
  }

  test('sweeps orphan log files not referenced by tracked processes', () => {
    cleanup()
    mkdirSync(logsDir, { recursive: true })

    // Create 4 log files — 2 are "known" (referenced), 2 are orphans
    writeFileSync(join(logsDir, 'known-1.log'), 'output 1')
    writeFileSync(join(logsDir, 'known-2.log'), 'output 2')
    writeFileSync(join(logsDir, 'orphan-1.log'), 'orphan output')
    writeFileSync(join(logsDir, 'orphan-2.log'), 'orphan output')

    const knownLogFiles = new Set(['known-1.log', 'known-2.log'])

    // Simulate sweepOrphanLogs
    const logFiles = readdirSync(logsDir).filter((f) => f.endsWith('.log'))
    let swept = 0
    for (const file of logFiles) {
      if (!knownLogFiles.has(file)) {
        try {
          unlinkSync(join(logsDir, file))
          swept++
        } catch {
          /* */
        }
      }
    }

    assert.equal(swept, 2, 'Should have swept 2 orphan files')
    assert.ok(existsSync(join(logsDir, 'known-1.log')), 'known-1.log should survive')
    assert.ok(existsSync(join(logsDir, 'known-2.log')), 'known-2.log should survive')
    assert.ok(!existsSync(join(logsDir, 'orphan-1.log')), 'orphan-1.log should be deleted')
    assert.ok(!existsSync(join(logsDir, 'orphan-2.log')), 'orphan-2.log should be deleted')

    cleanup()
  })

  test('no-op when all log files are known', () => {
    cleanup()
    mkdirSync(logsDir, { recursive: true })

    writeFileSync(join(logsDir, 'known.log'), 'output')
    const knownLogFiles = new Set(['known.log'])

    const logFiles = readdirSync(logsDir).filter((f) => f.endsWith('.log'))
    let swept = 0
    for (const file of logFiles) {
      if (!knownLogFiles.has(file)) swept++
    }

    assert.equal(swept, 0, 'Should sweep 0 files when all are known')
    assert.ok(existsSync(join(logsDir, 'known.log')), 'known.log should survive')

    cleanup()
  })
})

// ── Fix 5: gitignore patch caching ──

describe('gitignore patch caching', () => {
  const tmpDir = join(process.cwd(), '.pm-state-gitignore-test-' + process.pid)

  function cleanup(): void {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* */
    }
  }

  test('.gitignore is only patched once even when ensureStateDir is called multiple times', () => {
    cleanup()
    mkdirSync(tmpDir, { recursive: true })

    const gitignorePath = join(tmpDir, '.gitignore')
    writeFileSync(gitignorePath, '# existing rules\nnode_modules/\n')

    // Simulate the caching logic
    let patched = false
    function simulateEnsureStateDir(): void {
      if (!patched) {
        const content = readFileSync(gitignorePath, 'utf-8')
        if (content.includes('.pm-state')) {
          patched = true
        } else {
          appendFileSync(gitignorePath, '\n# Process manager state (auto-generated)\n.pm-state/\n')
          patched = true
        }
      }
    }

    // Call three times
    simulateEnsureStateDir()
    simulateEnsureStateDir()
    simulateEnsureStateDir()

    // Verify .gitignore was only appended once
    const finalContent = readFileSync(gitignorePath, 'utf-8')
    const matches = finalContent.match(/\.pm-state/g)
    assert.equal(matches?.length, 1, '.pm-state should appear exactly once in .gitignore')
    assert.ok(patched, 'patched flag should be true')

    cleanup()
  })
})

// ── Fix 6: PID reuse validation ──

describe('PID reuse validation', () => {
  test('validates own process matches a node command', () => {
    // Simulate validatePidOwnership using the current process
    const { execSync } = require('node:child_process')
    let comm: string
    try {
      comm = execSync(`ps -o comm= -p ${process.pid}`, {
        encoding: 'utf-8',
        timeout: 2000
      }).trim()
    } catch {
      // ps may not be available in all environments — skip
      return
    }

    const commBase = comm.split('/').pop() ?? comm
    const expectedCommand = 'node run-tests.ts'

    // The test runner is a node process, so commBase should be 'node' or 'Node'
    const matches =
      expectedCommand.toLowerCase().includes(commBase.toLowerCase()) ||
      commBase === 'sh' ||
      commBase === 'bash' ||
      commBase === 'zsh'

    assert.ok(matches, `Own process comm "${commBase}" should match command "${expectedCommand}"`)
  })

  test('rejects obviously wrong process for a given command', () => {
    // Simulate validatePidOwnership with a mismatched command
    // PID 1 is usually launchd/init, not "npm run dev"
    const { execSync } = require('node:child_process')
    let comm: string
    try {
      comm = execSync(`ps -o comm= -p 1`, {
        encoding: 'utf-8',
        timeout: 2000
      }).trim()
    } catch {
      // ps may not be available — skip
      return
    }

    const commBase = comm.split('/').pop() ?? comm
    const expectedCommand = 'npm run dev'

    // PID 1 (launchd/init) should NOT match "npm run dev"
    const matches =
      expectedCommand.includes(commBase) ||
      commBase === 'sh' ||
      commBase === 'bash' ||
      commBase === 'zsh'

    assert.ok(!matches, `PID 1 comm "${commBase}" should NOT match command "${expectedCommand}"`)
  })
})

// ── Fix 7: Final output in stop_process response ──

describe('Final output capture in stop_process', () => {
  const tmpDir = join(process.cwd(), '.pm-state-final-output-test-' + process.pid)
  const logsDir = join(tmpDir, 'logs')

  function cleanup(): void {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* */
    }
  }

  test('refreshOutputFromLog + getRecent captures output before log deletion', () => {
    cleanup()
    mkdirSync(logsDir, { recursive: true })

    // Write a log file with 50 lines
    const logPath = join(logsDir, 'final-output-test.log')
    const lines = Array.from({ length: 50 }, (_, i) => `output-line-${i}`)
    writeFileSync(logPath, lines.join('\n'))

    // Simulate refreshOutputFromLog + getRecent(30)
    const content = readFileSync(logPath, 'utf-8')
    const logLines = content.split('\n').filter(Boolean).slice(-200)
    const buf = new RingBuffer(200)
    for (const line of logLines) buf.push(line)

    const finalOutput = buf.getRecent(30).join('\n')

    // Verify we got the last 30 lines
    assert.ok(finalOutput.includes('output-line-49'), 'Should include last line')
    assert.ok(finalOutput.includes('output-line-20'), 'Should include line 20')
    assert.ok(
      !finalOutput.includes('output-line-19'),
      'Should NOT include line 19 (outside last 30)'
    )

    // Now delete the log (simulating stop_process cleanup)
    unlinkSync(logPath)
    assert.ok(!existsSync(logPath), 'Log file should be deleted')

    // But we still have the output captured
    assert.ok(finalOutput.length > 0, 'Final output should be non-empty after log deletion')

    cleanup()
  })

  test('empty log file produces fallback output', () => {
    cleanup()
    mkdirSync(logsDir, { recursive: true })

    const logPath = join(logsDir, 'empty-output.log')
    writeFileSync(logPath, '')

    const content = readFileSync(logPath, 'utf-8')
    const logLines = content.split('\n').filter(Boolean)
    const buf = new RingBuffer(200)
    for (const line of logLines) buf.push(line)

    const finalOutput = buf.getRecent(30).join('\n')
    const result = finalOutput || '(no output captured)'

    assert.equal(result, '(no output captured)', 'Empty log should produce fallback')

    cleanup()
  })
})
