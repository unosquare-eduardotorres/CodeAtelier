/**
 * F1/F6 regression tests — the Blueprint Retry Deadlock incident (2026-08).
 *
 * A machine with no pytest on PATH failed ~20 consecutive BUILD retries
 * because the full-suite gate graded "command not found" as a red suite.
 * These tests pin the three fixes:
 *   - F1a: Python detection prefers the project's own venv interpreter, then
 *     uv, then `python -m`, and only falls back to bare `pytest` last.
 *   - F1c: a gate whose output shows the RUNNER was never executed is
 *     `unverifiable('command_missing')`, never `fail`.
 *   - F6: the IPC bridge skips the Unix socket probe on Windows.
 *
 * Run: tsx src/main/services/__tests__/gate-command-missing.test.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'

import { detectGateCommands, pythonRunnerPrefix, type WorkspaceManifests } from '../../../shared/gate-command-detect'
import { buildTestCommand } from '../../../shared/gate-test-targeting'
import {
  runWaveCommandGates,
  captureGateBaseline,
  defaultCommandRunner,
  type CommandRunner,
  type GateTaskContext
} from '../blueprint-gates.service'

// ── F1a: detectGateCommands Python preference chain ──

describe('detectGateCommands — Python test command preference chain (F1a)', () => {
  const PYPROJECT = '[project]\nname = "x"\n'

  test('venvPython wins over everything and is quoted when it has spaces', () => {
    const out = detectGateCommands({
      pyprojectToml: PYPROJECT,
      hasUvLock: true,
      venvPython: 'C:\\Users\\aldair garcia\\Documents\\Redshift_Agent\\.venv\\Scripts\\python.exe'
    })
    assert.equal(
      out.test?.command,
      '"C:\\Users\\aldair garcia\\Documents\\Redshift_Agent\\.venv\\Scripts\\python.exe" -m pytest'
    )
  })

  test('venvPython without spaces is not quoted', () => {
    const out = detectGateCommands({
      pyprojectToml: PYPROJECT,
      venvPython: '/home/user/proj/.venv/bin/python'
    })
    assert.equal(out.test?.command, '/home/user/proj/.venv/bin/python -m pytest')
  })

  test('uv.lock present (no venv) → uv run pytest', () => {
    const out = detectGateCommands({ pyprojectToml: PYPROJECT, hasUvLock: true })
    assert.equal(out.test?.command, 'uv run pytest')
  })

  test('[tool.uv] in pyproject (no lock, no venv) → uv run pytest', () => {
    const out = detectGateCommands({ pyprojectToml: `${PYPROJECT}[tool.uv]\n` })
    assert.equal(out.test?.command, 'uv run pytest')
  })

  test('pyproject without uv → python -m pytest', () => {
    const out = detectGateCommands({ pyprojectToml: PYPROJECT })
    assert.equal(out.test?.command, 'python -m pytest')
  })

  test('pytest config only (no pyproject) → bare pytest as last resort', () => {
    const out = detectGateCommands({ hasPytestConfig: true })
    assert.equal(out.test?.command, 'pytest')
  })

  test('a declared test command from package.json is never overridden by Python detection', () => {
    const out = detectGateCommands({
      packageJson: JSON.stringify({ scripts: { test: 'vitest run' } }),
      pyprojectToml: PYPROJECT,
      venvPython: '/x/.venv/bin/python'
    })
    assert.equal(out.test?.command, 'npm run test')
  })
})

// ── F1c: command_missing → unverifiable ──

/** A runner that answers every command from a scripted table. */
function scriptedRunner(script: Record<string, { exitCode: number; output: string[] }>): CommandRunner {
  return async (command) => {
    const entry = script[command]
    if (!entry) {
      return { exitCode: 0, output: [], timedOut: false, durationMs: 1 }
    }
    return { exitCode: entry.exitCode, output: entry.output, timedOut: false, durationMs: 1 }
  }
}

function waveCtx(runner: CommandRunner, testCommand: string): GateTaskContext {
  return {
    blueprintId: 'bp-1',
    taskId: 'W1',
    workspacePath: '/repo',
    executionPath: '/repo',
    plannedFiles: [],
    packet: null,
    commands: {
      test: { command: testCommand, provenance: 'detected' }
    },
    runner
  }
}

describe('runWaveCommandGates — missing runner is unverifiable, never fail (F1c)', () => {
  test('cmd.exe "is not recognized" → full-suite unverifiable(command_missing)', async () => {
    const report = await runWaveCommandGates(
      waveCtx(
        scriptedRunner({
          pytest: {
            exitCode: 1,
            output: ["'pytest' is not recognized as an internal or external command"]
          }
        }),
        'pytest'
      )
    )
    const fullSuite = report.gates.find((g) => g.name === 'full-suite')
    assert.ok(fullSuite, 'full-suite gate must have run')
    assert.equal(fullSuite.verdict, 'unverifiable')
    assert.equal(fullSuite.reason, 'command_missing')
    assert.ok(fullSuite.evidence.some((e) => e.includes('not recognized')))
    assert.equal(report.overall, 'unverifiable', 'a missing runner must not fail the wave')
  })

  test('sh "command not found" → unverifiable(command_missing)', async () => {
    const report = await runWaveCommandGates(
      waveCtx(
        scriptedRunner({
          'python -m pytest': { exitCode: 127, output: ['/bin/sh: pytest: command not found'] }
        }),
        'python -m pytest'
      )
    )
    const fullSuite = report.gates.find((g) => g.name === 'full-suite')
    assert.equal(fullSuite?.verdict, 'unverifiable')
    assert.equal(fullSuite?.reason, 'command_missing')
  })

  test('"No module named pytest" (python -m with runner absent) → unverifiable(command_missing)', async () => {
    const report = await runWaveCommandGates(
      waveCtx(
        scriptedRunner({
          'python -m pytest': { exitCode: 1, output: ['No module named pytest'] }
        }),
        'python -m pytest'
      )
    )
    const fullSuite = report.gates.find((g) => g.name === 'full-suite')
    assert.equal(fullSuite?.verdict, 'unverifiable')
    assert.equal(fullSuite?.reason, 'command_missing')
  })

  test('a genuinely red suite (assertion failures, runner present) still fails', async () => {
    const report = await runWaveCommandGates(
      waveCtx(
        scriptedRunner({
          'uv run pytest': {
            exitCode: 1,
            output: ['FAILED test_foo.py::test_bar - assert 1 == 2', '1 failed, 83 passed']
          }
        }),
        'uv run pytest'
      )
    )
    const fullSuite = report.gates.find((g) => g.name === 'full-suite')
    assert.equal(fullSuite?.verdict, 'fail', 'a red suite must stay a hard fail')
    assert.equal(report.overall, 'fail')
  })

  test('case-insensitive signature match ("IS NOT RECOGNIZED")', async () => {
    const report = await runWaveCommandGates(
      waveCtx(
        scriptedRunner({
          ruff: { exitCode: 1, output: ['RUFF IS NOT RECOGNIZED AS A COMMAND'] }
        }),
        'ruff'
      )
    )
    const fullSuite = report.gates.find((g) => g.name === 'full-suite')
    assert.equal(fullSuite?.verdict, 'unverifiable')
    assert.equal(fullSuite?.reason, 'command_missing')
  })
})

// ── Gap 2: the signature scan is limited to the first 2 output lines ──

describe('isCommandMissing — only the first 2 output lines are scanned (Gap 2)', () => {
  test('a red suite whose assertion text quotes "command not found" in a LATER line still fails', async () => {
    const report = await runWaveCommandGates(
      waveCtx(
        scriptedRunner({
          'uv run pytest': {
            exitCode: 1,
            output: [
              '============================= test session starts =============================',
              'platform win32 -- Python 3.12.13, pytest-9.1.1',
              "FAILED tests/test_cli.py::test_spawn - AssertionError: stderr was 'foo: command not found'",
              '1 failed, 83 passed'
            ]
          }
        }),
        'uv run pytest'
      )
    )
    const fullSuite = report.gates.find((g) => g.name === 'full-suite')
    assert.equal(fullSuite?.verdict, 'fail', 'a real regression must not fail open as unverifiable')
    assert.equal(report.overall, 'fail')
  })

  test('signature in line 2 (after a banner line) still grades unverifiable(command_missing)', async () => {
    const report = await runWaveCommandGates(
      waveCtx(
        scriptedRunner({
          pytest: {
            exitCode: 1,
            output: [
              'Windows PowerShell warning: profile load skipped',
              "'pytest' is not recognized as an internal or external command"
            ]
          }
        }),
        'pytest'
      )
    )
    const fullSuite = report.gates.find((g) => g.name === 'full-suite')
    assert.equal(fullSuite?.verdict, 'unverifiable')
    assert.equal(fullSuite?.reason, 'command_missing')
  })
})

// ── Gap 1: the per-task template reuses the environment-aware Python runner ──

describe('pythonRunnerPrefix → buildTestCommand — per-task pytest template (Gap 1)', () => {
  test('venv interpreter prefix flows into the per-task template', () => {
    const manifests: WorkspaceManifests = {
      pyprojectToml: '[project]\nname = "x"\n',
      venvPython: 'C:\\Users\\aldair.garcia\\Documents\\Redshift_Agent\\.venv\\Scripts\\python.exe'
    }
    const prefix = pythonRunnerPrefix(manifests)
    assert.equal(
      prefix,
      'C:\\Users\\aldair.garcia\\Documents\\Redshift_Agent\\.venv\\Scripts\\python.exe -m'
    )
    assert.equal(
      buildTestCommand('pytest', ['tests/test_feature.py'], prefix),
      'C:\\Users\\aldair.garcia\\Documents\\Redshift_Agent\\.venv\\Scripts\\python.exe -m pytest tests/test_feature.py'
    )
  })

  test('uv-managed project → "uv run pytest <files>"', () => {
    const manifests: WorkspaceManifests = {
      pyprojectToml: '[project]\nname = "x"\n',
      hasUvLock: true
    }
    assert.equal(
      buildTestCommand('pytest', ['tests/a.py'], pythonRunnerPrefix(manifests)),
      'uv run pytest tests/a.py'
    )
  })

  test('default prefix (manifests absent at the call-site) stays bare pytest', () => {
    assert.equal(buildTestCommand('pytest', ['tests/a.py']), 'pytest tests/a.py')
    assert.equal(buildTestCommand('pytest', ['tests/a.py'], ''), 'pytest tests/a.py')
  })
})

const GIT_AVAILABLE = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** A runner that records every command it is asked to execute. */
function recordingRunner(seen: string[]): CommandRunner {
  return async (command, opts) => {
    seen.push(command)
    if (command.startsWith('git ')) return defaultCommandRunner(command, opts)
    return { exitCode: 0, output: ['1 passed'], timedOut: false, durationMs: 1 }
  }
}

describe('taskTestCommand wiring — manifests drive the per-task runner prefix (Gap 1)', () => {
  function pyCtx(dir: string, manifests: WorkspaceManifests | undefined, seen: string[]): GateTaskContext {
    return {
      blueprintId: 'bp-1',
      taskId: 'T001',
      workspacePath: dir,
      executionPath: dir,
      plannedFiles: [],
      packet: { allowedFiles: ['src/feature.py'], testFiles: ['tests/test_feature.py'] },
      commands: {},
      manifests,
      runner: recordingRunner(seen)
    }
  }

  test('venvPython in manifests → the gate engine runs "<venv> -m pytest <files>"', async () => {
    if (!GIT_AVAILABLE) return
    const dir = mkdtempSync(join(tmpdir(), 'gate-gap1-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      mkdirSync(join(dir, 'tests'), { recursive: true })
      writeFileSync(join(dir, 'tests/test_feature.py'), 'def test_feature():\n    assert True\n')
      execFileSync('git', ['add', '-A'], { cwd: dir })
      execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })

      const seen: string[] = []
      await captureGateBaseline(pyCtx(dir, {
        pyprojectToml: '[project]\nname = "x"\ndependencies = ["pytest"]\n',
        venvPython: 'C:\\Users\\aldair.garcia\\Documents\\Redshift_Agent\\.venv\\Scripts\\python.exe'
      }, seen))

      assert.ok(
        seen.includes(
          'C:\\Users\\aldair.garcia\\Documents\\Redshift_Agent\\.venv\\Scripts\\python.exe -m pytest tests/test_feature.py'
        ),
        `expected the venv-prefixed per-task template, saw: ${seen.join(' | ')}`
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('pytest config only (no venv, no uv) → bare pytest template', async () => {
    if (!GIT_AVAILABLE) return
    const dir = mkdtempSync(join(tmpdir(), 'gate-gap1-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      mkdirSync(join(dir, 'tests'), { recursive: true })
      writeFileSync(join(dir, 'tests/test_feature.py'), 'def test_feature():\n    assert True\n')
      execFileSync('git', ['add', '-A'], { cwd: dir })
      execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })

      const seen: string[] = []
      await captureGateBaseline(pyCtx(dir, { hasPytestConfig: true }, seen))

      assert.ok(
        seen.includes('pytest tests/test_feature.py'),
        `expected the bare per-task template, saw: ${seen.join(' | ')}`
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── F6: win32 skips the Unix socket probe ──

describe('IpcBridge — Windows skips the Unix socket probe (F6)', () => {
  test('start() on win32 goes straight to TCP loopback', async () => {
    const originalPlatform = process.platform
    let tcpAttempted = false
    // Minimal duck-typed bridge instance: we only need start()'s branch logic,
    // so stub the private helpers via the prototype and a bare object.
    const { IpcBridge } = await import('../ipc-bridge')
    const bridge = Object.create(IpcBridge.prototype) as InstanceType<typeof IpcBridge>
    ;(bridge as unknown as Record<string, unknown>).listenOnTcp = async (): Promise<number> => {
      tcpAttempted = true
      return 45678
    }
    ;(bridge as unknown as Record<string, unknown>).startHeartbeat = (): void => {}
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const addr = await bridge.start()
      assert.equal(tcpAttempted, true, 'TCP must be attempted directly on win32')
      assert.equal(addr, 'tcp:127.0.0.1:45678')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
