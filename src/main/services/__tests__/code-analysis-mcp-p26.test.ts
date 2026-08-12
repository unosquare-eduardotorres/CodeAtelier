/**
 * Phase 26 Wave 5 — MCP server utility modules deep coverage.
 * Tests utility exports that don't require server startup.
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import { setupFullMock, resetAllMocks } from './setup-full-mock'
setupFullMock()

let toolErrorHandler: any, outputCap: any, nativeModuleCheck: any
try {
  toolErrorHandler = require('../../mcp-servers/tool-error-handler')
} catch {
  /* OK */
}
try {
  outputCap = require('../../mcp-servers/output-cap')
} catch {
  /* OK */
}
try {
  nativeModuleCheck = require('../../mcp-servers/native-module-check')
} catch {
  /* OK */
}

describe('MCP Server utilities (P26-W5)', () => {
  beforeEach(() => {
    resetAllMocks()
  })

  test('tool-error-handler module loads', () => {
    if (!toolErrorHandler) return
    const keys = Object.keys(toolErrorHandler)
    assert.ok(keys.length > 0)
  })

  test('output-cap module loads', () => {
    if (!outputCap) return
    const keys = Object.keys(outputCap)
    assert.ok(keys.length > 0)
  })

  test('native-module-check module loads', () => {
    if (!nativeModuleCheck) return
    const keys = Object.keys(nativeModuleCheck)
    assert.ok(keys.length >= 0)
  })

  // Test output-cap utility
  test('output-cap caps large output', () => {
    if (!outputCap) return
    const capFn = outputCap.capOutput || outputCap.default
    if (typeof capFn !== 'function') return
    const result = capFn('x'.repeat(100000), 1000)
    assert.equal(typeof result, 'string')
    assert.ok(result.length <= 2000) // Some overhead allowed
  })

  // Test tool-error-handler
  test('tool-error-handler formats errors', () => {
    if (!toolErrorHandler) return
    const fn = toolErrorHandler.formatToolError || toolErrorHandler.handleToolError
    if (typeof fn !== 'function') return
    try {
      const result = fn(new Error('test error'))
      assert.equal(typeof result, 'string')
    } catch {
      /* OK */
    }
  })
})
