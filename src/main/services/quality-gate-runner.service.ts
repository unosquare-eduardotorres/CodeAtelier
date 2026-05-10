import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import log from 'electron-log/main'
import type { QualityGateResult } from './abandonment-detector.service'

const gateLog = log.scope('QualityGateRunner')

/** Timeout per gate execution (2 minutes) */
const GATE_TIMEOUT_MS = 120_000

/** Gate definition — what command to run, how to interpret results */
interface GateDefinition {
  type: QualityGateResult['type']
  /** npm script name to detect in package.json (e.g. "test", "lint") */
  scriptName: string
  /** Fallback command + args if no package.json script exists */
  fallbackCommand: string
  fallbackArgs: string[]
  /** npm run script command */
  npmArgs: string[]
}

/**
 * Ordered list of quality gates to run after specialist completion.
 * Each gate auto-detects from package.json, with fallback to standard tools.
 */
const GATE_DEFINITIONS: GateDefinition[] = [
  {
    type: 'typecheck',
    scriptName: 'typecheck',
    fallbackCommand: 'npx',
    fallbackArgs: ['tsc', '--noEmit'],
    npmArgs: ['run', 'typecheck']
  },
  {
    type: 'lint',
    scriptName: 'lint',
    fallbackCommand: 'npx',
    fallbackArgs: ['eslint', '.'],
    npmArgs: ['run', 'lint']
  },
  {
    type: 'test',
    scriptName: 'test',
    fallbackCommand: 'npx',
    fallbackArgs: ['jest', '--passWithNoTests'],
    npmArgs: ['run', 'test']
  }
]

/** Parsed gate definition with actual command/args */
interface ResolvedGate {
  type: QualityGateResult['type']
  command: string
  args: string[]
}

/** Result from running all gates */
export interface GateRunResult {
  gates: QualityGateResult[]
  /** Whether all gates passed */
  allPassed: boolean
  /** Combined failure summary for injection into retry context */
  failureSummary: string
}

/**
 * Runs explicit quality gate commands (typecheck, lint, test) as child processes
 * after a specialist completes. Returns structured results that drive the task loop.
 *
 * Auto-detects available gates from package.json scripts.
 */
class QualityGateRunnerService {
  /**
   * Run all available quality gates in the given working directory.
   * Gates are executed sequentially (typecheck → lint → test) and short-circuit
   * on first failure if `failFast` is true.
   */
  async runGates(
    cwd: string,
    opts: { failFast?: boolean; taskId?: string; agentId?: string } = {}
  ): Promise<GateRunResult> {
    const resolvedGates = await this.resolveGates(cwd)
    const results: QualityGateResult[] = []
    const failures: string[] = []

    for (const gate of resolvedGates) {
      gateLog.info(
        `Running ${gate.type} gate for ${opts.agentId ?? 'unknown'}/${opts.taskId ?? 'unknown'}: ${gate.command} ${gate.args.join(' ')}`
      )

      const result = await this.executeGate(gate, cwd)
      results.push(result)

      if (!result.passed) {
        failures.push(`[${result.type}] ${result.summary}`)
        gateLog.warn(
          `Gate FAILED: ${result.type} — ${result.summary} (task: ${opts.taskId ?? 'unknown'})`
        )
        if (opts.failFast) break
      } else {
        gateLog.info(`Gate PASSED: ${result.type} (task: ${opts.taskId ?? 'unknown'})`)
      }
    }

    return {
      gates: results,
      allPassed: failures.length === 0,
      failureSummary: failures.length > 0 ? `Quality gate failures:\n${failures.join('\n')}` : ''
    }
  }

  /**
   * Detect which gates are available by inspecting package.json scripts.
   */
  private async resolveGates(cwd: string): Promise<ResolvedGate[]> {
    const resolved: ResolvedGate[] = []

    let scripts: Record<string, string> = {}
    try {
      const pkgJson = await readFile(join(cwd, 'package.json'), 'utf-8')
      const pkg = JSON.parse(pkgJson) as { scripts?: Record<string, string> }
      scripts = pkg.scripts ?? {}
    } catch {
      gateLog.debug(`No package.json found in ${cwd}, using fallback gate commands`)
    }

    for (const def of GATE_DEFINITIONS) {
      // Check if a matching script exists in package.json
      if (scripts[def.scriptName]) {
        resolved.push({
          type: def.type,
          command: 'npm',
          args: def.npmArgs
        })
      } else {
        // Check alternative script names
        const altName = this.getAlternativeScriptNames(def.type, scripts)
        if (altName) {
          resolved.push({
            type: def.type,
            command: 'npm',
            args: ['run', altName]
          })
        }
        // For typecheck, always try tsc fallback since it's common in TS projects
        else if (def.type === 'typecheck') {
          resolved.push({
            type: def.type,
            command: def.fallbackCommand,
            args: def.fallbackArgs
          })
        }
        // Skip lint/test if no script found — don't want false failures
      }
    }

    return resolved
  }

  /**
   * Check for alternative script names (e.g., "type-check", "check-types", "lint:fix")
   */
  private getAlternativeScriptNames(
    type: QualityGateResult['type'],
    scripts: Record<string, string>
  ): string | null {
    const alternatives: Record<string, string[]> = {
      typecheck: ['type-check', 'check-types', 'tsc', 'types'],
      lint: ['lint:check', 'eslint'],
      test: ['test:unit', 'test:run', 'jest']
    }

    const alts = alternatives[type] ?? []
    for (const alt of alts) {
      if (scripts[alt]) return alt
    }
    return null
  }

  /**
   * Execute a single gate command and return a structured result.
   */
  private executeGate(gate: ResolvedGate, cwd: string): Promise<QualityGateResult> {
    return new Promise((resolve) => {
      try {
        const proc = execFile(
          gate.command,
          gate.args,
          {
            cwd,
            timeout: GATE_TIMEOUT_MS,
            maxBuffer: 2 * 1024 * 1024, // 2MB output buffer
            env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
            shell: process.platform === 'win32' // npx needs shell on Windows
          },
          (error, stdout, stderr) => {
            if (error) {
              // Process exited with non-zero or timed out
              const output = (stdout || '') + (stderr || '')
              const summary = this.extractErrorSummary(
                gate.type,
                output,
                typeof error.code === 'number' ? error.code : undefined
              )
              resolve({
                type: gate.type,
                passed: false,
                summary
              })
            } else {
              resolve({
                type: gate.type,
                passed: true,
                summary: `${gate.type} passed`
              })
            }
          }
        )

        // Safety: kill if proc reference leaks
        proc.unref?.()
      } catch (err) {
        gateLog.error(`Failed to spawn gate ${gate.type}:`, err)
        resolve({
          type: gate.type,
          passed: false,
          summary: `Failed to execute ${gate.type}: ${(err as Error).message}`
        })
      }
    })
  }

  /**
   * Extract a meaningful error summary from gate command output.
   * Caps at 500 chars to keep context manageable for task loop injection.
   */
  private extractErrorSummary(
    type: QualityGateResult['type'],
    output: string,
    exitCode?: number
  ): string {
    const tail = output.slice(-2000)
    const lines = tail.split('\n').filter((l) => l.trim())
    const lastLines = lines.slice(-10).join('\n')

    switch (type) {
      case 'typecheck': {
        const errorMatch = tail.match(/Found (\d+) error/i)
        const count = errorMatch ? errorMatch[1] : 'unknown'
        return `TypeScript: ${count} error(s). ${lastLines.slice(0, 400)}`
      }
      case 'lint': {
        const problemMatch = tail.match(/(\d+)\s+(?:problem|error)/i)
        const count = problemMatch ? problemMatch[1] : 'unknown'
        return `Lint: ${count} issue(s). ${lastLines.slice(0, 400)}`
      }
      case 'test': {
        const failMatch = tail.match(/(\d+)\s+(?:fail|failed)/i)
        const count = failMatch ? failMatch[1] : 'unknown'
        return `Tests: ${count} failure(s). ${lastLines.slice(0, 400)}`
      }
      case 'build': {
        return `Build failed (exit ${exitCode}). ${lastLines.slice(0, 400)}`
      }
      default:
        return `${type} failed (exit ${exitCode}). ${lastLines.slice(0, 400)}`
    }
  }
}

export const qualityGateRunnerService = new QualityGateRunnerService()
