/**
 * Unit tests for heuristic-description.service.ts — fallback + batch processing.
 *
 * Phase 6B Coverage Improvement — lines 506-509 (fallbackDescription), 518-526 (batch).
 * All pure string logic, zero I/O.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  generateHeuristicDescription,
  generateHeuristicDescriptionBatch
} from '../heuristic-description.service'
import type { RawChunk } from '../preprocessing.service'

function chunk(overrides: Partial<RawChunk> = {}): RawChunk {
  return {
    id: 'test-1',
    filePath: 'src/services/test.ts',
    symbolName: 'testFunc',
    symbolKind: 'function',
    body: '',
    startLine: 1,
    endLine: 5,
    signature: 'function testFunc(): void',
    isPublic: true,
    isAsync: false,
    isStatic: false,
    isAbstract: false,
    language: 'typescript',
    ...overrides
  }
}

// ── generateHeuristicDescription — fallback paths ──

describe('generateHeuristicDescription — verb-based descriptions', () => {
  test('getUser → retrieval verb', () => {
    const result = generateHeuristicDescription(
      chunk({ symbolName: 'getUser', signature: 'function getUser(): User' })
    )
    assert.ok(result.toLowerCase().includes('retriev') || result.toLowerCase().includes('get'))
  })

  test('saveData → mutation verb', () => {
    const result = generateHeuristicDescription(
      chunk({ symbolName: 'saveData', signature: 'function saveData(): void' })
    )
    assert.ok(result.toLowerCase().includes('sav'))
  })

  test('deleteRecord → deletion verb', () => {
    const result = generateHeuristicDescription(
      chunk({ symbolName: 'deleteRecord', signature: 'function deleteRecord(): void' })
    )
    assert.ok(result.toLowerCase().includes('delet'))
  })

  test('isValid → validation verb', () => {
    const result = generateHeuristicDescription(
      chunk({ symbolName: 'isValid', signature: 'function isValid(): boolean' })
    )
    assert.ok(result.toLowerCase().includes('check') || result.toLowerCase().includes('valid'))
  })

  test('createDocument → creation verb', () => {
    const result = generateHeuristicDescription(
      chunk({ symbolName: 'createDocument', signature: 'function createDocument(): void' })
    )
    assert.ok(result.toLowerCase().includes('creat'))
  })
})

describe('generateHeuristicDescription — kind-based descriptions', () => {
  test('class with "Service" in name', () => {
    const result = generateHeuristicDescription(
      chunk({
        symbolName: 'AuthService',
        symbolKind: 'class',
        signature: 'class AuthService'
      })
    )
    assert.ok(result.toLowerCase().includes('service') || result.toLowerCase().includes('auth'))
  })

  test('interface with "Props" in name', () => {
    const result = generateHeuristicDescription(
      chunk({
        symbolName: 'UserProps',
        symbolKind: 'interface',
        signature: 'interface UserProps'
      })
    )
    assert.ok(result.toLowerCase().includes('props') || result.toLowerCase().includes('user'))
  })

  test('enum description', () => {
    const result = generateHeuristicDescription(
      chunk({
        symbolName: 'StatusCode',
        symbolKind: 'enum',
        signature: 'enum StatusCode'
      })
    )
    assert.ok(result.length > 0)
    assert.ok(result.toLowerCase().includes('status'))
  })

  test('type alias description', () => {
    const result = generateHeuristicDescription(
      chunk({
        symbolName: 'UserRole',
        symbolKind: 'type',
        signature: 'type UserRole = string'
      })
    )
    assert.ok(result.length > 0)
  })

  test('const description', () => {
    const result = generateHeuristicDescription(
      chunk({
        symbolName: 'MAX_RETRIES',
        symbolKind: 'const',
        signature: 'const MAX_RETRIES = 3'
      })
    )
    assert.ok(result.length > 0)
    assert.ok(result.toLowerCase().includes('max') || result.toLowerCase().includes('retr'))
  })
})

describe('generateHeuristicDescription — return type suffix', () => {
  test('boolean return → includes boolean result', () => {
    const result = generateHeuristicDescription(
      chunk({
        symbolName: 'isActive',
        signature: 'function isActive(): boolean'
      })
    )
    assert.ok(result.toLowerCase().includes('boolean'))
  })

  test('string return → includes string', () => {
    const result = generateHeuristicDescription(
      chunk({
        symbolName: 'getName',
        signature: 'function getName(): string'
      })
    )
    assert.ok(result.toLowerCase().includes('string'))
  })

  test('array return → includes items', () => {
    const result = generateHeuristicDescription(
      chunk({
        symbolName: 'getUsers',
        signature: 'function getUsers(): User[]'
      })
    )
    assert.ok(result.toLowerCase().includes('item') || result.toLowerCase().includes('user'))
  })
})

describe('generateHeuristicDescription — parameter context', () => {
  test('userId parameter → by user id', () => {
    const result = generateHeuristicDescription(
      chunk({
        symbolName: 'getUser',
        signature: 'function getUser(userId: string): User'
      })
    )
    assert.ok(result.toLowerCase().includes('user'))
  })

  test('filePath parameter → file path context', () => {
    const result = generateHeuristicDescription(
      chunk({
        symbolName: 'readFile',
        signature: 'function readFile(filePath: string): string'
      })
    )
    assert.ok(result.toLowerCase().includes('file'))
  })
})

// ── generateHeuristicDescriptionBatch ──

describe('generateHeuristicDescriptionBatch', () => {
  test('empty batch → empty map', () => {
    const result = generateHeuristicDescriptionBatch([])
    assert.equal(result.size, 0)
  })

  test('single chunk → map with key 0', () => {
    const result = generateHeuristicDescriptionBatch([{ chunk: chunk({ symbolName: 'getUser' }) }])
    assert.equal(result.size, 1)
    assert.ok(result.has(0))
    assert.ok(result.get(0)!.length > 0)
  })

  test('multiple chunks → correct index mapping', () => {
    const chunks = [
      { chunk: chunk({ symbolName: 'getUser', signature: 'function getUser(): void' }) },
      { chunk: chunk({ symbolName: 'saveData', signature: 'function saveData(): void' }) },
      {
        chunk: chunk({
          symbolName: 'AuthService',
          symbolKind: 'class' as const,
          signature: 'class AuthService'
        })
      }
    ]
    const result = generateHeuristicDescriptionBatch(chunks)
    assert.equal(result.size, 3)
    assert.ok(result.has(0))
    assert.ok(result.has(1))
    assert.ok(result.has(2))
    // Each description should be non-empty
    for (const [, desc] of result) {
      assert.ok(desc.length > 0)
    }
  })

  test('descriptions match individual calls', () => {
    const c = chunk({ symbolName: 'deleteFile', signature: 'function deleteFile(): void' })
    const batchResult = generateHeuristicDescriptionBatch([{ chunk: c }])
    const singleResult = generateHeuristicDescription(c)
    assert.equal(batchResult.get(0), singleResult)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
