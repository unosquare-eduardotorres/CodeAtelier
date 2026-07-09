/**
 * Test Registry Sync Guard — prevents run-all.ts from drifting behind run-tests.ts.
 *
 * Reads both files, extracts import specifiers, and asserts:
 *   run-all.ts imports ⊇ run-tests.ts imports (service tests)
 *   run-all.ts imports ⊇ run-tests.ts (repo) imports (repository tests)
 *
 * Any future drift fails CI immediately instead of silently shrinking coverage.
 *
 * Supports two formats:
 *   - Static imports:   import './foo.test'
 *   - Array elements:   './foo.test',    (used in dynamic-import runners)
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, describe, summaryAsync } from './test-harness'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Extract all test file specifiers from a runner file.
 * Matches both:
 *   import './foo.test'           (static import)
 *   './foo.test',                 (array element in dynamic-import runner)
 *   '../path/__tests__/foo.test', (array element with deeper path)
 */
function extractImports(filePath: string): Set<string> {
  const content = readFileSync(filePath, 'utf-8')
  const imports = new Set<string>()
  for (const line of content.split('\n')) {
    // Match static import: import './foo.test'
    const staticMatch = line.match(/^import\s+['"](.+?)['"]/)
    if (staticMatch) {
      imports.add(staticMatch[1])
      continue
    }
    // Match array element: '  './foo.test',' (with optional leading whitespace)
    const arrayMatch = line.match(/^\s+['"](.+?\.test)['"],?\s*$/)
    if (arrayMatch) {
      imports.add(arrayMatch[1])
    }
  }
  return imports
}

/** Normalize an import specifier to a canonical form relative to workspace root. */
function normalizeImport(specifier: string, sourceDir: string): string {
  // Resolve relative to the source file's directory, then strip workspace root
  const wsRoot = resolve(__dirname, '../../..')
  const abs = resolve(sourceDir, specifier)
  return abs.replace(wsRoot + '/', '').replace(/\.test$/, '.test')
}

describe('test-registry-sync', () => {
  test('run-all.ts contains all service test imports from run-tests.ts', () => {
    const runTestsPath = resolve(__dirname, 'run-tests.ts')
    const runAllPath = resolve(__dirname, '../../__tests__/run-all.ts')

    const runTestsImports = extractImports(runTestsPath)
    const runAllImports = extractImports(runAllPath)

    // Normalize paths relative to workspace root
    const runTestsDir = dirname(runTestsPath)
    const runAllDir = dirname(runAllPath)

    const normalizedRunTests = new Set<string>()
    for (const imp of runTestsImports) {
      // Skip the summary import (test harness)
      if (imp.includes('test-harness')) continue
      normalizedRunTests.add(normalizeImport(imp, runTestsDir))
    }

    const normalizedRunAll = new Set<string>()
    for (const imp of runAllImports) {
      if (imp.includes('test-harness')) continue
      normalizedRunAll.add(normalizeImport(imp, runAllDir))
    }

    const missing: string[] = []
    for (const imp of normalizedRunTests) {
      if (!normalizedRunAll.has(imp)) {
        missing.push(imp)
      }
    }

    if (missing.length > 0) {
      assert.fail(
        `run-all.ts is missing ${missing.length} import(s) from run-tests.ts:\n` +
        missing.map((m) => `  - ${m}`).join('\n') +
        '\n\nAdd these imports to src/main/__tests__/run-all.ts to restore full coverage.'
      )
    }
  })

  test('run-all.ts contains all repository test imports from run-tests.ts', () => {
    const repoRunTestsPath = resolve(__dirname, '../../db/repositories/__tests__/run-tests.ts')
    const runAllPath = resolve(__dirname, '../../__tests__/run-all.ts')

    const repoImports = extractImports(repoRunTestsPath)
    const runAllImports = extractImports(runAllPath)

    const repoDir = dirname(repoRunTestsPath)
    const runAllDir = dirname(runAllPath)

    const normalizedRepo = new Set<string>()
    for (const imp of repoImports) {
      if (imp.includes('test-harness')) continue
      normalizedRepo.add(normalizeImport(imp, repoDir))
    }

    const normalizedRunAll = new Set<string>()
    for (const imp of runAllImports) {
      if (imp.includes('test-harness')) continue
      normalizedRunAll.add(normalizeImport(imp, runAllDir))
    }

    const missing: string[] = []
    for (const imp of normalizedRepo) {
      if (!normalizedRunAll.has(imp)) {
        missing.push(imp)
      }
    }

    if (missing.length > 0) {
      assert.fail(
        `run-all.ts is missing ${missing.length} repository import(s) from db/repositories/__tests__/run-tests.ts:\n` +
        missing.map((m) => `  - ${m}`).join('\n') +
        '\n\nAdd these imports to src/main/__tests__/run-all.ts to restore full coverage.'
      )
    }
  })

  test('no test file has unguarded summaryAsync()/summary() at module scope', () => {
    // Scan all __tests__ directories for .test.ts files that call
    // summaryAsync() or summary() at column 0 (unguarded), which would
    // drain the shared harness queue and exit early in aggregate runs.
    const testDirs = [
      __dirname,
      resolve(__dirname, '../../ipc/__tests__'),
      resolve(__dirname, '../../mcp-servers/__tests__'),
      resolve(__dirname, '../../db/repositories/__tests__'),
    ]

    const violations: string[] = []
    for (const dir of testDirs) {
      let files: string[]
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.test.ts'))
      } catch {
        continue // directory may not exist
      }
      for (const file of files) {
        const filePath = join(dir, file)
        const content = readFileSync(filePath, 'utf-8')
        for (const line of content.split('\n')) {
          // Match bare summaryAsync() / summary() / void summaryAsync() at column 0
          if (/^(?:void\s+)?summary(?:Async)?\(\)/.test(line)) {
            violations.push(`${file}: unguarded "${line.trim()}"`)
          }
        }
      }
    }

    if (violations.length > 0) {
      assert.fail(
        `${violations.length} test file(s) call summaryAsync()/summary() without a standalone guard:\n` +
        violations.map((v) => `  - ${v}`).join('\n') +
        '\n\nWrap in: if (import.meta.url === `file://${process.argv[1]}`) { void summaryAsync() }'
      )
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
