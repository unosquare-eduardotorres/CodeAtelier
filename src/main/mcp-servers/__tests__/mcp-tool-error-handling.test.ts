/**
 * Tests that MCP tool handlers properly report errors with isError: true.
 *
 * These tests verify the contract: when a tool encounters an error
 * (ABI mismatch, DB failure, etc.), it MUST return { isError: true }
 * so the MCP client treats it as a failure, not a success.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './../../services/__tests__/test-harness'
import { withErrorBoundary } from '../tool-error-handler'

describe('MCP tool error boundary', () => {
  test('successful handler returns result without isError', async () => {
    const handler = withErrorBoundary('test_tool', async () => ({
      content: [{ type: 'text' as const, text: 'success' }]
    }))
    const result = await handler({})
    assert.equal(result.isError, undefined)
    assert.equal(result.content[0].text, 'success')
  })

  test('thrown Error returns isError: true with error message', async () => {
    const handler = withErrorBoundary('test_tool', async () => {
      throw new Error('better-sqlite3 ABI mismatch')
    })
    const result = await handler({})
    assert.equal(result.isError, true)
    assert.ok(result.content[0].text.includes('ABI mismatch'))
    assert.ok(result.content[0].text.includes('[test_tool]'))
  })

  test('non-Error throw returns isError: true with stringified message', async () => {
    const handler = withErrorBoundary('test_tool', async () => {
      throw 'string error'
    })
    const result = await handler({})
    assert.equal(result.isError, true)
    assert.ok(result.content[0].text.includes('string error'))
  })

  test('handler arguments are passed through correctly', async () => {
    const handler = withErrorBoundary('test_tool', async (args: { query: string }) => ({
      content: [{ type: 'text' as const, text: `searched: ${args.query}` }]
    }))
    const result = await handler({ query: 'hello' })
    assert.equal(result.isError, undefined)
    assert.equal(result.content[0].text, 'searched: hello')
  })

  test('error response content has correct type field', async () => {
    const handler = withErrorBoundary('test_tool', async () => {
      throw new Error('db locked')
    })
    const result = await handler({})
    assert.equal(result.content.length, 1)
    assert.equal(result.content[0].type, 'text')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
