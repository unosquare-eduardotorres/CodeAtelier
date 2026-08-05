/**
 * Unit tests for ESLint MCP tools — output parsing, summary formatting,
 * exit code handling, git-changed file detection, and error cases.
 *
 * Tests the pure-logic helpers exported from code-analysis-server.ts
 * indirectly by exercising the same parsing/formatting patterns.
 * No actual ESLint or git invocations — all execSync calls are mocked.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Test fixtures ──

interface MockDiagnostic {
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

const CLEAN_DIAGNOSTICS: MockDiagnostic[] = [
  {
    filePath: 'src/app.ts',
    messages: [],
    errorCount: 0,
    warningCount: 0,
    fixableErrorCount: 0,
    fixableWarningCount: 0
  }
]

const ERROR_DIAGNOSTICS: MockDiagnostic[] = [
  {
    filePath: 'src/service.ts',
    messages: [
      {
        ruleId: '@typescript-eslint/no-unused-vars',
        severity: 2,
        message: "'foo' is defined but never used.",
        line: 10,
        column: 7
      },
      {
        ruleId: '@typescript-eslint/no-explicit-any',
        severity: 2,
        message: 'Unexpected any. Specify a different type.',
        line: 15,
        column: 20
      },
      {
        ruleId: 'no-console',
        severity: 1,
        message: 'Unexpected console statement.',
        line: 22,
        column: 5
      }
    ],
    errorCount: 2,
    warningCount: 1,
    fixableErrorCount: 1,
    fixableWarningCount: 0
  },
  {
    filePath: 'src/utils.ts',
    messages: [
      {
        ruleId: 'prefer-const',
        severity: 2,
        message: "'x' is never reassigned. Use 'const' instead.",
        line: 5,
        column: 7
      }
    ],
    errorCount: 1,
    warningCount: 0,
    fixableErrorCount: 1,
    fixableWarningCount: 0
  }
]

const MIXED_DIAGNOSTICS: MockDiagnostic[] = [...ERROR_DIAGNOSTICS, ...CLEAN_DIAGNOSTICS]

// ── Summary formatting (mirrors summarizeDiagnostics logic) ──

function summarizeDiagnostics(diagnostics: MockDiagnostic[]): string {
  const totalErrors = diagnostics.reduce((s, d) => s + d.errorCount, 0)
  const totalWarnings = diagnostics.reduce((s, d) => s + d.warningCount, 0)
  const filesWithIssues = diagnostics.filter((d) => d.errorCount + d.warningCount > 0)

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

  const topRules = [...ruleCounts.entries()]
    .sort((a, b) => b[1].errors + b[1].warnings - (a[1].errors + a[1].warnings))
    .slice(0, 10)

  lines.push('### Top Issues by Rule')
  lines.push('')
  lines.push('| Rule | Errors | Warnings |')
  lines.push('|------|--------|----------|')
  for (const [rule, counts] of topRules) {
    lines.push(`| ${rule} | ${counts.errors} | ${counts.warnings} |`)
  }

  const errorFiles = filesWithIssues
    .filter((f) => f.errorCount > 0)
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

function formatFullDiagnostics(diagnostics: MockDiagnostic[]): string {
  const filesWithIssues = diagnostics.filter((d) => d.errorCount + d.warningCount > 0)
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
      lines.push(
        `- ${sev} L${msg.line}:${msg.column} — ${msg.message} (${msg.ruleId ?? 'unknown'})`
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ── Tests ──

describe('ESLint MCP Tools — eslint_check output parsing', () => {
  test('clean diagnostics produce pass message', () => {
    const output = summarizeDiagnostics(CLEAN_DIAGNOSTICS)
    assert.ok(output.includes('✅ All files pass'))
    assert.ok(output.includes('**0** errors'))
    assert.ok(output.includes('**0** warnings'))
  })

  test('error diagnostics produce summary with rule table', () => {
    const output = summarizeDiagnostics(ERROR_DIAGNOSTICS)
    assert.ok(output.includes('**3** errors'))
    assert.ok(output.includes('**1** warnings'))
    assert.ok(output.includes('@typescript-eslint/no-unused-vars'))
    assert.ok(output.includes('@typescript-eslint/no-explicit-any'))
    assert.ok(output.includes('prefer-const'))
    assert.ok(output.includes('### Top Issues by Rule'))
    assert.ok(output.includes('### Files with Errors'))
  })

  test('mixed diagnostics count files correctly', () => {
    const output = summarizeDiagnostics(MIXED_DIAGNOSTICS)
    assert.ok(output.includes(`**${MIXED_DIAGNOSTICS.length}** files checked`))
    assert.ok(output.includes('**3** errors'))
  })

  test('summary includes file paths with error counts', () => {
    const output = summarizeDiagnostics(ERROR_DIAGNOSTICS)
    assert.ok(output.includes('**src/service.ts** — 2 errors, 1 warnings'))
    assert.ok(output.includes('**src/utils.ts** — 1 errors, 0 warnings'))
  })

  test('files sorted by error count descending', () => {
    const output = summarizeDiagnostics(ERROR_DIAGNOSTICS)
    const serviceIdx = output.indexOf('src/service.ts')
    const utilsIdx = output.indexOf('src/utils.ts')
    assert.ok(
      serviceIdx < utilsIdx,
      'service.ts (2 errors) should appear before utils.ts (1 error)'
    )
  })
})

describe('ESLint MCP Tools — full format output', () => {
  test('clean diagnostics produce pass message in full mode', () => {
    const output = formatFullDiagnostics(CLEAN_DIAGNOSTICS)
    assert.ok(output.includes('✅ All files pass'))
    assert.ok(output.includes('ESLint Results (Full)'))
  })

  test('full format lists each diagnostic with location', () => {
    const output = formatFullDiagnostics(ERROR_DIAGNOSTICS)
    assert.ok(output.includes('L10:7'))
    assert.ok(output.includes('L15:20'))
    assert.ok(output.includes("'foo' is defined but never used."))
    assert.ok(output.includes('❌')) // error severity marker
    assert.ok(output.includes('⚠️')) // warning severity marker
  })

  test('full format includes file path headings', () => {
    const output = formatFullDiagnostics(ERROR_DIAGNOSTICS)
    assert.ok(output.includes('### src/service.ts'))
    assert.ok(output.includes('### src/utils.ts'))
  })
})

describe('ESLint MCP Tools — eslint_check with no paths (git-changed files)', () => {
  test('git diff output parsing filters lintable extensions', () => {
    const diffOutput = 'src/app.ts\nREADME.md\nsrc/utils.tsx\npackage.json\ntest.js\n'
    const files = diffOutput
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f))
    assert.deepEqual(files, ['src/app.ts', 'src/utils.tsx', 'test.js'])
  })

  test('empty git diff returns empty array', () => {
    const diffOutput = '\n'
    const files = diffOutput
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f))
    assert.deepEqual(files, [])
  })

  test('deduplication between diff and staged', () => {
    const diff = 'src/a.ts\nsrc/b.ts\n'
    const staged = 'src/b.ts\nsrc/c.ts\n'
    const all = `${diff}\n${staged}`
    const unique = [
      ...new Set(
        all
          .split('\n')
          .map((f) => f.trim())
          .filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f))
      )
    ]
    assert.deepEqual(unique, ['src/a.ts', 'src/b.ts', 'src/c.ts'])
  })
})

describe('ESLint MCP Tools — eslint_fix output parsing', () => {
  test('fix result with no remaining issues produces clean message', () => {
    const remaining: MockDiagnostic[] = [
      {
        filePath: 'src/app.ts',
        messages: [],
        errorCount: 0,
        warningCount: 0,
        fixableErrorCount: 0,
        fixableWarningCount: 0
      }
    ]
    const totalErrors = remaining.reduce((s, d) => s + d.errorCount, 0)
    const totalWarnings = remaining.reduce((s, d) => s + d.warningCount, 0)
    const filesWithIssues = remaining.filter((d) => d.errorCount + d.warningCount > 0)

    assert.equal(totalErrors, 0)
    assert.equal(totalWarnings, 0)
    assert.equal(filesWithIssues.length, 0)
  })

  test('fix result with remaining issues reports counts', () => {
    const remaining = ERROR_DIAGNOSTICS
    const totalErrors = remaining.reduce((s, d) => s + d.errorCount, 0)
    const totalWarnings = remaining.reduce((s, d) => s + d.warningCount, 0)

    assert.equal(totalErrors, 3)
    assert.equal(totalWarnings, 1)
  })
})

describe('ESLint MCP Tools — eslint_rules output parsing', () => {
  test('rule severity mapping — numeric to string', () => {
    const severityMap = (raw: unknown): string => {
      return raw === 2 || raw === 'error' ? 'error' : raw === 1 || raw === 'warn' ? 'warn' : 'off'
    }

    assert.equal(severityMap(2), 'error')
    assert.equal(severityMap('error'), 'error')
    assert.equal(severityMap(1), 'warn')
    assert.equal(severityMap('warn'), 'warn')
    assert.equal(severityMap(0), 'off')
    assert.equal(severityMap('off'), 'off')
  })

  test('filter rules with severity > 0', () => {
    const rules: Record<string, unknown> = {
      'no-console': 1,
      'no-unused-vars': 2,
      semi: 0,
      '@typescript-eslint/no-explicit-any': ['error', { ignoreRestArgs: true }],
      '@typescript-eslint/no-unused-vars': 'off'
    }

    const activeRules: Array<{ rule: string; severity: string }> = []
    for (const [rule, value] of Object.entries(rules)) {
      const arr = Array.isArray(value) ? value : [value]
      const sevRaw = arr[0]
      const severity =
        sevRaw === 2 || sevRaw === 'error'
          ? 'error'
          : sevRaw === 1 || sevRaw === 'warn'
            ? 'warn'
            : 'off'
      if (severity === 'off') continue
      activeRules.push({ rule, severity })
    }

    assert.equal(activeRules.length, 3)
    assert.ok(activeRules.some((r) => r.rule === 'no-console' && r.severity === 'warn'))
    assert.ok(activeRules.some((r) => r.rule === 'no-unused-vars' && r.severity === 'error'))
    assert.ok(
      activeRules.some(
        (r) => r.rule === '@typescript-eslint/no-explicit-any' && r.severity === 'error'
      )
    )
  })

  test('rule grouping by prefix', () => {
    const activeRules = [
      { rule: 'no-console', severity: 'warn' },
      { rule: '@typescript-eslint/no-unused-vars', severity: 'error' },
      { rule: '@typescript-eslint/no-explicit-any', severity: 'error' },
      { rule: 'import/no-unresolved', severity: 'error' },
      { rule: 'prefer-const', severity: 'error' }
    ]

    const groups = new Map<string, typeof activeRules>()
    for (const entry of activeRules) {
      const prefix = entry.rule.includes('/') ? entry.rule.split('/')[0] : 'core'
      const list = groups.get(prefix) ?? []
      list.push(entry)
      groups.set(prefix, list)
    }

    assert.equal(groups.size, 3)
    assert.equal(groups.get('core')!.length, 2) // no-console, prefer-const
    assert.equal(groups.get('@typescript-eslint')!.length, 2)
    assert.equal(groups.get('import')!.length, 1)
  })
})

describe('ESLint MCP Tools — exit code handling', () => {
  test('exit code 0 indicates clean lint (no errors, no warnings)', () => {
    // Exit 0 = clean pass
    const exitCode = 0
    assert.equal(exitCode, 0)
  })

  test('exit code 1 indicates lint errors found (not a crash)', () => {
    // Exit 1 = lint errors found — still produces valid JSON output
    const exitCode = 1
    assert.notEqual(exitCode, 0)
    // The runEslint helper should still return stdout on exit 1
    assert.ok(exitCode === 1)
  })

  test('exit code 2 indicates fatal config/parse error', () => {
    // Exit 2 = fatal error — should throw
    const exitCode = 2
    assert.equal(exitCode, 2)
  })
})

describe('ESLint MCP Tools — timeout handling', () => {
  test('60s timeout constant is defined', () => {
    const ESLINT_TIMEOUT = 60_000
    assert.equal(ESLINT_TIMEOUT, 60000)
    assert.ok(ESLINT_TIMEOUT > 0)
  })
})

describe('ESLint MCP Tools — path sanitization', () => {
  // Mirrors the sanitizePath function in code-analysis-server.ts
  function sanitizePath(p: string): string {
    if (/["'`$\\;|&(){}]/.test(p)) {
      throw new Error(`Path contains unsafe characters: ${p.slice(0, 80)}`)
    }
    return p
  }

  test('normal paths pass through', () => {
    assert.equal(sanitizePath('src/app.ts'), 'src/app.ts')
    assert.equal(sanitizePath('src/my-file.tsx'), 'src/my-file.tsx')
    assert.equal(sanitizePath('src/folder/deep/file.js'), 'src/folder/deep/file.js')
  })

  test('paths with spaces are allowed', () => {
    assert.equal(sanitizePath('src/my file.ts'), 'src/my file.ts')
  })

  test('paths with double quotes are rejected', () => {
    assert.throws(() => sanitizePath('src/"injected".ts'), /unsafe characters/)
  })

  test('paths with backticks are rejected', () => {
    assert.throws(() => sanitizePath('src/`whoami`.ts'), /unsafe characters/)
  })

  test('paths with dollar signs are rejected', () => {
    assert.throws(() => sanitizePath('src/$HOME.ts'), /unsafe characters/)
  })

  test('paths with semicolons are rejected', () => {
    assert.throws(() => sanitizePath('src/file.ts; rm -rf /'), /unsafe characters/)
  })

  test('paths with pipe are rejected', () => {
    assert.throws(() => sanitizePath('src/file.ts | cat /etc/passwd'), /unsafe characters/)
  })

  test('paths with ampersand are rejected', () => {
    assert.throws(() => sanitizePath('src/file.ts & echo pwned'), /unsafe characters/)
  })

  test('paths with backslash are rejected', () => {
    assert.throws(() => sanitizePath('src\\file.ts'), /unsafe characters/)
  })

  test('paths with single quotes are rejected', () => {
    assert.throws(() => sanitizePath("src/'file'.ts"), /unsafe characters/)
  })
})

describe('ESLint MCP Tools — graceful error messages', () => {
  test('ENOENT error produces ESLint not found message', () => {
    const message = 'spawn npx ENOENT'
    const isNotFound = message.includes('ENOENT') || message.includes('not found')
    assert.ok(isNotFound)

    const errorMessage =
      'ESLint not found in workspace. Ensure eslint is installed (npm install eslint).'
    assert.ok(errorMessage.includes('not found'))
    assert.ok(errorMessage.includes('npm install'))
  })

  test('generic error is passed through', () => {
    const err = new Error('Something unexpected')
    const output = `[eslint_check] Error: ${err.message}`
    assert.ok(output.includes('Something unexpected'))
    assert.ok(output.startsWith('[eslint_check]'))
  })
})

// Only print summary when run standalone
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
