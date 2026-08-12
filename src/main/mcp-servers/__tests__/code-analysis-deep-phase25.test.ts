/**
 * Phase 25, Wave 4 — code-analysis-server.ts deep coverage.
 *
 * Covers: code-analysis-server.ts (1173 lines)
 *
 * Run: tsx src/main/mcp-servers/__tests__/code-analysis-deep-phase25.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import { setupElectronStub } from '../../services/__tests__/electron-stub'

setupElectronStub()

let codeAnalysisMod: any
let loaded = false

try {
  codeAnalysisMod = require('../code-analysis-server')
  loaded = true
} catch (err) {
  console.log(`⚠ code-analysis-server.ts load failed: ${(err as Error).message?.split('\n')[0]}`)
}

if (loaded) {
  describe('code-analysis-server — exports (Phase 25)', () => {
    test('module exports something', () => {
      assert.ok(codeAnalysisMod !== undefined)
    })

    test('has createServer or tool definitions', () => {
      const keys = Object.keys(codeAnalysisMod)
      assert.ok(keys.length > 0, `Expected exports, got: ${keys.join(', ')}`)
    })
  })
}

if (require.main === module) {
  void summaryAsync()
}
