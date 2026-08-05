#!/usr/bin/env node
/**
 * Code Analysis MCP Server — externalized for CLI interactive mode.
 *
 * Exposes: analyze_complexity, analyze_dependencies, analyze_test_coverage,
 *          find_code_smells, suggest_refactoring, resolve_library_id,
 *          query_library_docs, eslint_check, eslint_fix, eslint_rules
 *
 * Environment variables:
 *   WORKSPACE_PATH    — Absolute workspace path
 *   WORKSPACE_ID      — Workspace UUID (for DB-backed features)
 *   DB_PATH           — SQLite database directory
 *   CONTEXT7_API_KEY  — Optional Context7 API key for library doc fallback
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { execSync } from 'node:child_process'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { truncateToolOutput } from './output-cap'
import { LibraryDocService } from '../services/library-doc.service'

const WORKSPACE_PATH = process.env.WORKSPACE_PATH ?? process.cwd()
const WORKSPACE_ID = process.env.WORKSPACE_ID ?? ''
const CONTEXT7_API_KEY = process.env.CONTEXT7_API_KEY ?? ''

// ── ESLint strategy resolution (memoized) ──
//
// Three config strategies, resolved once per session:
//   'flat'   — workspace has eslint.config.(js|mjs|cjs|ts) → run normally
//   'legacy' — workspace has only .eslintrc.* → run with ESLINT_USE_FLAT_CONFIG=false
//   'fallback' — no config at all → provision a minimal flat config in os.tmpdir()
//   null     — ESLint binary not available at all

type EslintStrategy = 'flat' | 'legacy' | 'fallback' | null

let eslintStrategy: EslintStrategy | undefined // undefined = not yet resolved
let fallbackConfigPath: string | null = null

/** Detect which ESLint config strategy to use for this workspace. */
function resolveEslintStrategy(): EslintStrategy {
  if (eslintStrategy !== undefined) return eslintStrategy

  // 1. Check ESLint binary availability (--no-install prevents silent download)
  let hasEslint = false
  try {
    execSync('npx --no-install eslint --version', {
      cwd: WORKSPACE_PATH,
      timeout: 15_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    hasEslint = true
  } catch {
    // npx --no-install failed — try explicit versioned install into cache
    try {
      execSync('npx --yes eslint@9 --version', {
        cwd: WORKSPACE_PATH,
        timeout: 30_000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      })
      hasEslint = true
    } catch {
      // ESLint truly unavailable
    }
  }

  if (!hasEslint) {
    eslintStrategy = null
    return eslintStrategy
  }

  // 2. Detect workspace config type
  const flatConfigFiles = [
    'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts'
  ]
  const legacyConfigFiles = [
    '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'
  ]

  const hasFlatConfig = flatConfigFiles.some(f => existsSync(join(WORKSPACE_PATH, f)))
  if (hasFlatConfig) {
    eslintStrategy = 'flat'
    return eslintStrategy
  }

  const hasLegacyConfig = legacyConfigFiles.some(f => existsSync(join(WORKSPACE_PATH, f)))
  if (hasLegacyConfig) {
    eslintStrategy = 'legacy'
    return eslintStrategy
  }

  // 3. No config at all — provision a minimal flat config in tmpdir
  eslintStrategy = 'fallback'
  return eslintStrategy
}

/** Get (or lazily create) the fallback ESLint config path. */
function getFallbackConfigPath(): string {
  if (fallbackConfigPath) return fallbackConfigPath
  const dir = join(tmpdir(), 'agentstudio-eslint-fallback')
  mkdirSync(dir, { recursive: true })
  fallbackConfigPath = join(dir, 'eslint-fallback.config.mjs')
  writeFileSync(
    fallbackConfigPath,
    [
      '// Auto-generated minimal ESLint config for workspaces without their own.',
      '// Only enables the rules layered via --rule flags (e.g. complexity).',
      '// TS files require @typescript-eslint/parser in the workspace to parse.',
      "export default [{ files: ['**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}'], rules: {} }]",
      ''
    ].join('\n'),
    'utf-8'
  )
  return fallbackConfigPath
}

/** Back-compat wrapper — returns true when any ESLint strategy is usable. */
function checkEslintAvailable(): boolean {
  return resolveEslintStrategy() !== null
}

// Service instance — standalone (no Electron) so we instantiate directly
const libraryDocService = new LibraryDocService()

const server = new McpServer(
  { name: 'code-analysis', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

// ── Complexity Analysis ──

interface ComplexityResult {
  file: string
  function: string
  line: number
  column: number
  complexity: number
}

/**
 * Parse ESLint complexity rule messages to extract function name and score.
 * ESLint messages follow patterns like:
 *   "Arrow function has a complexity of 15. Maximum allowed is 0."
 *   "Function 'handleRequest' has a complexity of 8. Maximum allowed is 0."
 *   "Method 'render' has a complexity of 12. Maximum allowed is 0."
 */
export function parseComplexityMessage(
  msg: { message: string; line: number; column: number; ruleId: string | null },
  filePath: string
): ComplexityResult | null {
  if (msg.ruleId !== 'complexity') return null
  const scoreMatch = msg.message.match(/complexity of (\d+)/)
  if (!scoreMatch) return null
  const complexity = parseInt(scoreMatch[1], 10)

  // Extract function name — patterns: "Function 'name'", "Method 'name'", "Arrow function"
  const nameMatch = msg.message.match(/(?:Function|Method)\s+'([^']+)'/)
  const funcName = nameMatch ? nameMatch[1] : 'anonymous'

  return { file: filePath, function: funcName, line: msg.line, column: msg.column, complexity }
}

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'])

async function handleAnalyzeComplexity(args: {
  path: string
  threshold: number
  maxResults: number
}): Promise<{ isError?: boolean; content: Array<{ type: 'text'; text: string }> }> {
  const targetPath = sanitizePath(args.path)

  // Check for non-JS/TS files (single file mode)
  if (targetPath.includes('.')) {
    const ext = '.' + targetPath.split('.').pop()!.toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `[analyze_complexity] Language not supported: ${ext}\nCurrently supports: ${[...SUPPORTED_EXTENSIONS].join(', ')}\n\nFuture: tree-sitter based analysis for Python, Rust, Go, etc.`
          }
        ]
      }
    }
  }

  if (!checkEslintAvailable()) {
    return {
      content: [{
        type: 'text' as const,
        text: `[analyze_complexity] ESLint not available via npx. Complexity analysis requires ESLint.`
      }]
    }
  }

  try {
    // Run ESLint with complexity rule at max:0 to report ALL functions
    const { stdout } = runEslint(
      ['--format', 'json', '--rule', `'{"complexity": ["warn", {"max": 0}]}'`, quotePaths([targetPath])],
      WORKSPACE_PATH
    )

    const diagnostics: EslintDiagnostic[] = JSON.parse(stdout)
    const results: ComplexityResult[] = []

    for (const diag of diagnostics) {
      for (const msg of diag.messages) {
        const parsed = parseComplexityMessage(msg, diag.filePath)
        if (parsed && parsed.complexity >= args.threshold) {
          results.push(parsed)
        }
      }
    }

    // Sort by complexity descending
    results.sort((a, b) => b.complexity - a.complexity)
    const capped = results.slice(0, args.maxResults)

    // Build output
    const lines: string[] = [
      `## Cyclomatic Complexity Analysis`,
      ``,
      `**Path:** ${args.path}`,
      `**Threshold:** ${args.threshold}`,
      `**Functions above threshold:** ${results.length}`,
      ``
    ]

    if (capped.length === 0) {
      lines.push(`✅ No functions exceed complexity ${args.threshold}.`)
    } else {
      lines.push('| Complexity | Function | File | Line |')
      lines.push('|------------|----------|------|------|')
      for (const r of capped) {
        const flag = r.complexity > 20 ? '🔴' : r.complexity > 10 ? '🟡' : '🔵'
        const relFile = r.file.replace(WORKSPACE_PATH + '/', '')
        lines.push(`| ${flag} ${r.complexity} | ${r.function} | ${relFile} | ${r.line} |`)
      }

      if (results.length > args.maxResults) {
        lines.push(``, `_...and ${results.length - args.maxResults} more above threshold_`)
      }

      // Summary stats
      const avg = results.reduce((s, r) => s + r.complexity, 0) / results.length
      lines.push(
        ``,
        `**Summary:** avg=${avg.toFixed(1)}, max=${results[0].complexity}, total=${results.length} functions above threshold`
      )
    }

    return {
      content: [{ type: 'text' as const, text: truncateToolOutput(lines.join('\n'), 15_000) }]
    }
  } catch (err) {
    // Graceful degradation for config errors — non-alarming message
    if (err instanceof EslintConfigError) {
      return {
        content: [{
          type: 'text' as const,
          text: `[analyze_complexity] ⚠️ ${err.message}`
        }]
      }
    }
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `[analyze_complexity] Error: ${err instanceof Error ? err.message : String(err)}`
        }
      ]
    }
  }
}

async function registerTools(): Promise<void> {
  server.tool(
    'analyze_complexity',
    'Cyclomatic complexity analysis for JS/TS files.',
    {
      path: z.string().describe('File or directory path to analyze (relative to workspace root)'),
      threshold: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(5)
        .describe('Report functions with cyclomatic complexity >= this value (default: 5)'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe('Maximum functions to return (default: 50)')
    },
    handleAnalyzeComplexity
  )

  server.tool(
    'analyze_dependencies',
    'Analyze dependency structure for a file or module.',
    {
      path: z.string().describe('File or directory path to analyze')
    },
    async (args) => {
      return {
        content: [
          {
            type: 'text' as const,
            text: `[analyze_dependencies] path=${args.path} — delegating to in-process service`
          }
        ]
      }
    }
  )

  server.tool(
    'analyze_test_coverage',
    'Find files that lack corresponding test files.',
    {
      path: z.string().optional().describe('Directory to scan (default: entire workspace)'),
      testPattern: z.string().optional().describe('Test file pattern (default: **/*.test.ts)')
    },
    async (args) => {
      return {
        content: [
          {
            type: 'text' as const,
            text: `[analyze_test_coverage] path=${args.path ?? 'all'} — delegating to in-process service`
          }
        ]
      }
    }
  )

  server.tool(
    'find_code_smells',
    'Detect common code quality issues in a file or directory.',
    {
      path: z.string().describe('File or directory to analyze'),
      maxResults: z.number().int().min(1).max(500).optional().default(20)
    },
    async (args) => {
      return {
        content: [
          {
            type: 'text' as const,
            text: `[find_code_smells] path=${args.path} max=${args.maxResults} — delegating to in-process service`
          }
        ]
      }
    }
  )

  server.tool(
    'suggest_refactoring',
    'Suggest refactoring opportunities for a file based on complexity and coupling analysis.',
    {
      filePath: z.string().describe('File to analyze for refactoring')
    },
    async (args) => {
      return {
        content: [
          {
            type: 'text' as const,
            text: `[suggest_refactoring] file=${args.filePath} — delegating to in-process service`
          }
        ]
      }
    }
  )

  // ── Library Documentation Tools ──

  server.tool(
    'resolve_library_id',
    'Search for a library by name. Checks local cache first, then Context7, then npm registry. Returns available packages and their doc coverage.',
    {
      libraryName: z.string().describe('Package name (e.g. "zod", "electron", "react")'),
      query: z.string().optional().describe('What you need — improves ranking')
    },
    async (args) => {
      if (!WORKSPACE_ID) {
        return {
          content: [
            {
              type: 'text' as const,
              text: '[resolve_library_id] WORKSPACE_ID not set — cannot access library doc cache'
            }
          ]
        }
      }
      try {
        const results = await libraryDocService.resolveLibrary(
          WORKSPACE_ID,
          WORKSPACE_PATH,
          args.libraryName,
          CONTEXT7_API_KEY || undefined,
          args.query
        )
        return {
          content: [
            {
              type: 'text' as const,
              text: truncateToolOutput(
                JSON.stringify({ matches: results, count: results.length }),
                15_000
              )
            }
          ]
        }
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `[resolve_library_id] Error: ${err instanceof Error ? err.message : String(err)}`
            }
          ]
        }
      }
    }
  )

  server.tool(
    'query_library_docs',
    'Get documentation for a library. Returns relevant sections matched by full-text search. Falls back through local cache → Context7 → npm registry.',
    {
      packageName: z.string().describe('Package name (exact match)'),
      query: z.string().describe('Specific question or topic to search for'),
      maxSections: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(5)
        .describe('Max doc sections to return')
    },
    async (args) => {
      if (!WORKSPACE_ID) {
        return {
          content: [
            {
              type: 'text' as const,
              text: '[query_library_docs] WORKSPACE_ID not set — cannot access library doc cache'
            }
          ]
        }
      }
      try {
        const result = await libraryDocService.queryDocs(
          WORKSPACE_ID,
          WORKSPACE_PATH,
          args.packageName,
          args.query,
          CONTEXT7_API_KEY || undefined,
          args.maxSections
        )
        return {
          content: [
            {
              type: 'text' as const,
              text: truncateToolOutput(JSON.stringify(result), 15_000)
            }
          ]
        }
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `[query_library_docs] Error: ${err instanceof Error ? err.message : String(err)}`
            }
          ]
        }
      }
    }
  )
}

// ── ESLint helpers ────────────────────────────────────────────────────

interface EslintDiagnostic {
  filePath: string
  messages: Array<{
    ruleId: string | null
    severity: number
    message: string
    line: number
    column: number
  }>
  errorCount: number
  warningCount: number
  fixableErrorCount: number
  fixableWarningCount: number
}

/** Reject paths with shell metacharacters to prevent injection via execSync */
function sanitizePath(p: string): string {
  if (/["'`$\\;|&(){}]/.test(p)) {
    throw new Error(`Path contains unsafe characters: ${p.slice(0, 80)}`)
  }
  return p
}

/** Build the ESLint CLI prefix and env overrides for the current strategy. */
function buildEslintCommand(
  args: string[],
  strategy: 'flat' | 'legacy' | 'fallback'
): { command: string; env: Record<string, string> } {
  const env: Record<string, string> = {}
  const prefix = 'npx eslint'
  let extraArgs = ''

  if (strategy === 'legacy') {
    env.ESLINT_USE_FLAT_CONFIG = 'false'
  } else if (strategy === 'fallback') {
    const cfgPath = getFallbackConfigPath()
    extraArgs = `--no-config-lookup --config "${cfgPath}"`
  }
  // 'flat' — no extra flags, workspace config is used as-is

  const fullArgs = extraArgs ? `${extraArgs} ${args.join(' ')}` : args.join(' ')
  return { command: `${prefix} ${fullArgs}`, env }
}

/**
 * Config-error patterns that indicate a missing/incompatible ESLint config.
 * When matched, runEslint retries with the next strategy before giving up.
 */
const CONFIG_ERROR_PATTERNS = [
  "couldn't find an eslint.config",
  'No ESLint configuration found',
  'eslint.config',
  'no matching configuration'
]

function isConfigError(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return CONFIG_ERROR_PATTERNS.some(p => lower.includes(p.toLowerCase()))
}

/** Strategy fallback order: flat → legacy → fallback */
const STRATEGY_FALLBACK: Record<string, 'legacy' | 'fallback' | null> = {
  flat: 'legacy',
  legacy: 'fallback',
  fallback: null
}

function runEslint(args: string[], cwd: string): { stdout: string; exitCode: number } {
  const strategy = resolveEslintStrategy()
  if (!strategy) {
    throw new Error('ESLint not found. Analysis requires ESLint to be available via npx.')
  }
  return _runEslintWithStrategy(args, cwd, strategy)
}

function _runEslintWithStrategy(
  args: string[],
  cwd: string,
  strategy: 'flat' | 'legacy' | 'fallback'
): { stdout: string; exitCode: number } {
  const { command, env: extraEnv } = buildEslintCommand(args, strategy)
  try {
    const stdout = execSync(command, {
      cwd,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv }
    })
    return { stdout, exitCode: 0 }
  } catch (err: unknown) {
    const execErr = err as { status?: number; stdout?: string; stderr?: string }
    // Exit 1 = lint errors found (not a crash). Exit 2 = fatal config/parse error.
    if (execErr.status === 1 && execErr.stdout) {
      return { stdout: execErr.stdout, exitCode: 1 }
    }
    if (execErr.status === 2) {
      const stderr = String(execErr.stderr || execErr.stdout || '')
      // Config error — retry with next strategy before giving up
      if (isConfigError(stderr)) {
        const next = STRATEGY_FALLBACK[strategy]
        if (next) {
          return _runEslintWithStrategy(args, cwd, next)
        }
        // All strategies exhausted — throw graceful degradation error
        throw new EslintConfigError(
          `ESLint analysis skipped — no usable ESLint config in this workspace. ` +
          `Tried strategies: flat, legacy, fallback. Last error: ${stderr.slice(0, 300)}`
        )
      }
      throw new Error(`ESLint fatal: ${stderr.slice(0, 500)}`)
    }
    // ESLint not found or other spawn errors
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('ENOENT') || message.includes('not found')) {
      throw new Error('ESLint not found in workspace. Ensure eslint is available via npx.')
    }
    throw err
  }
}

/** Sentinel error class for config-related failures (enables graceful degradation). */
class EslintConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EslintConfigError'
  }
}

function getGitChangedFiles(cwd: string): string[] {
  try {
    const diffOutput = execSync('git diff --name-only HEAD', {
      cwd,
      timeout: 10_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    // Also include staged files
    const stagedOutput = execSync('git diff --name-only --cached', {
      cwd,
      timeout: 10_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const allFiles = `${diffOutput}\n${stagedOutput}`
    const unique = [...new Set(
      allFiles.split('\n')
        .map(f => f.trim())
        .filter(f => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f))
    )]
    return unique
  } catch {
    return []
  }
}

function summarizeDiagnostics(diagnostics: EslintDiagnostic[]): string {
  const totalErrors = diagnostics.reduce((s, d) => s + d.errorCount, 0)
  const totalWarnings = diagnostics.reduce((s, d) => s + d.warningCount, 0)
  const filesWithIssues = diagnostics.filter(d => d.errorCount + d.warningCount > 0)

  const lines: string[] = [
    `## ESLint Results`,
    ``,
    `**${diagnostics.length}** files checked · **${totalErrors}** errors · **${totalWarnings}** warnings`,
    ``
  ]

  if (filesWithIssues.length === 0) {
    lines.push('✅ All files pass — zero errors, zero warnings.')
    return lines.join('\n')
  }

  // Aggregate by rule
  const ruleCounts = new Map<string, { errors: number; warnings: number }>()
  for (const file of filesWithIssues) {
    for (const msg of file.messages) {
      const rule = msg.ruleId ?? '(unknown)'
      const entry = ruleCounts.get(rule) ?? { errors: 0, warnings: 0 }
      if (msg.severity === 2) entry.errors++
      else entry.warnings++
      ruleCounts.set(rule, entry)
    }
  }

  // Top 10 rules by total count
  const topRules = [...ruleCounts.entries()]
    .sort((a, b) => (b[1].errors + b[1].warnings) - (a[1].errors + a[1].warnings))
    .slice(0, 10)

  lines.push('### Top Issues by Rule')
  lines.push('')
  lines.push('| Rule | Errors | Warnings |')
  lines.push('|------|--------|----------|')
  for (const [rule, counts] of topRules) {
    lines.push(`| ${rule} | ${counts.errors} | ${counts.warnings} |`)
  }

  // Files with errors (up to 15)
  const errorFiles = filesWithIssues
    .filter(f => f.errorCount > 0)
    .sort((a, b) => b.errorCount - a.errorCount)
    .slice(0, 15)

  if (errorFiles.length > 0) {
    lines.push('')
    lines.push('### Files with Errors')
    lines.push('')
    for (const f of errorFiles) {
      lines.push(`- **${f.filePath}** — ${f.errorCount} errors, ${f.warningCount} warnings`)
    }
  }

  return lines.join('\n')
}

function formatFullDiagnostics(diagnostics: EslintDiagnostic[]): string {
  const filesWithIssues = diagnostics.filter(d => d.errorCount + d.warningCount > 0)
  const totalErrors = diagnostics.reduce((s, d) => s + d.errorCount, 0)
  const totalWarnings = diagnostics.reduce((s, d) => s + d.warningCount, 0)

  const lines: string[] = [
    `## ESLint Results (Full)`,
    ``,
    `**${diagnostics.length}** files checked · **${totalErrors}** errors · **${totalWarnings}** warnings`,
    ``
  ]

  if (filesWithIssues.length === 0) {
    lines.push('✅ All files pass — zero errors, zero warnings.')
    return lines.join('\n')
  }

  for (const file of filesWithIssues) {
    lines.push(`### ${file.filePath}`)
    lines.push('')
    for (const msg of file.messages) {
      const sev = msg.severity === 2 ? '❌' : '⚠️'
      lines.push(`- ${sev} L${msg.line}:${msg.column} — ${msg.message} (${msg.ruleId ?? 'unknown'})`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ── ESLint tool handlers (extracted for reduced cyclomatic complexity) ──

function quotePaths(paths: string[]): string {
  return paths.map((p) => `"${sanitizePath(p)}"`).join(' ')
}

async function handleEslintCheck(args: {
  paths?: string[]
  format: 'summary' | 'full'
}): Promise<{ isError?: boolean; content: Array<{ type: 'text'; text: string }> }> {
  try {
    let targetPaths = args.paths ?? []
    let fromGit = false
    if (targetPaths.length === 0) {
      targetPaths = getGitChangedFiles(WORKSPACE_PATH)
      fromGit = true
      if (targetPaths.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No changed files to lint.' }] }
      }
    }

    const { stdout } = runEslint(['--format', 'json', quotePaths(targetPaths)], WORKSPACE_PATH)
    const diagnostics: EslintDiagnostic[] = JSON.parse(stdout)

    const prefix = fromGit ? `_Scanned ${targetPaths.length} git-changed file(s)._\n\n` : ''
    const output =
      args.format === 'full'
        ? formatFullDiagnostics(diagnostics)
        : summarizeDiagnostics(diagnostics)

    return {
      content: [{ type: 'text' as const, text: truncateToolOutput(prefix + output, 15_000) }]
    }
  } catch (err) {
    if (err instanceof EslintConfigError) {
      return { content: [{ type: 'text' as const, text: `[eslint_check] ⚠️ ${err.message}` }] }
    }
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `[eslint_check] Error: ${err instanceof Error ? err.message : String(err)}`
        }
      ]
    }
  }
}

async function handleEslintFix(args: {
  paths: string[]
}): Promise<{ isError?: boolean; content: Array<{ type: 'text'; text: string }> }> {
  try {
    const quoted = quotePaths(args.paths)

    // Run --fix, then re-run without --fix to get remaining issues
    runEslint(['--fix', '--format', 'json', quoted], WORKSPACE_PATH)
    const { stdout } = runEslint(['--format', 'json', quoted], WORKSPACE_PATH)
    const diagnostics: EslintDiagnostic[] = JSON.parse(stdout)

    const totalErrors = diagnostics.reduce((s, d) => s + d.errorCount, 0)
    const totalWarnings = diagnostics.reduce((s, d) => s + d.warningCount, 0)
    const filesWithIssues = diagnostics.filter((d) => d.errorCount + d.warningCount > 0)

    const lines: string[] = [
      `## ESLint Fix Results`,
      ``,
      `Auto-fix applied to **${args.paths.length}** path(s).`,
      `**Remaining:** ${totalErrors} errors, ${totalWarnings} warnings across ${filesWithIssues.length} file(s).`,
      ``
    ]

    if (filesWithIssues.length === 0) {
      lines.push('✅ All auto-fixable issues resolved — zero remaining errors.')
    } else {
      lines.push('### Remaining Issues (cannot auto-fix)')
      lines.push('')
      for (const file of filesWithIssues.slice(0, 15)) {
        lines.push(`**${file.filePath}** — ${file.errorCount} errors, ${file.warningCount} warnings`)
        for (const msg of file.messages.slice(0, 10)) {
          const sev = msg.severity === 2 ? '❌' : '⚠️'
          lines.push(`  ${sev} L${msg.line}:${msg.column} — ${msg.message} (${msg.ruleId ?? 'unknown'})`)
        }
      }
    }

    return {
      content: [{ type: 'text' as const, text: truncateToolOutput(lines.join('\n'), 15_000) }]
    }
  } catch (err) {
    if (err instanceof EslintConfigError) {
      return { content: [{ type: 'text' as const, text: `[eslint_fix] ⚠️ ${err.message}` }] }
    }
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `[eslint_fix] Error: ${err instanceof Error ? err.message : String(err)}`
        }
      ]
    }
  }
}

function resolveRuleSeverity(raw: unknown): 'error' | 'warn' | 'off' {
  return raw === 2 || raw === 'error'
    ? 'error'
    : raw === 1 || raw === 'warn'
      ? 'warn'
      : 'off'
}

function resolveTargetFile(filePath?: string): string {
  if (filePath) return filePath
  try {
    const found = execSync('find src -name "*.ts" -not -path "*/node_modules/*" | head -1', {
      cwd: WORKSPACE_PATH,
      timeout: 5_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim()
    return found || 'src/index.ts'
  } catch {
    return 'src/index.ts'
  }
}

function formatRulesOutput(
  targetFile: string,
  rules: Record<string, unknown>
): string {
  const activeRules: Array<{ rule: string; severity: string; options: unknown }> = []
  for (const [rule, value] of Object.entries(rules)) {
    const arr = Array.isArray(value) ? value : [value]
    const severity = resolveRuleSeverity(arr[0])
    if (severity === 'off') continue
    activeRules.push({ rule, severity, options: arr.length > 1 ? arr.slice(1) : undefined })
  }

  // Group by prefix (e.g. @typescript-eslint, import, etc.)
  const groups = new Map<string, typeof activeRules>()
  for (const entry of activeRules) {
    const prefix = entry.rule.includes('/') ? entry.rule.split('/')[0] : 'core'
    const list = groups.get(prefix) ?? []
    list.push(entry)
    groups.set(prefix, list)
  }

  const lines: string[] = [
    `## Active ESLint Rules for \`${targetFile}\``,
    ``,
    `**${activeRules.length}** active rules (${activeRules.filter((r) => r.severity === 'error').length} errors, ${activeRules.filter((r) => r.severity === 'warn').length} warnings)`,
    ``
  ]

  for (const [group, groupRules] of [...groups.entries()].sort()) {
    lines.push(`### ${group} (${groupRules.length})`)
    lines.push('')
    for (const r of groupRules.sort((a, b) => a.rule.localeCompare(b.rule))) {
      const sev = r.severity === 'error' ? '❌' : '⚠️'
      lines.push(`- ${sev} \`${r.rule}\``)
    }
    lines.push('')
  }

  return lines.join('\n')
}

async function handleEslintRules(args: {
  filePath?: string
}): Promise<{ isError?: boolean; content: Array<{ type: 'text'; text: string }> }> {
  try {
    const targetFile = resolveTargetFile(args.filePath)
    const { stdout } = runEslint(['--print-config', `"${sanitizePath(targetFile)}"`], WORKSPACE_PATH)
    const config = JSON.parse(stdout)
    const output = formatRulesOutput(targetFile, config.rules ?? {})

    return {
      content: [{ type: 'text' as const, text: truncateToolOutput(output, 15_000) }]
    }
  } catch (err) {
    if (err instanceof EslintConfigError) {
      return { content: [{ type: 'text' as const, text: `[eslint_rules] ⚠️ ${err.message}` }] }
    }
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `[eslint_rules] Error: ${err instanceof Error ? err.message : String(err)}`
        }
      ]
    }
  }
}

// ── Audit scan (combined tool) ──────────────────────────────────────

/**
 * Structural declarations are referenced by shape rather than by call, so
 * "no cross-file reference" is a poor dead-code signal for them. Mirrors the
 * default in code-graph's find_dead_code so both tools answer identically.
 */
const STRUCTURAL_SYMBOL_KINDS = ['interface', 'type']

async function handleAuditScan(args: {
  paths: string[]
  complexityThreshold: number
  maxResults: number
  includeTypeDeclarations?: boolean
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const sections: string[] = ['## Audit Scan Results\n']

  // ── 1. Run ESLint with complexity rule (single pass for lint + complexity) ──
  if (!checkEslintAvailable()) {
    sections.push(
      `### ESLint + Complexity\n⚠️ ESLint not available via npx. Complexity analysis requires ESLint.\n`
    )
  } else try {
    const targetPaths = args.paths.map(sanitizePath)
    const { stdout } = runEslint(
      [
        '--format', 'json',
        '--rule', `'{"complexity": ["warn", {"max": 0}]}'`,
        quotePaths(targetPaths)
      ],
      WORKSPACE_PATH
    )
    const diagnostics: EslintDiagnostic[] = JSON.parse(stdout)

    // Split lint issues from complexity issues
    const lintIssues: Array<{
      file: string; line: number; severity: number; rule: string
    }> = []
    const complexityResults: ComplexityResult[] = []

    for (const diag of diagnostics) {
      for (const msg of diag.messages) {
        if (msg.ruleId === 'complexity') {
          const parsed = parseComplexityMessage(msg, diag.filePath)
          if (parsed && parsed.complexity >= args.complexityThreshold) {
            complexityResults.push(parsed)
          }
        } else if (msg.ruleId) {
          lintIssues.push({
            file: diag.filePath.replace(WORKSPACE_PATH + '/', ''),
            line: msg.line,
            severity: msg.severity,
            rule: msg.ruleId
          })
        }
      }
    }

    // ESLint section
    const errors = lintIssues.filter((i) => i.severity === 2)
    const warnings = lintIssues.filter((i) => i.severity === 1)
    sections.push(
      `### ESLint (${errors.length} errors, ${warnings.length} warnings across ${diagnostics.length} files)`
    )
    if (lintIssues.length === 0) {
      sections.push('✅ All files pass.\n')
    } else {
      sections.push('| Severity | Rule | File | Line |')
      sections.push('|----------|------|------|------|')
      for (const i of lintIssues.slice(0, args.maxResults)) {
        const sev = i.severity === 2 ? '❌' : '⚠️'
        sections.push(`| ${sev} | ${i.rule} | ${i.file} | ${i.line} |`)
      }
      if (lintIssues.length > args.maxResults) {
        sections.push(`_...and ${lintIssues.length - args.maxResults} more_`)
      }
      sections.push('')
    }

    // Complexity section
    complexityResults.sort((a, b) => b.complexity - a.complexity)
    const cappedComplexity = complexityResults.slice(0, args.maxResults)
    sections.push(
      `### Complexity (${complexityResults.length} functions above threshold ${args.complexityThreshold})`
    )
    if (cappedComplexity.length === 0) {
      sections.push(`✅ No functions exceed complexity ${args.complexityThreshold}.\n`)
    } else {
      sections.push('| Score | Function | File | Line |')
      sections.push('|-------|----------|------|------|')
      for (const r of cappedComplexity) {
        const flag = r.complexity > 20 ? '🔴' : r.complexity > 10 ? '🟡' : '🔵'
        const relFile = r.file.replace(WORKSPACE_PATH + '/', '')
        sections.push(`| ${flag} ${r.complexity} | ${r.function} | ${relFile} | ${r.line} |`)
      }
      sections.push('')
    }
  } catch (err) {
    if (err instanceof EslintConfigError) {
      // Graceful degradation — config issue, not a crash
      sections.push(`### ESLint + Complexity\n⚠️ ${err.message}\n`)
    } else {
      const msg = err instanceof Error ? err.message : String(err)
      const hint = !checkEslintAvailable()
        ? ' ESLint is not available via npx.'
        : msg.includes('exit code 2')
          ? ' ESLint could not parse the project config. Check eslint.config.* for syntax errors.'
          : ''
      sections.push(`### ESLint + Complexity\n⚠️ Error: ${msg.slice(0, 300)}${hint}\n`)
    }
  }

  // ── 2. Dead code via code-graph (if available) ──
  if (WORKSPACE_ID) {
    try {
      const { codeGraphService } = await import('../services/code-graph.service')
      const deadResults = await codeGraphService.findDeadCode(WORKSPACE_ID, WORKSPACE_PATH, {
        path: args.paths.length === 1 ? args.paths[0] : undefined,
        maxResults: args.maxResults,
        excludeSymbolKinds: args.includeTypeDeclarations ? undefined : STRUCTURAL_SYMBOL_KINDS
      })
      sections.push(`### Dead Code (${deadResults.length} unreferenced symbols)`)
      if (deadResults.length === 0) {
        sections.push('✅ No unreferenced symbols found.\n')
      } else {
        sections.push('| Symbol | File | Line |')
        sections.push('|--------|------|------|')
        for (const d of deadResults.slice(0, args.maxResults)) {
          sections.push(`| ${d.name} | ${d.file} | ${d.line} |`)
        }
        sections.push('')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isNative = msg.includes('NODE_MODULE_VERSION') || msg.includes('ABI') || msg.includes('was compiled against') || msg.includes('.node')
      const hint = isNative
        ? ' The better-sqlite3 native module failed to load. Reinstall with `npm install better-sqlite3`.'
        : ''
      sections.push(`### Dead Code\n⚠️ Error: ${msg.slice(0, 300)}${hint}\n`)
    }
  } else {
    sections.push('### Dead Code\n⚠️ Skipped — code graph unavailable (no WORKSPACE_ID).\n')
  }

  // ── Summary if both sub-scans failed ──
  const eslintFailed = sections.some(s => s.includes('### ESLint + Complexity\n⚠️'))
  const deadCodeFailed = sections.some(s => s.includes('### Dead Code\n⚠️'))

  if (eslintFailed && deadCodeFailed) {
    sections.push(
      `### Summary\n⚠️ Both sub-scans produced warnings. Common causes:\n`
      + `- ESLint not available via npx\n`
      + `- No ESLint config in workspace (eslint.config.* or .eslintrc.*)\n`
      + `- Native module load failure: reinstall with \`npm install better-sqlite3\`\n`
    )
  }

  return {
    content: [{ type: 'text' as const, text: truncateToolOutput(sections.join('\n'), 15_000) }]
  }
}

// ── ESLint + audit tool registration ────────────────────────────────────

function registerEslintTools(): void {
  server.tool(
    'eslint_check',
    'Run ESLint on specified files or directories and return structured results. Defaults to changed files (git diff) if no paths given.',
    {
      paths: z
        .array(z.string())
        .optional()
        .describe('File/dir paths to lint. Omit to lint git-changed files only.'),
      format: z
        .enum(['summary', 'full'])
        .optional()
        .default('summary')
        .describe('summary = counts + top issues; full = all diagnostics')
    },
    handleEslintCheck
  )

  server.tool(
    'eslint_fix',
    'Run ESLint with --fix on specified files. Auto-fixes what it can, returns remaining issues.',
    {
      paths: z
        .array(z.string())
        .min(1)
        .describe('File/dir paths to fix (required — no implicit git diff for writes)')
    },
    handleEslintFix
  )

  server.tool(
    'eslint_rules',
    'List active ESLint rules and their severity for a file. Useful for understanding which rules are enforced.',
    {
      filePath: z
        .string()
        .optional()
        .describe('File to check config for (default: first .ts file found or src/index.ts)')
    },
    handleEslintRules
  )

  server.tool(
    'audit_scan',
    'Combined ESLint + complexity + dead code scan. Use instead of separate eslint_check/analyze_complexity/find_dead_code calls.',
    {
      paths: z.array(z.string()).min(1).describe('Files or directories to scan'),
      complexityThreshold: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(5)
        .describe('Report functions with complexity >= this (default: 5)'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(25)
        .describe('Max results per section (default: 25)'),
      includeTypeDeclarations: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Include interfaces and type aliases in the dead-code section. Off by ' +
            'default: they are referenced structurally rather than by call, so ' +
            'unreferenced ≠ dead.'
        )
    },
    handleAuditScan
  )
}

async function main(): Promise<void> {
  await registerTools()
  registerEslintTools()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[code-analysis-server] Started (workspace=${WORKSPACE_PATH})`)
}

main().catch((err) => {
  console.error('[code-analysis-server] Fatal:', err)
  process.exit(1)
})
