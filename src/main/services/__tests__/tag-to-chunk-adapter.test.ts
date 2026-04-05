/**
 * Unit tests for the tag-to-chunk-adapter.
 * Tests the bridge between repomap's tree-sitter tag output and RawChunk[] for preprocessing.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  convertTagsToChunks,
  findSymbolEnd,
  inferSymbolKind,
  inferLanguage,
  inferVisibility,
  extractSignature,
  type RepomapTag
} from '../tag-to-chunk-adapter'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  \u2713 ${name}`)
    passed++
  } catch (err) {
    console.error(`  \u2717 ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

function describe(name: string, fn: () => void): void {
  console.log(`\n${name}`)
  fn()
}

// ── inferSymbolKind ──

describe('inferSymbolKind', () => {
  test('identifies class', () => {
    assert.equal(inferSymbolKind('export class UserService {'), 'class')
  })

  test('identifies interface', () => {
    assert.equal(inferSymbolKind('export interface UserProfile {'), 'interface')
  })

  test('identifies type', () => {
    assert.equal(inferSymbolKind('export type UserId = string'), 'type')
  })

  test('identifies enum', () => {
    assert.equal(inferSymbolKind('enum Status {'), 'enum')
  })

  test('identifies const', () => {
    assert.equal(inferSymbolKind('export const MAX_RETRIES = 3'), 'const')
  })

  test('identifies function', () => {
    assert.equal(inferSymbolKind('export function helperFunction(input: string): string {'), 'function')
  })

  test('defaults to method for unrecognized patterns', () => {
    assert.equal(inferSymbolKind('  async getUser(id: string): Promise<User> {'), 'method')
  })
})

// ── inferLanguage ──

describe('inferLanguage', () => {
  test('maps .ts to typescript', () => {
    assert.equal(inferLanguage('src/services/auth.service.ts'), 'typescript')
  })

  test('maps .tsx to tsx', () => {
    assert.equal(inferLanguage('src/components/App.tsx'), 'tsx')
  })

  test('maps .js to javascript', () => {
    assert.equal(inferLanguage('src/utils/helper.js'), 'javascript')
  })

  test('maps .jsx to jsx', () => {
    assert.equal(inferLanguage('src/components/Button.jsx'), 'jsx')
  })

  test('maps .cs to csharp', () => {
    assert.equal(inferLanguage('Services/AuthService.cs'), 'csharp')
  })

  test('maps .py to python', () => {
    assert.equal(inferLanguage('scripts/main.py'), 'python')
  })

  test('returns unknown for unrecognized extensions', () => {
    assert.equal(inferLanguage('data/config.yaml'), 'unknown')
  })
})

// ── inferVisibility ──

describe('inferVisibility', () => {
  test('private keyword returns false', () => {
    assert.equal(inferVisibility('  private db: Database'), false)
  })

  test('protected keyword returns false', () => {
    assert.equal(inferVisibility('  protected logger: Logger'), false)
  })

  test('JS private field (#) returns false', () => {
    assert.equal(inferVisibility('  #internalState = null'), false)
  })

  test('public method returns true', () => {
    assert.equal(inferVisibility('  async getUser(id: string): Promise<User> {'), true)
  })

  test('export function returns true', () => {
    assert.equal(inferVisibility('export function helperFunction(input: string): string {'), true)
  })
})

// ── extractSignature ──

describe('extractSignature', () => {
  test('extracts text before opening brace', () => {
    assert.equal(
      extractSignature('  async getUser(id: string): Promise<User> {'),
      'async getUser(id: string): Promise<User>'
    )
  })

  test('returns full trimmed line when no brace', () => {
    assert.equal(
      extractSignature('  export const MAX_RETRIES = 3'),
      'export const MAX_RETRIES = 3'
    )
  })

  test('handles class declaration', () => {
    assert.equal(
      extractSignature('export class UserService {'),
      'export class UserService'
    )
  })
})

// ── findSymbolEnd ──

describe('findSymbolEnd', () => {
  test('finds closing brace via depth tracking', () => {
    const lines = [
      'function add(a: number, b: number): number {',
      '  return a + b',
      '}'
    ]
    assert.equal(findSymbolEnd(lines, 0, lines.length), 3)
  })

  test('handles nested braces', () => {
    const lines = [
      'function complex() {',
      '  if (true) {',
      '    return 1',
      '  }',
      '  return 0',
      '}'
    ]
    assert.equal(findSymbolEnd(lines, 0, lines.length), 6)
  })

  test('returns maxEnd when no braces found', () => {
    const lines = [
      'export const MAX = 3',
      'export const MIN = 1'
    ]
    assert.equal(findSymbolEnd(lines, 0, 1), 1)
  })

  test('respects maxEnd boundary', () => {
    const lines = [
      'function a() {',
      '  return 1',
      '}',
      'function b() {',
      '  return 2',
      '}'
    ]
    // Should stop at maxEnd=3 (before function b)
    assert.equal(findSymbolEnd(lines, 0, 3), 3)
  })
})

// ── convertTagsToChunks (integration with fixture file) ──

describe('convertTagsToChunks', () => {
  const fixturesPath = join(__dirname, 'fixtures')

  test('filters out ref tags — only def tags produce chunks', () => {
    const tags: RepomapTag[] = [
      { relFname: 'sample.ts', fname: join(fixturesPath, 'sample.ts'), line: 1, name: 'UserService', kind: 'def' },
      { relFname: 'sample.ts', fname: join(fixturesPath, 'sample.ts'), line: 9, name: 'getUser', kind: 'def' },
      { relFname: 'sample.ts', fname: join(fixturesPath, 'sample.ts'), line: 9, name: 'Database', kind: 'ref' }
    ]

    const { chunks } = convertTagsToChunks(tags, fixturesPath)
    // The ref tag for 'Database' should not produce a chunk
    const names = chunks.map((c) => c.symbolName)
    assert.ok(!names.includes('Database'), 'ref tags should be filtered out')
    assert.ok(names.includes('UserService'), 'def tag UserService should be included')
    assert.ok(names.includes('getUser'), 'def tag getUser should be included')
  })

  test('groups by file — reads file once per group', () => {
    const tags: RepomapTag[] = [
      { relFname: 'sample.ts', fname: join(fixturesPath, 'sample.ts'), line: 1, name: 'UserService', kind: 'def' },
      { relFname: 'sample.ts', fname: join(fixturesPath, 'sample.ts'), line: 18, name: 'helperFunction', kind: 'def' }
    ]

    const { chunks, fileContents } = convertTagsToChunks(tags, fixturesPath)
    assert.equal(chunks.length, 2)
    // Should only have one file entry
    assert.equal(fileContents.size, 1)
    assert.ok(fileContents.has('sample.ts'))
  })

  test('returns fileContents map with entries for processed files', () => {
    const tags: RepomapTag[] = [
      { relFname: 'sample.ts', fname: join(fixturesPath, 'sample.ts'), line: 1, name: 'UserService', kind: 'def' }
    ]

    const { fileContents } = convertTagsToChunks(tags, fixturesPath)
    assert.equal(fileContents.size, 1)
    const content = fileContents.get('sample.ts')
    assert.ok(content && content.includes('export class UserService'), 'file content should contain UserService')
  })

  test('skips files that cannot be read', () => {
    const tags: RepomapTag[] = [
      { relFname: 'nonexistent.ts', fname: join(fixturesPath, 'nonexistent.ts'), line: 1, name: 'Foo', kind: 'def' }
    ]

    const { chunks, fileContents } = convertTagsToChunks(tags, fixturesPath)
    assert.equal(chunks.length, 0)
    assert.equal(fileContents.size, 0)
  })
})

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`)
console.log(`tag-to-chunk-adapter: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
