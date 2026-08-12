/**
 * Unit tests for heuristic-description.service.ts — pure pattern-matching descriptions.
 *
 * Tests generateHeuristicDescription and generateHeuristicDescriptionBatch.
 * 100% pure functions — no I/O, no dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  generateHeuristicDescription,
  generateHeuristicDescriptionBatch
} from '../heuristic-description.service'
import type { RawChunk } from '../preprocessing.service'

// ── Helper ──

function makeChunk(overrides: Partial<RawChunk> = {}): RawChunk {
  return {
    id: 'chunk-1',
    filePath: 'src/app.ts',
    symbolName: 'myFunction',
    symbolKind: 'function',
    body: 'function myFunction() {}',
    startLine: 1,
    endLine: 1,
    signature: 'function myFunction(): void',
    isPublic: true,
    isAsync: false,
    isStatic: false,
    isAbstract: false,
    language: 'typescript',
    ...overrides
  }
}

describe('generateHeuristicDescription', () => {
  // ── Constants & Enums ──

  test('const_produces_configuration_constant_description', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'MAX_RETRY_COUNT',
        symbolKind: 'const'
      })
    )
    assert.ok(result.includes('Configuration constant'))
  })

  test('enum_produces_enumeration_description', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'Color',
        symbolKind: 'enum'
      })
    )
    assert.ok(result.includes('Enumeration'))
  })

  // ── Interfaces ──

  test('interface_with_props_suffix', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'ButtonProps',
        symbolKind: 'interface'
      })
    )
    assert.ok(result.length > 0)
    assert.ok(result.toLowerCase().includes('button'))
  })

  test('interface_with_config_suffix', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'AppConfig',
        symbolKind: 'interface'
      })
    )
    assert.ok(result.length > 0)
  })

  test('interface_generic', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'UserAccount',
        symbolKind: 'interface'
      })
    )
    assert.ok(result.toLowerCase().includes('user'))
  })

  // ── Types ──

  test('type_alias_description', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'ApiResponse',
        symbolKind: 'type'
      })
    )
    assert.ok(result.includes('Type alias'))
    assert.ok(result.toLowerCase().includes('api'))
  })

  // ── Classes ──

  test('class_with_service_suffix', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'UserService',
        symbolKind: 'class'
      })
    )
    assert.ok(result.toLowerCase().includes('service'))
  })

  test('class_with_controller_suffix', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'AuthController',
        symbolKind: 'class'
      })
    )
    assert.ok(result.toLowerCase().includes('controller') || result.toLowerCase().includes('auth'))
  })

  test('class_with_repository_suffix', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'UserRepository',
        symbolKind: 'class'
      })
    )
    assert.ok(result.toLowerCase().includes('repository') || result.toLowerCase().includes('user'))
  })

  test('class_generic', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'DataProcessor',
        symbolKind: 'class'
      })
    )
    assert.ok(result.length > 0)
  })

  // ── Functions with known verbs ──

  test('get_verb_produces_retrieves', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'getUserProfile',
        signature: 'function getUserProfile(userId: string): User'
      })
    )
    assert.ok(result.startsWith('Retrieves'))
    assert.ok(result.toLowerCase().includes('user profile'))
  })

  test('fetch_verb_produces_fetches', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'fetchData',
        signature: 'async function fetchData(): Promise<Data>',
        isAsync: true
      })
    )
    assert.ok(result.startsWith('Fetches'))
  })

  test('create_verb_produces_creates', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'createSession',
        signature: 'function createSession(): Session'
      })
    )
    assert.ok(result.startsWith('Creates'))
  })

  test('delete_verb_produces_deletes', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'deleteRecord',
        signature: 'function deleteRecord(id: string): void'
      })
    )
    assert.ok(result.startsWith('Deletes'))
  })

  test('validate_verb_produces_validates', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'validateInput',
        signature: 'function validateInput(data: unknown): boolean'
      })
    )
    assert.ok(result.startsWith('Validates'))
  })

  test('parse_verb_produces_parses', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'parseConfig',
        signature: 'function parseConfig(raw: string): Config'
      })
    )
    assert.ok(result.startsWith('Parses'))
  })

  test('is_verb_produces_checks_whether', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'isValid',
        signature: 'function isValid(): boolean'
      })
    )
    assert.ok(result.includes('Checks whether'))
  })

  test('has_verb_produces_checks_whether', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'hasPermission',
        signature: 'function hasPermission(role: string): boolean'
      })
    )
    assert.ok(result.includes('Checks whether'))
  })

  // ── Async marker ──

  test('async_non_fetch_adds_async_marker', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'processQueue',
        signature: 'async function processQueue(): Promise<void>',
        isAsync: true
      })
    )
    assert.ok(result.includes('(async)'))
  })

  test('async_fetch_does_not_add_redundant_async_marker', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'fetchUsers',
        signature: 'async function fetchUsers(): Promise<User[]>',
        isAsync: true
      })
    )
    assert.ok(!result.includes('(async)'))
  })

  // ── Return type suffix ──

  test('return_type_included_in_description', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: 'getUser',
        signature: 'function getUser(id: string): User'
      })
    )
    assert.ok(result.includes('User'))
  })

  // ── Fallback ──

  test('unknown_symbol_falls_back_to_kind_and_name', () => {
    const result = generateHeuristicDescription(
      makeChunk({
        symbolName: '',
        symbolKind: 'function',
        filePath: 'src/parser.ts'
      })
    )
    assert.ok(result.length > 0)
  })
})

describe('generateHeuristicDescriptionBatch', () => {
  test('processes_batch_and_returns_map', () => {
    const chunks = [
      {
        chunk: makeChunk({ symbolName: 'getUserName', signature: 'function getUserName(): string' })
      },
      { chunk: makeChunk({ symbolName: 'MAX_SIZE', symbolKind: 'const' as const }) }
    ]
    const results = generateHeuristicDescriptionBatch(chunks)
    assert.equal(results.size, 2)
    assert.ok(results.get(0)!.startsWith('Retrieves'))
    assert.ok(results.get(1)!.includes('Configuration constant'))
  })

  test('empty_batch_returns_empty_map', () => {
    const results = generateHeuristicDescriptionBatch([])
    assert.equal(results.size, 0)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
