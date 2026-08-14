/**
 * Complexity analyzer — the tree-sitter engine behind `analyze_complexity`
 * for C#, Java and Python.
 *
 * Every expected score below is hand-computed from `1 + decision points`
 * against the fixture it names. The walker is only as trustworthy as these
 * numbers, so they are pinned per function rather than asserted in aggregate.
 *
 * Two traps have dedicated cases because a plausible implementation gets them
 * wrong silently:
 *   - Java's `switch_label` matches `default` as well as `case`, which would
 *     inflate every Java switch by one.
 *   - Python's `and`/`or` live on `boolean_operator`, NOT `binary_expression`,
 *     so a single global operator set scores every Python boolean as zero.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { test, describe, summaryAsync } from './test-harness'
import {
  computeFileComplexity,
  collectAnalyzableFiles,
  complexityEngineFor,
  langForFile,
  ALL_SUPPORTED_EXTENSIONS,
  ESLINT_EXTENSIONS,
  TREE_SITTER_EXTENSIONS,
  type TreeSitterLang
} from '../complexity-analyzer'
import { getTreeSitter } from '../tree-sitter-parser'

const FIXTURE_DIR = path.resolve(process.cwd(), 'src/main/services/__tests__/fixtures')

/** Say so loudly — a silently-skipped guard is how the C# query pack died. */
function unavailable(): void {
  console.log('    (complexity guard skipped: web-tree-sitter unavailable in this runtime)')
}

/**
 * Probe through the SHARED lifecycle, never `Parser.init()` directly: a second
 * init on a concurrently-running suite re-creates the Emscripten module and
 * every grammar already loaded reads back as version 0.
 */
let available: Promise<boolean> | null = null
function treeSitterAvailable(): Promise<boolean> {
  available ??= getTreeSitter().then(
    () => true,
    () => false
  )
  return available
}

async function scoresFor(lang: TreeSitterLang, file: string): Promise<Map<string, number>> {
  const code = readFileSync(path.join(FIXTURE_DIR, file), 'utf-8')
  const results = await computeFileComplexity(code, lang)
  const byName = new Map<string, number>()
  for (const r of results) byName.set(r.function, r.complexity)
  return byName
}

// ── Routing ─────────────────────────────────────────────────────────────────

describe('complexity language routing', () => {
  test('JS/TS still routes to the ESLint engine', () => {
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']) {
      assert.equal(complexityEngineFor(`src/app${ext}`), 'eslint', `${ext} must use ESLint`)
      assert.ok(ESLINT_EXTENSIONS.has(ext))
    }
  })

  test('C#, Java and Python route to the tree-sitter engine', () => {
    assert.equal(complexityEngineFor('src/Service.cs'), 'tree-sitter')
    assert.equal(complexityEngineFor('src/Service.java'), 'tree-sitter')
    assert.equal(complexityEngineFor('src/service.py'), 'tree-sitter')
    assert.equal(langForFile('src/Service.cs'), 'c_sharp')
    assert.equal(langForFile('src/Service.java'), 'java')
    assert.equal(langForFile('src/service.py'), 'python')
  })

  test('genuinely unsupported languages still report unsupported', () => {
    for (const ext of ['.rs', '.go', '.rb', '.c', '.cpp', '.php']) {
      assert.equal(complexityEngineFor(`src/main${ext}`), null, `${ext} must be unsupported`)
    }
  })

  test('the advertised extension list covers both engines', () => {
    assert.equal(ALL_SUPPORTED_EXTENSIONS.length, 11)
    for (const ext of ['.ts', '.cs', '.java', '.py']) {
      assert.ok(ALL_SUPPORTED_EXTENSIONS.includes(ext), `${ext} must be advertised`)
    }
  })

  test('every tree-sitter extension maps to a grammar with rules', () => {
    // The table is the single source of truth for "supported" — an extension
    // must never resolve to a grammar the walker has no rules for.
    for (const lang of Object.values(TREE_SITTER_EXTENSIONS)) {
      assert.ok(['c_sharp', 'java', 'python'].includes(lang), `unknown grammar ${lang}`)
    }
  })
})

// ── C# ──────────────────────────────────────────────────────────────────────

describe('complexity — C#', () => {
  test('scores every construct as hand-computed', async () => {
    if (!(await treeSitterAvailable())) return unavailable()
    const s = await scoresFor('c_sharp', 'complexity-sample.cs')

    assert.equal(s.get('Simple'), 1, 'no decision points')
    assert.equal(s.get('Guarded'), 3, 'if + && (else is not a path)')
    assert.equal(s.get('Loops'), 5, 'for + foreach + while + do')
    assert.equal(s.get('Classify'), 3, 'two cases; `default:` is NOT counted')
    assert.equal(s.get('Describe'), 3, 'two arms; the `_ =>` discard arm is NOT counted')
    assert.equal(s.get('Risky'), 4, 'catch + when-filter + catch (finally is not a path)')
    assert.equal(s.get('Coalesce'), 4, '?. + ?? + ternary')
    assert.equal(s.get('Match'), 3, 'and_pattern + or_pattern')
    assert.equal(s.get('Analyzer'), 2, 'constructor with a ternary')
  })

  test('nested scopes are scored separately, not folded into the parent', async () => {
    if (!(await treeSitterAvailable())) return unavailable()
    const s = await scoresFor('c_sharp', 'complexity-sample.cs')

    assert.equal(s.get('Outer'), 2, 'the lambda body must NOT inflate its method')
    assert.equal(s.get('WithLocal'), 1, 'the local function must NOT inflate its method')
    assert.equal(s.get('Helper'), 2, 'the local function is reported on its own')
    const lambda = [...s.entries()].find(([name]) => name.startsWith('lambda@'))
    assert.ok(lambda, 'anonymous scopes are reported as lambda@<line>')
    assert.equal(lambda[1], 2, 'the lambda keeps its own ternary')
  })

  test('property accessors are reported as their own scope', async () => {
    if (!(await treeSitterAvailable())) return unavailable()
    const s = await scoresFor('c_sharp', 'complexity-sample.cs')
    const accessor = [...s.entries()].find(([n, c]) => n.startsWith('accessor@') && c === 2)
    assert.ok(accessor, 'the get accessor with an if must score 2')
  })
})

// ── Java ────────────────────────────────────────────────────────────────────

describe('complexity — Java', () => {
  test('scores every construct as hand-computed', async () => {
    if (!(await treeSitterAvailable())) return unavailable()
    const s = await scoresFor('java', 'complexity-sample.java')

    assert.equal(s.get('simple'), 1)
    assert.equal(s.get('guarded'), 3, 'if + &&')
    assert.equal(s.get('loops'), 5, 'for + enhanced-for + while + do')
    assert.equal(s.get('risky'), 3, 'two catches; finally is not a path')
    assert.equal(s.get('ternary'), 2)
    assert.equal(s.get('Fixture'), 2, 'constructor with a ternary')
  })

  test('TRAP: `default` is a switch_label too and must not be counted', async () => {
    if (!(await treeSitterAvailable())) return unavailable()
    const s = await scoresFor('java', 'complexity-sample.java')
    // classify: case 1 + case 2 → 3. Counting `default:` blindly gives 4.
    assert.equal(s.get('classify'), 3, 'colon-form `default:` inflated the score')
    // arrow: case 1 → 2. Counting `default ->` gives 3.
    assert.equal(s.get('arrow'), 2, 'arrow-form `default ->` inflated the score')
  })

  test('lambdas are isolated from the enclosing method', async () => {
    if (!(await treeSitterAvailable())) return unavailable()
    const s = await scoresFor('java', 'complexity-sample.java')
    assert.equal(s.get('outer'), 2, 'method keeps only its own if')
    const lambda = [...s.entries()].find(([name]) => name.startsWith('lambda@'))
    assert.ok(lambda && lambda[1] === 2, 'the lambda carries its own if')
  })
})

// ── Python ──────────────────────────────────────────────────────────────────

describe('complexity — Python', () => {
  test('TRAP: `and`/`or` live on boolean_operator and MUST be counted', async () => {
    if (!(await treeSitterAvailable())) return unavailable()
    const s = await scoresFor('python', 'complexity-sample.py')
    // guarded: if + and + elif → 4. A binary_expression-only operator set gives 3.
    assert.equal(s.get('guarded'), 4, 'the `and` was scored as zero — wrong node type')
  })

  test('scores every construct as hand-computed', async () => {
    if (!(await treeSitterAvailable())) return unavailable()
    const s = await scoresFor('python', 'complexity-sample.py')

    assert.equal(s.get('simple'), 1)
    assert.equal(s.get('loops'), 3, 'for + while')
    assert.equal(s.get('classify'), 5, 'case 1|2 + union + guarded case + guard; `case _` excluded')
    assert.equal(s.get('risky'), 3, 'two excepts; finally is not a path')
    assert.equal(s.get('comprehension'), 3, 'comprehension for + if')
    assert.equal(s.get('checked'), 3, 'assert + conditional expression')
    assert.equal(s.get('with_and_else'), 1, '`with` adds no path')
  })

  test('lambdas are reported once, not twice', async () => {
    if (!(await treeSitterAvailable())) return unavailable()
    const code = readFileSync(path.join(FIXTURE_DIR, 'complexity-sample.py'), 'utf-8')
    const results = await computeFileComplexity(code, 'python')
    const lambdas = results.filter((r) => r.function.startsWith('lambda@'))
    // The `lambda` KEYWORD token shares the node type name with the lambda
    // expression — a type-only check reports every Python lambda twice.
    assert.equal(lambdas.length, 1, 'the lambda keyword token leaked in as a scope')
    assert.equal(lambdas[0].complexity, 2)
    assert.equal(results.find((r) => r.function === 'outer')?.complexity, 2)
  })
})

// ── File discovery ──────────────────────────────────────────────────────────

describe('collectAnalyzableFiles', () => {
  test('finds the fixtures and ignores unrelated languages', () => {
    const found = collectAnalyzableFiles(FIXTURE_DIR, process.cwd())
    const names = found.files.map((f) => path.basename(f))
    assert.ok(names.includes('complexity-sample.cs'))
    assert.ok(names.includes('complexity-sample.java'))
    assert.ok(names.includes('complexity-sample.py'))
    assert.ok(
      !names.some((n) => n.endsWith('.ts')),
      'TS files belong to the ESLint engine, not this walker'
    )
  })

  test('a single file target returns just that file', () => {
    const target = path.join(FIXTURE_DIR, 'complexity-sample.cs')
    const found = collectAnalyzableFiles(target, process.cwd())
    assert.equal(found.files.length, 1)
    assert.equal(path.basename(found.files[0]), 'complexity-sample.cs')
  })

  test('an unsupported single file yields nothing', () => {
    const found = collectAnalyzableFiles(path.join(FIXTURE_DIR, 'sample.ts'), process.cwd())
    assert.equal(found.files.length, 0)
  })

  test('the file cap is reported rather than silently truncating', () => {
    const found = collectAnalyzableFiles(FIXTURE_DIR, process.cwd(), 1)
    assert.equal(found.files.length, 1)
    assert.equal(found.truncated, true, 'truncation must be visible in the report')
  })

  test('a missing path is not an error', () => {
    const found = collectAnalyzableFiles(path.join(FIXTURE_DIR, 'nope'), process.cwd())
    assert.deepEqual(found, { files: [], truncated: false })
  })
})

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('complexity-analyzer.test.ts')

if (isDirectRun) {
  void summaryAsync()
}
