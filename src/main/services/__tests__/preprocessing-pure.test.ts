/**
 * Tests for preprocessing.service.ts pure functions — buildChunkHeader,
 * buildEmbedText, buildScopeContexts, buildScopeHeader, buildMetadata,
 * and the file-validation / import-extraction / chunk-splitting submodules.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'

import {
  buildChunkHeader,
  buildEmbedText,
  buildScopeContexts,
  buildScopeHeader,
  buildMetadata,
  DEFAULT_PREPROCESSING_OPTIONS,
  SKIP_PATTERNS,
  matchesSkipPattern,
  shouldSkipFile,
  extractRelevantImports,
  splitLongChunk
} from '../preprocessing.service'
import type { RawChunk, ProcessedChunk, ChunkMetadata } from '../preprocessing.service'

// ── Helper factories ──

const makeChunkMetadata = (overrides: Partial<ChunkMetadata> = {}): ChunkMetadata => ({
  filePath: 'src/utils.ts',
  fileName: 'utils.ts',
  directory: 'src',
  projectName: 'test-project',
  symbolName: 'helper',
  symbolKind: 'function',
  className: null,
  signature: 'function helper(): void',
  startLine: 10,
  endLine: 20,
  language: 'typescript',
  isPublic: true,
  isAsync: false,
  isStatic: false,
  isAbstract: false,
  hasTests: false,
  importedBy: [],
  pageRank: 0,
  hasDocstring: false,
  lineCount: 11,
  hasDescription: false,
  lastModified: 0,
  indexedAt: 0,
  ...overrides
})

const makeRawChunk = (overrides: Partial<RawChunk> = {}): RawChunk => ({
  id: 'chunk-1',
  filePath: 'src/app.ts',
  symbolName: 'myFunction',
  symbolKind: 'function',
  body: 'function myFunction() { return 42; }',
  startLine: 1,
  endLine: 10,
  signature: 'function myFunction(): number',
  isPublic: true,
  isAsync: false,
  isStatic: false,
  isAbstract: false,
  language: 'typescript',
  ...overrides
})

/** Extended chunk for buildChunkHeader */
const makeHeaderChunk = (overrides: Record<string, unknown> = {}) => ({
  ...makeRawChunk(),
  imports: [] as string[],
  className: null as string | null,
  ...overrides
})

describe('buildChunkHeader', () => {
  test('formats function header correctly', () => {
    const chunk = makeHeaderChunk({ filePath: 'src/utils.ts', symbolName: 'helper', symbolKind: 'function' })
    const header = buildChunkHeader(chunk as any)
    assert.ok(header.includes('utils.ts'))
    assert.ok(header.includes('function'))
    assert.ok(header.includes('helper'))
  })

  test('includes class name when present', () => {
    const chunk = makeHeaderChunk({ className: 'MyClass', symbolKind: 'method', symbolName: 'doWork' })
    const header = buildChunkHeader(chunk as any)
    assert.ok(header.includes('MyClass'))
  })

  test('includes signature', () => {
    const chunk = makeHeaderChunk({ signature: 'async getData(id: string): Promise<Data>' })
    const header = buildChunkHeader(chunk as any)
    assert.ok(header.includes('getData'))
  })

  test('includes imports in header', () => {
    const chunk = makeHeaderChunk({ imports: ['useState', 'useEffect'] })
    const header = buildChunkHeader(chunk as any)
    assert.ok(header.includes('useState'))
    assert.ok(header.includes('useEffect'))
  })
})

describe('buildEmbedText', () => {
  test('combines header and body', () => {
    const chunk = makeHeaderChunk({
      filePath: 'src/utils.ts',
      body: 'const x = 1'
    })
    const result = buildEmbedText(chunk as any)
    assert.ok(result.includes('utils.ts'))
    assert.ok(result.includes('const x = 1'))
  })
})

describe('buildScopeContexts', () => {
  test('builds scope map from file tags', () => {
    const tags: RawChunk[] = [
      makeRawChunk({ name: 'MyClass', kind: 'class', startLine: 1, endLine: 50 }),
      makeRawChunk({ name: 'doWork', kind: 'method', startLine: 5, endLine: 20 }),
      makeRawChunk({ name: 'cleanup', kind: 'method', startLine: 25, endLine: 35 })
    ]
    const scopes = buildScopeContexts(tags)
    assert.ok(scopes instanceof Map)
  })

  test('returns empty map for empty tags', () => {
    const scopes = buildScopeContexts([])
    assert.equal(scopes.size, 0)
  })
})

describe('buildScopeHeader', () => {
  test('generates scope context markdown', () => {
    const scope = {
      className: 'MyClass',
      classKind: 'class' as const,
      classSignature: 'class MyClass',
      classDecorators: ['@Injectable()'],
      parentClassImports: [],
      siblingMethodSignatures: ['methodA(): void', 'methodB(): string']
    }
    const header = buildScopeHeader(scope, true)
    assert.equal(typeof header, 'string')
    assert.ok(header.includes('MyClass'))
  })

  test('handles scope without decorators', () => {
    const scope = {
      className: 'SimpleClass',
      classKind: 'class' as const,
      classSignature: 'class SimpleClass',
      classDecorators: [],
      parentClassImports: [],
      siblingMethodSignatures: []
    }
    const header = buildScopeHeader(scope, false)
    assert.equal(typeof header, 'string')
  })
})

describe('buildMetadata', () => {
  test('constructs metadata from raw chunk', () => {
    const chunk = makeRawChunk({
      symbolName: 'processData',
      symbolKind: 'function',
      filePath: 'src/processor.ts',
      startLine: 10,
      endLine: 25,
      body: 'function processData() {\n  // ...\n}'
    })
    const meta = buildMetadata(chunk, null, 'test-project')
    assert.equal(meta.symbolName, 'processData')
    assert.equal(meta.symbolKind, 'function')
    assert.equal(meta.filePath, 'src/processor.ts')
    assert.equal(meta.startLine, 10)
    assert.equal(meta.endLine, 25)
    assert.equal(meta.projectName, 'test-project')
    assert.equal(meta.fileName, 'processor.ts')
    assert.equal(meta.directory, 'src')
  })

  test('preserves async flag from raw chunk', () => {
    const chunk = makeRawChunk({ isAsync: true })
    const meta = buildMetadata(chunk, null, 'test')
    assert.equal(meta.isAsync, true)
  })

  test('preserves public flag from raw chunk', () => {
    const chunk = makeRawChunk({ isPublic: true })
    const meta = buildMetadata(chunk, null, 'test')
    assert.equal(meta.isPublic, true)
  })

  test('detects test files', () => {
    const chunk = makeRawChunk({ filePath: 'src/__tests__/app.test.ts' })
    const meta = buildMetadata(chunk, null, 'test')
    assert.equal(meta.hasTests, true)
  })

  test('detects docstrings', () => {
    const chunk = makeRawChunk({ body: '/** JSDoc comment */\nfunction fn() {}' })
    const meta = buildMetadata(chunk, null, 'test')
    assert.equal(meta.hasDocstring, true)
  })
})

describe('DEFAULT_PREPROCESSING_OPTIONS', () => {
  test('has expected shape', () => {
    assert.ok('maxChunkLines' in DEFAULT_PREPROCESSING_OPTIONS)
    assert.ok('overlapLines' in DEFAULT_PREPROCESSING_OPTIONS)
    assert.equal(typeof DEFAULT_PREPROCESSING_OPTIONS.maxChunkLines, 'number')
    assert.equal(typeof DEFAULT_PREPROCESSING_OPTIONS.overlapLines, 'number')
  })
})

// ── File validation submodule ──

describe('SKIP_PATTERNS', () => {
  test('is non-empty array', () => {
    assert.ok(Array.isArray(SKIP_PATTERNS))
    assert.ok(SKIP_PATTERNS.length > 0)
  })

  test('contains common patterns', () => {
    const patterns = SKIP_PATTERNS.join(' ')
    assert.ok(patterns.includes('node_modules'))
    assert.ok(patterns.includes('dist'))
  })
})

describe('matchesSkipPattern', () => {
  test('matches node_modules path', () => {
    assert.equal(matchesSkipPattern('node_modules/pkg/index.ts', SKIP_PATTERNS), true)
  })

  test('matches dist output', () => {
    assert.equal(matchesSkipPattern('dist/bundle.js', SKIP_PATTERNS), true)
  })

  test('does not match regular source files', () => {
    assert.equal(matchesSkipPattern('src/app.ts', SKIP_PATTERNS), false)
  })

  test('matches build output directories', () => {
    assert.equal(matchesSkipPattern('build/output.js', SKIP_PATTERNS), true)
  })
})

describe('shouldSkipFile', () => {
  test('skips files matching skip patterns', () => {
    assert.equal(shouldSkipFile('node_modules/pkg/index.ts', 'content', SKIP_PATTERNS), true)
  })

  test('does not skip regular source files', () => {
    assert.equal(shouldSkipFile('src/app.ts', 'const x = 1;', SKIP_PATTERNS), false)
  })

  test('skips files with @generated marker', () => {
    assert.equal(shouldSkipFile('src/gen.ts', '// @generated\nconst x = 1;', SKIP_PATTERNS), true)
  })

  test('skips minified files (very long lines)', () => {
    const longLine = 'x'.repeat(1000)
    assert.equal(shouldSkipFile('src/min.js', longLine, SKIP_PATTERNS), true)
  })
})

// ── Import extraction submodule ──

describe('extractRelevantImports', () => {
  test('extracts imports used in chunk body', () => {
    const fileContent = `import { useState, useEffect } from 'react'\nimport { fetchData } from './api'`
    const chunk = { body: 'useState()' } as ProcessedChunk
    const imports = extractRelevantImports(fileContent, chunk)
    assert.ok(Array.isArray(imports))
  })

  test('returns empty array for no relevant imports', () => {
    const imports = extractRelevantImports('', { body: 'console.log()' } as ProcessedChunk)
    assert.deepEqual(imports, [])
  })
})

// ── Chunk splitting submodule ──

describe('splitLongChunk', () => {
  test('returns single chunk when under limit', () => {
    const chunk: ProcessedChunk = {
      id: 'test-1',
      body: 'line1\nline2\nline3',
      embedText: 'header',
      metadata: makeChunkMetadata({ lineCount: 3 })
    }
    const result = splitLongChunk(chunk, 100, 5)
    assert.equal(result.length, 1)
    assert.equal(result[0].id, 'test-1')
  })

  test('splits long chunk into multiple', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `  line ${i}`).join('\n')
    const chunk: ProcessedChunk = {
      id: 'long-1',
      body: lines,
      embedText: 'header',
      metadata: makeChunkMetadata({ lineCount: 200, startLine: 1, endLine: 200 })
    }
    const result = splitLongChunk(chunk, 80, 5)
    assert.ok(result.length > 1, `Expected multiple chunks, got ${result.length}`)
  })

  test('generates unique IDs for split chunks', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `  line ${i}`).join('\n')
    const chunk: ProcessedChunk = {
      id: 'split-id',
      body: lines,
      embedText: 'header',
      metadata: makeChunkMetadata({ lineCount: 200, startLine: 1, endLine: 200 })
    }
    const result = splitLongChunk(chunk, 80, 5)
    const ids = result.map((c) => c.id)
    const uniqueIds = new Set(ids)
    assert.equal(uniqueIds.size, ids.length, 'All chunk IDs should be unique')
  })
})
