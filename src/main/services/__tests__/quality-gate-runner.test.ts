/**
 * Unit tests for quality-gate-runner.service.ts pure parsers.
 *
 * extractErrorSummary and getAlternativeScriptNames are private — exercised via
 * the exported singleton with an `as unknown as {…}` cast. No child processes
 * are spawned (executeGate is not invoked).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { qualityGateRunnerService } from '../quality-gate-runner.service'

const svc = qualityGateRunnerService as unknown as {
  extractErrorSummary: (type: string, output: string, exitCode?: number) => string
  getAlternativeScriptNames: (type: string, scripts: Record<string, string>) => string | null
}

describe('extractErrorSummary', () => {
  test('typecheck parses "Found N errors"', () => {
    const out = svc.extractErrorSummary('typecheck', 'blah\nFound 3 errors in 2 files\nend')
    assert.ok(out.startsWith('TypeScript: 3 error(s).'))
  })

  test('typecheck reports unknown when count not found', () => {
    const out = svc.extractErrorSummary('typecheck', 'something went wrong')
    assert.ok(out.includes('unknown error(s)'))
  })

  test('lint parses problem/error count', () => {
    const out = svc.extractErrorSummary('lint', '✖ 12 problems (10 errors, 2 warnings)')
    assert.ok(out.startsWith('Lint: 12 issue(s).'))
  })

  test('test parses failure count', () => {
    const out = svc.extractErrorSummary('test', 'Tests: 4 failed, 10 passed')
    assert.ok(out.startsWith('Tests: 4 failure(s).'))
  })

  test('build includes exit code', () => {
    const out = svc.extractErrorSummary('build', 'compile error', 2)
    assert.ok(out.startsWith('Build failed (exit 2).'))
  })

  test('unknown type falls back with exit code', () => {
    const out = svc.extractErrorSummary('custom', 'oops', 1)
    assert.ok(out.startsWith('custom failed (exit 1).'))
  })

  test('caps last-N-lines detail at 400 chars', () => {
    const huge = 'x'.repeat(5000)
    const out = svc.extractErrorSummary('build', huge, 1)
    // prefix + up to 400 chars of detail
    assert.ok(out.length <= 'Build failed (exit 1). '.length + 400)
  })
})

describe('getAlternativeScriptNames', () => {
  test('finds a typecheck alternative', () => {
    assert.equal(svc.getAlternativeScriptNames('typecheck', { 'type-check': 'tsc' }), 'type-check')
  })

  test('finds a lint alternative', () => {
    assert.equal(svc.getAlternativeScriptNames('lint', { eslint: 'eslint .' }), 'eslint')
  })

  test('finds a test alternative (first match wins)', () => {
    assert.equal(
      svc.getAlternativeScriptNames('test', { 'test:run': 'x', 'test:unit': 'y' }),
      'test:unit'
    )
  })

  test('returns null when no alternative present', () => {
    assert.equal(svc.getAlternativeScriptNames('typecheck', { build: 'vite' }), null)
  })

  test('returns null for an unknown gate type', () => {
    assert.equal(svc.getAlternativeScriptNames('mystery', { foo: 'bar' }), null)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
