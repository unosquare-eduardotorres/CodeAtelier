import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, basename, extname } from 'node:path'
import log from 'electron-log/main'
import { MCP_TOOLS } from '../../shared/constants'

/**
 * Filesystem-based analysis tools that don't need persistent indexes.
 * New MCP server: `code-analysis`.
 *
 * Tools:
 * - `todo_scanner` — scan for TODO/FIXME/HACK/XXX/BUG markers
 * - `dependency_health` — parse package.json and check version freshness
 * - `test_coverage_map` — convention-based test file mapping
 */
class CodeAnalysisMcpService {
  private servers = new Map<string, McpServerConfig>()

  getMcpServersConfig(workspacePath: string): Record<string, McpServerConfig> {
    const key = workspacePath
    let config = this.servers.get(key)
    if (config) {
      return { 'code-analysis': config }
    }

    config = createSdkMcpServer({
      name: MCP_TOOLS.CODE_ANALYSIS._SERVER,
      version: '1.0.0',
      tools: [
        {
          name: MCP_TOOLS.CODE_ANALYSIS.TODO_SCANNER.tool,
          description:
            'Scan the codebase for TODO, FIXME, HACK, XXX, and BUG markers. ' +
            'Quantifies technical debt markers with file, line, and surrounding context.',
          inputSchema: {
            patterns: z
              .array(z.string())
              .optional()
              .default(['TODO', 'FIXME', 'HACK', 'XXX', 'BUG'])
              .describe('Marker patterns to search for'),
            pathPrefix: z
              .string()
              .optional()
              .describe('Limit scan to files under this path prefix'),
            maxResults: z.number().optional().default(100)
          },
          handler: async (args) => {
            const patterns = args.patterns as string[]
            const pathPrefix = args.pathPrefix as string | undefined
            const maxResults = args.maxResults as number
            log.info(`[CodeAnalysis] todo_scanner (workspace: ${workspacePath})`)

            const searchPath = pathPrefix
              ? join(workspacePath, pathPrefix)
              : workspacePath
            const patternRegex = patterns.join('|')

            try {
              const output = execSync(
                `grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.py' --include='*.rs' --include='*.go' --include='*.cs' --include='*.java' -E '(${patternRegex})' . 2>/dev/null | head -${maxResults}`,
                {
                  cwd: searchPath,
                  encoding: 'utf-8',
                  maxBuffer: 5 * 1024 * 1024,
                  timeout: 30_000
                }
              )

              const matches = output
                .split('\n')
                .filter(Boolean)
                .map((line) => {
                  const match = line.match(/^\.\/(.+?):(\d+):(.*)$/)
                  if (!match) return null
                  const [, file, lineNum, content] = match
                  const trimmed = content.trim()
                  // Detect which pattern matched
                  const patternType =
                    patterns.find((p) => trimmed.toUpperCase().includes(p)) ?? 'OTHER'
                  return {
                    file: pathPrefix ? join(pathPrefix, file) : file,
                    line: parseInt(lineNum, 10),
                    content: trimmed,
                    pattern: patternType
                  }
                })
                .filter(Boolean)

              // Group by pattern
              const byPattern: Record<string, number> = {}
              for (const m of matches) {
                if (m) byPattern[m.pattern] = (byPattern[m.pattern] ?? 0) + 1
              }

              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify(
                      {
                        matches,
                        summary: byPattern,
                        totalCount: matches.length
                      },
                      null,
                      2
                    )
                  }
                ]
              }
            } catch {
              // grep returns exit code 1 when no matches found
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify(
                      { matches: [], summary: {}, totalCount: 0 },
                      null,
                      2
                    )
                  }
                ]
              }
            }
          }
        },
        {
          name: MCP_TOOLS.CODE_ANALYSIS.DEPENDENCY_HEALTH.tool,
          description:
            'Analyze project dependencies from package.json. Lists all dependencies with ' +
            'current version, type (prod/dev/peer), and identifies potential issues.',
          inputSchema: {
            checkOutdated: z
              .boolean()
              .optional()
              .default(false)
              .describe('If true, runs npm outdated to check for newer versions (slower)')
          },
          handler: async (args) => {
            const checkOutdated = args.checkOutdated as boolean
            log.info(`[CodeAnalysis] dependency_health (workspace: ${workspacePath})`)

            const pkgPath = join(workspacePath, 'package.json')
            if (!existsSync(pkgPath)) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({ error: 'No package.json found', dependencies: [] }, null, 2)
                  }
                ]
              }
            }

            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
            const deps = Object.entries(pkg.dependencies ?? {}).map(([name, version]) => ({
              name,
              version: version as string,
              type: 'production' as const
            }))
            const devDeps = Object.entries(pkg.devDependencies ?? {}).map(([name, version]) => ({
              name,
              version: version as string,
              type: 'dev' as const
            }))
            const peerDeps = Object.entries(pkg.peerDependencies ?? {}).map(([name, version]) => ({
              name,
              version: version as string,
              type: 'peer' as const
            }))

            const allDeps = [...deps, ...devDeps, ...peerDeps]

            let outdatedInfo: Record<string, { current: string; wanted: string; latest: string }> =
              {}
            if (checkOutdated) {
              try {
                const output = execSync('npm outdated --json 2>/dev/null || true', {
                  cwd: workspacePath,
                  encoding: 'utf-8',
                  maxBuffer: 5 * 1024 * 1024,
                  timeout: 60_000
                })
                outdatedInfo = JSON.parse(output || '{}')
              } catch {
                // Non-fatal — outdated check is best-effort
              }
            }

            const enriched = allDeps.map((d) => ({
              ...d,
              ...(outdatedInfo[d.name]
                ? {
                    current: outdatedInfo[d.name].current,
                    wanted: outdatedInfo[d.name].wanted,
                    latest: outdatedInfo[d.name].latest,
                    outdated: true
                  }
                : {})
            }))

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      projectName: pkg.name ?? 'unknown',
                      dependencies: enriched,
                      counts: {
                        production: deps.length,
                        dev: devDeps.length,
                        peer: peerDeps.length,
                        total: allDeps.length,
                        outdated: Object.keys(outdatedInfo).length
                      }
                    },
                    null,
                    2
                  )
                }
              ]
            }
          }
        },
        {
          name: MCP_TOOLS.CODE_ANALYSIS.TEST_COVERAGE_MAP.tool,
          description:
            'Map source files to their test counterparts using naming conventions (.test.ts, .spec.ts, __tests__/). ' +
            'Identifies untested modules without needing a coverage runner.',
          inputSchema: {
            pathPrefix: z
              .string()
              .optional()
              .describe('Limit analysis to files under this path prefix (e.g. "src/")')
          },
          handler: async (args) => {
            const pathPrefix = args.pathPrefix as string | undefined
            log.info(`[CodeAnalysis] test_coverage_map (workspace: ${workspacePath})`)

            const searchPath = pathPrefix
              ? join(workspacePath, pathPrefix)
              : workspacePath

            try {
              // Find all source files
              const sourceOutput = execSync(
                `find . -type f \\( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \\) ! -name '*.test.*' ! -name '*.spec.*' ! -path '*/__tests__/*' ! -path '*/node_modules/*' ! -path '*/.git/*' ! -path '*/dist/*' ! -path '*/build/*' | head -500`,
                { cwd: searchPath, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024, timeout: 30_000 }
              )

              const sourceFiles = sourceOutput.split('\n').filter(Boolean).map((f) => f.replace(/^\.\//, ''))

              // Find all test files
              const testOutput = execSync(
                `find . -type f \\( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' -o -name '*.test.js' -o -name '*.test.jsx' -o -name '*.spec.js' -o -name '*.spec.jsx' \\) ! -path '*/node_modules/*' ! -path '*/.git/*' | head -500`,
                { cwd: searchPath, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024, timeout: 30_000 }
              )

              const testFiles = new Set(
                testOutput.split('\n').filter(Boolean).map((f) => f.replace(/^\.\//, ''))
              )

              // Map source → test
              const coverage = sourceFiles.map((srcFile) => {
                const dir = dirname(srcFile)
                const base = basename(srcFile, extname(srcFile))
                // Remove .d from .d.ts files
                const cleanBase = base.endsWith('.d') ? base.slice(0, -2) : base
                const ext = extname(srcFile)

                // Possible test file locations
                const candidates = [
                  join(dir, `${cleanBase}.test${ext}`),
                  join(dir, `${cleanBase}.spec${ext}`),
                  join(dir, '__tests__', `${cleanBase}${ext}`),
                  join(dir, '__tests__', `${cleanBase}.test${ext}`),
                  join(dir, '__tests__', `${cleanBase}.spec${ext}`)
                ]

                const testFile = candidates.find((c) => testFiles.has(c)) ?? null
                return {
                  sourceFile: pathPrefix ? join(pathPrefix, srcFile) : srcFile,
                  testFile: testFile
                    ? pathPrefix
                      ? join(pathPrefix, testFile)
                      : testFile
                    : null,
                  hasCoverage: testFile !== null
                }
              })

              const covered = coverage.filter((c) => c.hasCoverage).length
              const total = coverage.length

              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify(
                      {
                        files: coverage,
                        summary: {
                          totalSourceFiles: total,
                          filesWithTests: covered,
                          filesWithoutTests: total - covered,
                          coverageRatio:
                            total > 0 ? Math.round((covered / total) * 100) / 100 : 0
                        }
                      },
                      null,
                      2
                    )
                  }
                ]
              }
            } catch (error) {
              log.error('[CodeAnalysis] test_coverage_map failed:', error)
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({ error: 'Failed to scan files', files: [] }, null, 2)
                  }
                ]
              }
            }
          }
        }
      ]
    })

    this.servers.set(key, config)
    return { 'code-analysis': config }
  }

  dispose(workspacePath: string): void {
    this.servers.delete(workspacePath)
  }
}

export const codeAnalysisMcpService = new CodeAnalysisMcpService()
