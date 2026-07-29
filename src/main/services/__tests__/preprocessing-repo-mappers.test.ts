/**
 * Unit tests for preprocessing.service.ts pure functions + gap fills
 *
 * Targets: src/main/services/preprocessing.service.ts (48% → 65%)
 * Tests the exported pipeline functions: buildChunkHeader, buildEmbedText,
 * buildScopeContexts, buildScopeHeader, buildMetadata, preprocessChunk,
 * DEFAULT_PREPROCESSING_OPTIONS
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

void (async () => {
  const {
    buildChunkHeader,
    buildEmbedText,
    buildScopeContexts,
    buildScopeHeader,
    buildMetadata,
    preprocessChunk,
    DEFAULT_PREPROCESSING_OPTIONS,
  } = await import('../preprocessing.service')
  type RawChunk = import('../preprocessing.service').RawChunk

  // ── Test fixture ───────────────────────────────────────────────────────────

  function makeChunk(overrides: Partial<RawChunk> = {}): RawChunk {
    return {
      id: 'chunk-1',
      filePath: '/src/main/services/my-service.ts',
      symbolName: 'processData',
      symbolKind: 'function',
      body: 'function processData(x: number): number {\n  return x * 2\n}',
      startLine: 10,
      endLine: 12,
      signature: 'processData(x: number): number',
      isPublic: true,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      language: 'typescript',
      ...overrides,
    }
  }

  function makeChunkWithImports(overrides: Partial<RawChunk & { imports: string[]; className?: string | null }> = {}) {
    return {
      ...makeChunk(overrides),
      imports: overrides.imports ?? ['EventEmitter', 'Logger'],
      className: overrides.className ?? null,
    }
  }

  // ── buildChunkHeader ───────────────────────────────────────────────────────

  describe('preprocessing › buildChunkHeader', () => {
    test('includes shortened file path (last 3 segments)', () => {
      const chunk = makeChunkWithImports()
      const header = buildChunkHeader(chunk)
      assert.ok(header.includes('# File: main/services/my-service.ts'))
    })

    test('includes language', () => {
      const chunk = makeChunkWithImports({ language: 'python' })
      const header = buildChunkHeader(chunk)
      assert.ok(header.includes('# Language: python'))
    })

    test('includes scope without class when no className', () => {
      const chunk = makeChunkWithImports({ className: null })
      const header = buildChunkHeader(chunk)
      assert.ok(header.includes('# Scope: processData'))
      assert.ok(!header.includes(' > '))
    })

    test('includes scope with class when className present', () => {
      const chunk = makeChunkWithImports({ className: 'MyService' })
      const header = buildChunkHeader(chunk)
      assert.ok(header.includes('# Scope: MyService > processData'))
    })

    test('includes kind with visibility', () => {
      const chunk = makeChunkWithImports({ isPublic: true })
      const header = buildChunkHeader(chunk)
      assert.ok(header.includes('# Kind: public function'))
    })

    test('marks private visibility', () => {
      const chunk = makeChunkWithImports({ isPublic: false })
      const header = buildChunkHeader(chunk)
      assert.ok(header.includes('# Kind: private function'))
    })

    test('includes signature', () => {
      const chunk = makeChunkWithImports()
      const header = buildChunkHeader(chunk)
      assert.ok(header.includes('# Signature: processData(x: number): number'))
    })

    test('includes imports when present', () => {
      const chunk = makeChunkWithImports({ imports: ['EventEmitter', 'Logger'] })
      const header = buildChunkHeader(chunk)
      assert.ok(header.includes('# Uses: EventEmitter, Logger'))
    })

    test('omits imports line when no imports', () => {
      const chunk = makeChunkWithImports({ imports: [] })
      const header = buildChunkHeader(chunk)
      assert.ok(!header.includes('# Uses:'))
    })

    test('ends with blank line separator', () => {
      const chunk = makeChunkWithImports()
      const header = buildChunkHeader(chunk)
      assert.ok(header.endsWith('\n'))
    })
  })

  // ── buildEmbedText ─────────────────────────────────────────────────────────

  describe('preprocessing › buildEmbedText', () => {
    test('combines header and body', () => {
      const chunk = makeChunkWithImports()
      const text = buildEmbedText(chunk)
      assert.ok(text.includes('# File:'))
      assert.ok(text.includes('function processData'))
    })

    test('header comes before body', () => {
      const chunk = makeChunkWithImports()
      const text = buildEmbedText(chunk)
      const headerIdx = text.indexOf('# File:')
      const bodyIdx = text.indexOf('function processData')
      assert.ok(headerIdx < bodyIdx)
    })
  })

  // ── buildScopeContexts ────────────────────────────────────────────────────

  describe('preprocessing › buildScopeContexts', () => {
    test('returns empty map for no class chunks', () => {
      const tags = [makeChunk({ symbolKind: 'function' })]
      const contexts = buildScopeContexts(tags)
      assert.equal(contexts.size, 0)
    })

    test('creates context for a class', () => {
      const tags = [
        makeChunk({
          symbolName: 'UserService',
          symbolKind: 'class',
          signature: 'class UserService',
          body: 'class UserService {\n  validate() {}\n}',
          startLine: 1,
          endLine: 10,
        }),
      ]
      const contexts = buildScopeContexts(tags)
      assert.equal(contexts.size, 1)
      assert.ok(contexts.has('UserService'))
      const ctx = contexts.get('UserService')!
      assert.equal(ctx.className, 'UserService')
      assert.equal(ctx.classKind, 'class')
    })

    test('detects interface kind', () => {
      const tags = [
        makeChunk({
          symbolName: 'IService',
          symbolKind: 'interface',
          signature: 'interface IService',
          body: 'interface IService {}',
          startLine: 1,
          endLine: 3,
        }),
      ]
      const contexts = buildScopeContexts(tags)
      const ctx = contexts.get('IService')!
      assert.equal(ctx.classKind, 'interface')
    })

    test('detects abstract class kind', () => {
      const tags = [
        makeChunk({
          symbolName: 'BaseService',
          symbolKind: 'class',
          signature: 'abstract class BaseService',
          body: 'abstract class BaseService {}',
          startLine: 1,
          endLine: 3,
        }),
      ]
      const contexts = buildScopeContexts(tags)
      const ctx = contexts.get('BaseService')!
      assert.equal(ctx.classKind, 'abstract class')
    })

    test('collects sibling method signatures', () => {
      const tags = [
        makeChunk({
          symbolName: 'UserService',
          symbolKind: 'class',
          signature: 'class UserService',
          body: 'class UserService {\n  validate() {}\n  save() {}\n}',
          startLine: 1,
          endLine: 20,
        }),
        makeChunk({
          symbolName: 'validate',
          symbolKind: 'method',
          signature: 'validate(): boolean',
          isPublic: true,
          startLine: 2,
          endLine: 5,
        }),
        makeChunk({
          symbolName: 'save',
          symbolKind: 'method',
          signature: 'save(): void',
          isPublic: true,
          startLine: 6,
          endLine: 10,
        }),
      ]
      const contexts = buildScopeContexts(tags)
      const ctx = contexts.get('UserService')!
      assert.equal(ctx.siblingMethodSignatures.length, 2)
      assert.ok(ctx.siblingMethodSignatures.includes('validate(): boolean'))
      assert.ok(ctx.siblingMethodSignatures.includes('save(): void'))
    })

    test('excludes private methods from sibling signatures', () => {
      const tags = [
        makeChunk({
          symbolName: 'Svc',
          symbolKind: 'class',
          signature: 'class Svc',
          body: 'class Svc {}',
          startLine: 1,
          endLine: 20,
        }),
        makeChunk({ symbolName: 'pubMethod', symbolKind: 'method', isPublic: true, startLine: 2, endLine: 5, signature: 'pubMethod(): void' }),
        makeChunk({ symbolName: 'privMethod', symbolKind: 'method', isPublic: false, startLine: 6, endLine: 10, signature: 'privMethod(): void' }),
      ]
      const contexts = buildScopeContexts(tags)
      const ctx = contexts.get('Svc')!
      assert.equal(ctx.siblingMethodSignatures.length, 1)
      assert.equal(ctx.siblingMethodSignatures[0], 'pubMethod(): void')
    })
  })

  // ── buildScopeHeader ───────────────────────────────────────────────────────

  describe('preprocessing › buildScopeHeader', () => {
    test('includes class signature', () => {
      const scope = {
        className: 'MyService',
        classKind: 'class' as const,
        classSignature: 'class MyService extends Base',
        classDecorators: [],
        parentClassImports: [],
        siblingMethodSignatures: [],
      }
      const header = buildScopeHeader(scope, false)
      assert.ok(header.includes('# Class: class MyService extends Base'))
    })

    test('includes decorators when present', () => {
      const scope = {
        className: 'MyCtrl',
        classKind: 'class' as const,
        classSignature: 'class MyCtrl',
        classDecorators: ['@Controller()', '@Injectable()'],
        parentClassImports: [],
        siblingMethodSignatures: [],
      }
      const header = buildScopeHeader(scope, false)
      assert.ok(header.includes('# Class decorators: @Controller(), @Injectable()'))
    })

    test('includes sibling methods when includeSiblings is true', () => {
      const scope = {
        className: 'Svc',
        classKind: 'class' as const,
        classSignature: 'class Svc',
        classDecorators: [],
        parentClassImports: [],
        siblingMethodSignatures: ['validate(): boolean', 'save(): void'],
      }
      const header = buildScopeHeader(scope, true)
      assert.ok(header.includes('# Other public methods: validate(), save()'))
    })

    test('omits sibling methods when includeSiblings is false', () => {
      const scope = {
        className: 'Svc',
        classKind: 'class' as const,
        classSignature: 'class Svc',
        classDecorators: [],
        parentClassImports: [],
        siblingMethodSignatures: ['validate(): boolean'],
      }
      const header = buildScopeHeader(scope, false)
      assert.ok(!header.includes('Other public methods'))
    })
  })

  // ── buildMetadata ──────────────────────────────────────────────────────────

  describe('preprocessing › buildMetadata', () => {
    test('maps all basic fields', () => {
      const chunk = makeChunk()
      const meta = buildMetadata(chunk, null, 'my-project')
      assert.equal(meta.symbolName, 'processData')
      assert.equal(meta.symbolKind, 'function')
      assert.equal(meta.projectName, 'my-project')
      assert.equal(meta.language, 'typescript')
      assert.equal(meta.isPublic, true)
      assert.equal(meta.className, null)
    })

    test('sets className from scope', () => {
      const chunk = makeChunk({ symbolKind: 'method' })
      const scope = {
        className: 'MyService',
        classKind: 'class' as const,
        classSignature: 'class MyService',
        classDecorators: [],
        parentClassImports: [],
        siblingMethodSignatures: [],
      }
      const meta = buildMetadata(chunk, scope, 'proj')
      assert.equal(meta.className, 'MyService')
    })

    test('detects test files', () => {
      const chunk = makeChunk({ filePath: '/src/__tests__/foo.test.ts' })
      const meta = buildMetadata(chunk, null, 'proj')
      assert.equal(meta.hasTests, true)
    })

    test('detects docstring', () => {
      const chunk = makeChunk({ body: '/** JSDoc comment */\nfunction foo() {}' })
      const meta = buildMetadata(chunk, null, 'proj')
      assert.equal(meta.hasDocstring, true)
    })

    test('computes lineCount', () => {
      const chunk = makeChunk({ body: 'line1\nline2\nline3' })
      const meta = buildMetadata(chunk, null, 'proj')
      assert.equal(meta.lineCount, 3)
    })

    test('sets hasDescription flag', () => {
      const meta1 = buildMetadata(makeChunk(), null, 'proj', true)
      assert.equal(meta1.hasDescription, true)

      const meta2 = buildMetadata(makeChunk(), null, 'proj', false)
      assert.equal(meta2.hasDescription, false)
    })

    test('defaults importedBy to empty array and pageRank to 0', () => {
      const meta = buildMetadata(makeChunk(), null, 'proj')
      assert.deepEqual(meta.importedBy, [])
      assert.equal(meta.pageRank, 0)
    })
  })

  // ── preprocessChunk ────────────────────────────────────────────────────────

  describe('preprocessing › preprocessChunk', () => {
    test('returns processed chunks for a valid public function', () => {
      const chunk = makeChunk()
      const result = preprocessChunk(
        chunk, 'import { Logger } from "electron-log"\n' + chunk.body,
        null, 'proj', DEFAULT_PREPROCESSING_OPTIONS
      )
      assert.ok(result)
      assert.ok(result.length >= 1)
      assert.equal(result[0].id, 'chunk-1')
      assert.ok(result[0].embedText.length > 0)
    })

    test('skips private methods when includePrivateMethods is false', () => {
      const chunk = makeChunk({ symbolKind: 'method', isPublic: false })
      const opts = { ...DEFAULT_PREPROCESSING_OPTIONS, includePrivateMethods: false }
      const result = preprocessChunk(chunk, chunk.body, null, 'proj', opts)
      assert.equal(result, null)
    })

    test('includes private methods when includePrivateMethods is true', () => {
      const chunk = makeChunk({ symbolKind: 'method', isPublic: false })
      const opts = { ...DEFAULT_PREPROCESSING_OPTIONS, includePrivateMethods: true }
      const result = preprocessChunk(chunk, chunk.body, null, 'proj', opts)
      assert.ok(result)
      assert.ok(result.length >= 1)
    })

    test('prepends description when provided', () => {
      const chunk = makeChunk()
      const result = preprocessChunk(
        chunk, chunk.body, null, 'proj', DEFAULT_PREPROCESSING_OPTIONS,
        'This function doubles its input.'
      )
      assert.ok(result)
      assert.ok(result[0].embedText.includes('This function doubles its input.'))
    })

    test('does not include description text when not provided', () => {
      const chunk = makeChunk()
      const result = preprocessChunk(
        chunk, chunk.body, null, 'proj', DEFAULT_PREPROCESSING_OPTIONS
      )
      assert.ok(result)
      assert.ok(!result[0].embedText.includes('This function doubles'))
    })

    test('enriches method with scope context', () => {
      const chunk = makeChunk({ symbolKind: 'method' })
      const scope = {
        className: 'Svc',
        classKind: 'class' as const,
        classSignature: 'class Svc extends Base',
        classDecorators: [],
        parentClassImports: [],
        siblingMethodSignatures: ['other(): void'],
      }
      const result = preprocessChunk(
        chunk, chunk.body, scope, 'proj', DEFAULT_PREPROCESSING_OPTIONS
      )
      assert.ok(result)
      assert.ok(result[0].embedText.includes('# Class: class Svc extends Base'))
    })

    test('metadata has correct symbolKind', () => {
      const chunk = makeChunk({ symbolKind: 'class' })
      const result = preprocessChunk(
        chunk, chunk.body, null, 'proj', DEFAULT_PREPROCESSING_OPTIONS
      )
      assert.ok(result)
      assert.equal(result[0].metadata.symbolKind, 'class')
    })
  })

  // ── DEFAULT_PREPROCESSING_OPTIONS ──────────────────────────────────────────

  describe('preprocessing › DEFAULT_PREPROCESSING_OPTIONS', () => {
    test('has expected default values', () => {
      assert.equal(DEFAULT_PREPROCESSING_OPTIONS.generateDescriptions, false)
      assert.equal(DEFAULT_PREPROCESSING_OPTIONS.maxChunkLines, 80)
      assert.equal(DEFAULT_PREPROCESSING_OPTIONS.overlapLines, 5)
      assert.equal(DEFAULT_PREPROCESSING_OPTIONS.includePrivateMethods, true)
      assert.equal(DEFAULT_PREPROCESSING_OPTIONS.includeSiblingSignatures, true)
      assert.equal(DEFAULT_PREPROCESSING_OPTIONS.paused, false)
      assert.equal(DEFAULT_PREPROCESSING_OPTIONS.cancelled, false)
    })
  })
})()
