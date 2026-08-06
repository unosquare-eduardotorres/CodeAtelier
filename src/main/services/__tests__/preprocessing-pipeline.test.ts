/**
 * Tests for the preprocessing pipeline orchestrator:
 *   - preprocessChunk (exported, lines 288–358)
 *   - chunkArray (private — tested via runPreprocessingPipeline integration)
 *   - findScopeContext (private — tested via preprocessChunk integration)
 *
 * All inputs are plain objects — no mocking needed.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  preprocessChunk,
  buildScopeContexts,
  runPreprocessingPipeline,
  type RawChunk,
  type PreprocessingOptions,
  DEFAULT_PREPROCESSING_OPTIONS
} from '../preprocessing.service'

// ── Helpers ──────────────────────────────────────────────────────────────

function makeChunk(overrides: Partial<RawChunk> = {}): RawChunk {
  return {
    id: 'chunk-1',
    filePath: 'src/services/auth.service.ts',
    symbolName: 'validateToken',
    symbolKind: 'function',
    body: 'function validateToken(token: string): boolean {\n  return verify(token, SECRET)\n}',
    startLine: 10,
    endLine: 12,
    signature: 'validateToken(token: string): boolean',
    isPublic: true,
    isAsync: false,
    isStatic: false,
    isAbstract: false,
    language: 'typescript',
    ...overrides
  }
}

function makeMethodChunk(overrides: Partial<RawChunk> = {}): RawChunk {
  return makeChunk({
    symbolName: 'login',
    symbolKind: 'method',
    body: 'login(user: string): Promise<void> {\n  await this.auth.validate(user)\n}',
    signature: 'login(user: string): Promise<void>',
    startLine: 15,
    endLine: 18,
    isAsync: true,
    ...overrides
  })
}

function makeClassChunk(overrides: Partial<RawChunk> = {}): RawChunk {
  return makeChunk({
    id: 'cls-1',
    symbolName: 'AuthService',
    symbolKind: 'class',
    body: 'class AuthService {\n  login() {}\n  logout() {}\n}',
    signature: 'class AuthService implements IAuth',
    startLine: 1,
    endLine: 50,
    ...overrides
  })
}

const FILE_CONTENT = `import { verify } from 'jsonwebtoken'
import { Logger } from './logger'

class AuthService implements IAuth {
  login(user: string): Promise<void> {
    await this.auth.validate(user)
  }
  logout(): void {
    this.session.clear()
  }
}

function validateToken(token: string): boolean {
  return verify(token, SECRET)
}
`

function defaultOpts(overrides: Partial<PreprocessingOptions> = {}): PreprocessingOptions {
  return { ...DEFAULT_PREPROCESSING_OPTIONS, ...overrides }
}

// ── preprocessChunk — basic behavior ────────────────────────────────────

describe('preprocessChunk — basic behavior', () => {
  test('returns ProcessedChunk[] for a public function', () => {
    const result = preprocessChunk(makeChunk(), FILE_CONTENT, null, 'my-project', defaultOpts())
    assert.ok(result !== null)
    assert.ok(Array.isArray(result))
    assert.ok(result.length >= 1)
  })

  test('embedText includes header and body', () => {
    const result = preprocessChunk(makeChunk(), FILE_CONTENT, null, 'my-project', defaultOpts())!
    const embed = result[0].embedText
    assert.ok(embed.includes('# File:'))
    assert.ok(embed.includes('# Signature:'))
    assert.ok(embed.includes('verify(token, SECRET)'))
  })

  test('metadata fields are correctly populated', () => {
    const result = preprocessChunk(makeChunk(), FILE_CONTENT, null, 'my-project', defaultOpts())!
    const meta = result[0].metadata
    assert.equal(meta.projectName, 'my-project')
    assert.equal(meta.symbolName, 'validateToken')
    assert.equal(meta.symbolKind, 'function')
    assert.equal(meta.language, 'typescript')
    assert.equal(meta.isPublic, true)
    assert.equal(meta.className, null)
  })

  test('body is preserved unchanged', () => {
    const chunk = makeChunk()
    const result = preprocessChunk(chunk, FILE_CONTENT, null, 'proj', defaultOpts())!
    assert.equal(result[0].body, chunk.body)
  })

  test('id is carried through', () => {
    const result = preprocessChunk(
      makeChunk({ id: 'unique-id' }),
      FILE_CONTENT,
      null,
      'proj',
      defaultOpts()
    )!
    assert.equal(result[0].id, 'unique-id')
  })
})

// ── preprocessChunk — private method skipping ───────────────────────────

describe('preprocessChunk — private method skipping', () => {
  test('skips private method when includePrivateMethods=false', () => {
    const result = preprocessChunk(
      makeMethodChunk({ isPublic: false }),
      FILE_CONTENT,
      null,
      'proj',
      defaultOpts({ includePrivateMethods: false })
    )
    assert.equal(result, null)
  })

  test('includes private method when includePrivateMethods=true', () => {
    const result = preprocessChunk(
      makeMethodChunk({ isPublic: false }),
      FILE_CONTENT,
      null,
      'proj',
      defaultOpts({ includePrivateMethods: true })
    )
    assert.ok(result !== null)
    assert.ok(result!.length >= 1)
  })

  test('does NOT skip private functions (only methods)', () => {
    const result = preprocessChunk(
      makeChunk({ isPublic: false, symbolKind: 'function' }),
      FILE_CONTENT,
      null,
      'proj',
      defaultOpts({ includePrivateMethods: false })
    )
    // functions are not skipped regardless of includePrivateMethods
    assert.ok(result !== null)
  })
})

// ── preprocessChunk — description handling ──────────────────────────────

describe('preprocessChunk — description prepend', () => {
  test('description is prepended to embedText when provided', () => {
    const result = preprocessChunk(
      makeChunk(),
      FILE_CONTENT,
      null,
      'proj',
      defaultOpts(),
      'This function validates JWT tokens'
    )!
    assert.ok(result[0].embedText.startsWith('This function validates JWT tokens'))
  })

  test('no description prefix when description is undefined', () => {
    const result = preprocessChunk(makeChunk(), FILE_CONTENT, null, 'proj', defaultOpts())!
    assert.ok(result[0].embedText.startsWith('# File:'))
  })

  test('hasDescription metadata reflects description presence', () => {
    const with_ = preprocessChunk(makeChunk(), FILE_CONTENT, null, 'proj', defaultOpts(), 'desc')!
    assert.equal(with_[0].metadata.hasDescription, true)

    const without = preprocessChunk(makeChunk(), FILE_CONTENT, null, 'proj', defaultOpts())!
    assert.equal(without[0].metadata.hasDescription, false)
  })
})

// ── preprocessChunk — scope enrichment ──────────────────────────────────

describe('preprocessChunk — scope enrichment', () => {
  const scopeContext = {
    className: 'AuthService',
    classKind: 'class' as const,
    classSignature: 'class AuthService implements IAuth',
    classDecorators: ['@Injectable()'],
    parentClassImports: [],
    siblingMethodSignatures: ['login(user: string): Promise<void>', 'logout(): void']
  }

  test('scope header added for methods', () => {
    const result = preprocessChunk(
      makeMethodChunk(),
      FILE_CONTENT,
      scopeContext,
      'proj',
      defaultOpts()
    )!
    assert.ok(result[0].embedText.includes('# Class: class AuthService implements IAuth'))
  })

  test('scope header NOT added for non-methods', () => {
    const result = preprocessChunk(
      makeChunk({ symbolKind: 'function' }),
      FILE_CONTENT,
      scopeContext,
      'proj',
      defaultOpts()
    )!
    assert.ok(!result[0].embedText.includes('# Class:'))
  })

  test('className set in metadata when scope provided', () => {
    const result = preprocessChunk(
      makeMethodChunk(),
      FILE_CONTENT,
      scopeContext,
      'proj',
      defaultOpts()
    )!
    assert.equal(result[0].metadata.className, 'AuthService')
  })

  test('scope decorators appear in header', () => {
    const result = preprocessChunk(
      makeMethodChunk(),
      FILE_CONTENT,
      scopeContext,
      'proj',
      defaultOpts()
    )!
    assert.ok(result[0].embedText.includes('# Class decorators: @Injectable()'))
  })

  test('sibling methods listed when includeSiblingSignatures=true', () => {
    const result = preprocessChunk(
      makeMethodChunk(),
      FILE_CONTENT,
      scopeContext,
      'proj',
      defaultOpts({ includeSiblingSignatures: true })
    )!
    assert.ok(result[0].embedText.includes('login()'))
    assert.ok(result[0].embedText.includes('logout()'))
  })

  test('sibling methods omitted when includeSiblingSignatures=false', () => {
    const result = preprocessChunk(
      makeMethodChunk(),
      FILE_CONTENT,
      scopeContext,
      'proj',
      defaultOpts({ includeSiblingSignatures: false })
    )!
    assert.ok(!result[0].embedText.includes('Other public methods'))
  })
})

// ── preprocessChunk — splitting ─────────────────────────────────────────

describe('preprocessChunk — long chunk splitting', () => {
  test('chunks under maxChunkLines produce a single result', () => {
    const result = preprocessChunk(
      makeChunk(),
      FILE_CONTENT,
      null,
      'proj',
      defaultOpts({ maxChunkLines: 80 })
    )!
    assert.equal(result.length, 1)
  })

  test('chunks exceeding maxChunkLines are split into parts', () => {
    const longBody = Array.from({ length: 30 }, (_, i) => `  const v${i} = ${i}`).join('\n')
    const result = preprocessChunk(
      makeChunk({ body: longBody }),
      FILE_CONTENT,
      null,
      'proj',
      defaultOpts({ maxChunkLines: 10, overlapLines: 2 })
    )!
    assert.ok(result.length > 1, `Expected >1 parts, got ${result.length}`)
  })

  test('split parts get part-numbered symbolNames', () => {
    const longBody = Array.from({ length: 30 }, (_, i) => `  const v${i} = ${i}`).join('\n')
    const result = preprocessChunk(
      makeChunk({ body: longBody }),
      FILE_CONTENT,
      null,
      'proj',
      defaultOpts({ maxChunkLines: 10, overlapLines: 2 })
    )!
    assert.ok(result[0].metadata.symbolName.includes('part 1'))
    assert.ok(result[1].metadata.symbolName.includes('part 2'))
  })

  test('split parts have rebuilt embedText with headers', () => {
    const longBody = Array.from({ length: 30 }, (_, i) => `  const v${i} = ${i}`).join('\n')
    const result = preprocessChunk(
      makeChunk({ body: longBody }),
      FILE_CONTENT,
      null,
      'proj',
      defaultOpts({ maxChunkLines: 10, overlapLines: 2 })
    )!
    for (const part of result) {
      assert.ok(part.embedText.includes('# File:'), 'Each part should have a header')
      assert.ok(part.embedText.includes('# Signature:'), 'Each part should have signature')
    }
  })

  test('split parts with description get description prepended to each', () => {
    const longBody = Array.from({ length: 30 }, (_, i) => `  const v${i} = ${i}`).join('\n')
    const result = preprocessChunk(
      makeChunk({ body: longBody }),
      FILE_CONTENT,
      null,
      'proj',
      defaultOpts({ maxChunkLines: 10, overlapLines: 2 }),
      'A test function'
    )!
    for (const part of result) {
      assert.ok(
        part.embedText.startsWith('A test function'),
        `Part ${part.id} should start with description`
      )
    }
  })

  test('split parts with scope context get scope header in each part', () => {
    const scopeCtx = {
      className: 'Svc',
      classKind: 'class' as const,
      classSignature: 'class Svc',
      classDecorators: [],
      parentClassImports: [],
      siblingMethodSignatures: ['run(): void']
    }
    const longBody = Array.from({ length: 30 }, (_, i) => `  const v${i} = ${i}`).join('\n')
    const result = preprocessChunk(
      makeMethodChunk({ body: longBody }),
      FILE_CONTENT,
      scopeCtx,
      'proj',
      defaultOpts({ maxChunkLines: 10, overlapLines: 2 })
    )!
    for (const part of result) {
      assert.ok(part.embedText.includes('# Class: class Svc'))
    }
  })
})

// ── preprocessChunk — import extraction integration ─────────────────────

describe('preprocessChunk — import integration', () => {
  test('relevant imports appear in embedText header', () => {
    const result = preprocessChunk(
      makeChunk({ body: 'return verify(token, SECRET)' }),
      FILE_CONTENT,
      null,
      'proj',
      defaultOpts()
    )!
    assert.ok(result[0].embedText.includes('# Uses: verify'))
  })

  test('no Uses line when no imports match', () => {
    const result = preprocessChunk(
      makeChunk({ body: 'return 42' }),
      'const nothing = 1\n',
      null,
      'proj',
      defaultOpts()
    )!
    assert.ok(!result[0].embedText.includes('# Uses:'))
  })
})

// ── findScopeContext integration (via preprocessChunk + buildScopeContexts) ──

describe('findScopeContext — integration via buildScopeContexts', () => {
  test('method inside class range gets scope context', () => {
    const classTags: RawChunk[] = [
      makeClassChunk(),
      makeMethodChunk({ startLine: 15, endLine: 18, isPublic: true })
    ]
    const contexts = buildScopeContexts(classTags)
    // Feed the method chunk through preprocessChunk with the scope context
    const scope = contexts.get('AuthService') ?? null
    const result = preprocessChunk(
      makeMethodChunk({ startLine: 15, endLine: 18 }),
      FILE_CONTENT,
      scope,
      'proj',
      defaultOpts()
    )!
    assert.equal(result[0].metadata.className, 'AuthService')
  })

  test('function outside class range gets null scope context', () => {
    buildScopeContexts([makeClassChunk()])
    // Function is not a method — scope is null
    const result = preprocessChunk(
      makeChunk({ symbolKind: 'function', startLine: 60, endLine: 65 }),
      FILE_CONTENT,
      null,
      'proj',
      defaultOpts()
    )!
    assert.equal(result[0].metadata.className, null)
  })

  test('empty scope map → method gets null className', () => {
    const result = preprocessChunk(makeMethodChunk(), FILE_CONTENT, null, 'proj', defaultOpts())!
    assert.equal(result[0].metadata.className, null)
  })
})

// ── buildScopeContexts — class kind detection ──────────────────────────

describe('buildScopeContexts — class kind detection', () => {
  test('interface chunk → classKind = "interface"', () => {
    const tags: RawChunk[] = [
      makeChunk({
        id: 'iface-1',
        symbolName: 'IAuth',
        symbolKind: 'interface',
        body: 'interface IAuth {\n  login(): void\n}',
        signature: 'interface IAuth',
        startLine: 1,
        endLine: 10
      })
    ]
    const contexts = buildScopeContexts(tags)
    const scope = contexts.get('IAuth')
    assert.ok(scope)
    assert.equal(scope!.classKind, 'interface')
  })

  test('abstract class signature → classKind = "abstract class"', () => {
    const tags: RawChunk[] = [
      makeChunk({
        id: 'abs-1',
        symbolName: 'BaseService',
        symbolKind: 'class',
        body: 'abstract class BaseService {\n  abstract run(): void\n}',
        signature: 'abstract class BaseService',
        startLine: 1,
        endLine: 10
      })
    ]
    const contexts = buildScopeContexts(tags)
    const scope = contexts.get('BaseService')
    assert.ok(scope)
    assert.equal(scope!.classKind, 'abstract class')
  })

  test('regular class → classKind = "class"', () => {
    const contexts = buildScopeContexts([makeClassChunk()])
    const scope = contexts.get('AuthService')
    assert.ok(scope)
    assert.equal(scope!.classKind, 'class')
  })

  test('record signature → classKind = "record"', () => {
    const tags: RawChunk[] = [
      makeChunk({
        id: 'rec-1',
        symbolName: 'UserRecord',
        symbolKind: 'class',
        body: 'record UserRecord(name: string) {}',
        signature: 'record UserRecord(name: string)',
        startLine: 1,
        endLine: 5
      })
    ]
    const contexts = buildScopeContexts(tags)
    const scope = contexts.get('UserRecord')
    assert.ok(scope)
    assert.equal(scope!.classKind, 'record')
  })
})

// ── buildScopeContexts — decorator extraction ───────────────────────────

describe('buildScopeContexts — decorator extraction', () => {
  test('class with @Controller() decorator → extracted in classDecorators', () => {
    const tags: RawChunk[] = [
      makeChunk({
        id: 'ctrl-1',
        symbolName: 'UserController',
        symbolKind: 'class',
        body: '@Controller("/users")\nclass UserController {\n  get() {}\n}',
        signature: 'class UserController',
        startLine: 1,
        endLine: 10
      })
    ]
    const contexts = buildScopeContexts(tags)
    const scope = contexts.get('UserController')
    assert.ok(scope)
    assert.ok(scope!.classDecorators.length > 0)
    assert.ok(scope!.classDecorators[0].includes('@Controller'))
  })

  test('class without decorators → empty classDecorators', () => {
    const contexts = buildScopeContexts([makeClassChunk()])
    const scope = contexts.get('AuthService')
    assert.ok(scope)
    assert.equal(scope!.classDecorators.length, 0)
  })

  test('class with multiple decorators → all extracted', () => {
    const tags: RawChunk[] = [
      makeChunk({
        id: 'multi-dec',
        symbolName: 'AppModule',
        symbolKind: 'class',
        body: '@Module()\n@Injectable()\nclass AppModule {\n}',
        signature: 'class AppModule',
        startLine: 1,
        endLine: 10
      })
    ]
    const contexts = buildScopeContexts(tags)
    const scope = contexts.get('AppModule')
    assert.ok(scope)
    assert.equal(scope!.classDecorators.length, 2)
  })
})

// ── buildScopeContexts — sibling methods ────────────────────────────────

describe('buildScopeContexts — sibling method signatures', () => {
  test('collects only public method signatures as siblings', () => {
    const tags: RawChunk[] = [
      makeClassChunk({ startLine: 1, endLine: 50 }),
      makeMethodChunk({
        symbolName: 'login',
        isPublic: true,
        startLine: 5,
        endLine: 10,
        signature: 'login(user: string): Promise<void>'
      }),
      makeMethodChunk({
        symbolName: 'hashPassword',
        isPublic: false,
        startLine: 15,
        endLine: 20,
        signature: 'hashPassword(pw: string): string'
      })
    ]
    const contexts = buildScopeContexts(tags)
    const scope = contexts.get('AuthService')
    assert.ok(scope)
    // Only public methods
    assert.ok(scope!.siblingMethodSignatures.some((s) => s.includes('login')))
    assert.ok(!scope!.siblingMethodSignatures.some((s) => s.includes('hashPassword')))
  })

  test('class with no methods → empty sibling signatures', () => {
    const contexts = buildScopeContexts([makeClassChunk()])
    const scope = contexts.get('AuthService')
    assert.ok(scope)
    assert.equal(scope!.siblingMethodSignatures.length, 0)
  })
})

// ── skipPatterns pass-through ───────────────────────────────────────
// Semantic search never passed .atelierignore/.gitignore rules into the
// pipeline, so the late-stage filter had nothing workspace-specific to match.

describe('runPreprocessingPipeline — skipPatterns', () => {
  const podsChunk = makeChunk({
    id: 'pods-1',
    filePath: 'apps/mobile/ios/Pods/Alamofire/Source/Alamofire.swift',
    symbolName: 'request'
  })
  const libsChunk = makeChunk({ id: 'libs-1', filePath: 'libs/Domain/Order.ts' })
  const ownChunk = makeChunk({ id: 'own-1', filePath: 'src/services/auth.service.ts' })
  const contents = new Map([
    [podsChunk.filePath, FILE_CONTENT],
    [libsChunk.filePath, FILE_CONTENT],
    [ownChunk.filePath, FILE_CONTENT]
  ])

  const runWith = async (skipPatterns: string[]): Promise<Set<string>> => {
    const result = await runPreprocessingPipeline(
      [podsChunk, libsChunk, ownChunk],
      contents,
      'proj',
      defaultOpts({ skipPatterns }),
      () => {}
    )
    return new Set(result.map((c) => c.metadata.filePath))
  }

  test('drops files matching a caller-supplied pattern', async () => {
    const paths = await runWith(['**/libs/**'])
    assert.equal(paths.has(libsChunk.filePath), false)
    assert.equal(paths.has(ownChunk.filePath), true)
  })

  test('keeps generic Tier-2 directories when no pattern is supplied', async () => {
    const paths = await runWith([])
    assert.equal(paths.has(libsChunk.filePath), true)
    assert.equal(paths.has(ownChunk.filePath), true)
  })

  test('built-in exclusions drop Pods even with no caller patterns', async () => {
    const paths = await runWith([])
    assert.equal(paths.has(podsChunk.filePath), false)
  })
})

// ── Summary ──
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
