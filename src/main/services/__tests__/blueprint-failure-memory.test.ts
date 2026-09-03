/**
 * P2 — structured failure memory: parsing, rendering and the fallback contract.
 *
 * No LLM runs here. The extractor's dependencies are injected, so what these
 * tests cover is everything that decides whether a retry gets a useful prompt:
 * how a reply is coerced into the schema, how the schema renders, and — most
 * importantly — that every failure returns `null`, because `null` is what makes
 * the caller keep today's raw-dump behaviour instead of losing context.
 *
 * The caps are asserted as inequalities against the raw dump's 4000 characters:
 * a "structured" block that costs more than the unstructured one it replaced
 * has failed at the only thing it was built for.
 *
 * Run: tsx src/main/services/__tests__/blueprint-failure-memory.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

import type { FailureMemory, FailureMemoryDeps } from '../blueprint-failure-memory'

setupElectronStub()

// `require` after the stub, not a hoisted import: the module reaches
// model-config.service → db/index.ts, whose `schema.sql?raw` import only
// resolves once the stub's loader is installed.
const { extractFailureMemory, parseFailureMemory, renderFailureMemory, MAX_RENDERED_CHARS } =
  require('../blueprint-failure-memory') as typeof import('../blueprint-failure-memory')

/** The 4000-char cap the raw `build-partial` dump is sliced to today. */
const RAW_DUMP_CAP = 4000

const FULL: FailureMemory = {
  hypothesisTried: 'Added a null guard in the parser instead of fixing the caller',
  filesTouched: ['src/parse.ts', 'src/parse.test.ts'],
  failingGate: 'task-tests',
  evidenceHead: 'FAIL src/parse.test.ts\n  ✕ rejects an empty payload',
  evidenceTail: 'Tests: 1 failed, 4 passed',
  doNotRepeat: ['Do not add another null guard in parse.ts — the caller passes undefined']
}

function replying(text: string): FailureMemoryDeps {
  return {
    runClaude: async () => ({
      text,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      model: 'claude-haiku-4-5',
      costCents: 0
    }),
    getModel: () => 'claude-haiku-4-5'
  }
}

/** A reply with every field far over its cap. */
const HUGE_REPLY = JSON.stringify({
  hypothesisTried: 'h'.repeat(4000),
  filesTouched: Array.from({ length: 40 }, (_, i) => `src/very/long/path/file-${i}.ts`),
  failingGate: 'task-tests',
  evidenceHead: 'e'.repeat(4000),
  evidenceTail: 't'.repeat(4000),
  doNotRepeat: Array.from({ length: 40 }, (_, i) => `rule number ${i} `.repeat(20))
})

/**
 * The same reply as the caller actually sees it: parsed first, so the per-field
 * caps apply, and still large enough that the render must drop fields to fit.
 */
const OVERSIZED = parseFailureMemory(HUGE_REPLY) as FailureMemory

const PARAMS = {
  text: 'x'.repeat(1000),
  blueprintId: 'bp-1',
  taskId: 'T001',
  workspaceId: 'ws-1'
}

// ── parseFailureMemory ──

describe('parseFailureMemory — coercing a reply into the schema', () => {
  test('parses a well-formed reply', () => {
    const parsed = parseFailureMemory(JSON.stringify(FULL))
    assert.deepEqual(parsed, FULL)
  })

  test('survives the fence block models emit despite being told not to', () => {
    const parsed = parseFailureMemory('```json\n' + JSON.stringify(FULL) + '\n```')
    assert.deepEqual(parsed, FULL)
  })

  test('survives prose wrapped around the JSON', () => {
    const parsed = parseFailureMemory(
      `Here is the extraction:\n${JSON.stringify(FULL)}\nHope that helps.`
    )
    assert.equal(parsed?.failingGate, 'task-tests')
  })

  test('returns null for output that is not JSON at all', () => {
    // Null is the whole fallback contract: it is what makes the caller keep the
    // raw dump rather than silently sending a retry no prior context.
    assert.equal(parseFailureMemory('I was unable to extract anything.'), null)
    assert.equal(parseFailureMemory(''), null)
    assert.equal(parseFailureMemory('{ not valid json'), null)
  })

  test('returns null for a well-formed but entirely empty extraction', () => {
    // The right SHAPE with nothing in it is a failed extraction in disguise.
    // Accepting it would suppress the fallback in exchange for a heading.
    const empty = parseFailureMemory(
      JSON.stringify({
        hypothesisTried: '',
        filesTouched: [],
        failingGate: '',
        evidenceHead: '',
        evidenceTail: '',
        doNotRepeat: []
      })
    )
    assert.equal(empty, null)
  })

  test('a partial extraction is kept, not discarded', () => {
    // Some structure beats none. Only the all-empty case falls back.
    const partial = parseFailureMemory(
      JSON.stringify({ hypothesisTried: 'Rewrote the reducer', failingGate: 'write-set' })
    )
    assert.equal(partial?.hypothesisTried, 'Rewrote the reducer')
    assert.deepEqual(partial?.filesTouched, [], 'an absent array becomes empty, not undefined')
    assert.deepEqual(partial?.doNotRepeat, [])
  })

  test('coerces wrong-typed fields instead of throwing', () => {
    // A model that answers with a number, an object or a nested array must not
    // crash the retry path — that is a worse outcome than no memory at all.
    const parsed = parseFailureMemory(
      JSON.stringify({
        hypothesisTried: 42,
        filesTouched: 'src/a.ts',
        failingGate: { name: 'task-tests' },
        evidenceHead: 'real evidence',
        evidenceTail: null,
        doNotRepeat: ['ok', 17, '', '  ']
      })
    )
    assert.equal(parsed?.hypothesisTried, '')
    assert.deepEqual(parsed?.filesTouched, [], 'a bare string is not a list of files')
    assert.equal(parsed?.failingGate, '')
    assert.equal(parsed?.evidenceHead, 'real evidence')
    assert.deepEqual(parsed?.doNotRepeat, ['ok'], 'non-strings and blanks are dropped')
  })

  test('caps individual fields so one runaway value cannot crowd out the rest', () => {
    const parsed = parseFailureMemory(
      JSON.stringify({
        hypothesisTried: 'h'.repeat(5000),
        evidenceHead: 'e'.repeat(5000),
        filesTouched: Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`),
        doNotRepeat: Array.from({ length: 50 }, (_, i) => `rule ${i}`)
      })
    )
    assert.ok((parsed?.hypothesisTried.length ?? 0) < 500)
    assert.ok((parsed?.evidenceHead.length ?? 0) < 700)
    assert.ok((parsed?.filesTouched.length ?? 0) <= 12)
    assert.ok((parsed?.doNotRepeat.length ?? 0) <= 6)
  })
})

// ── renderFailureMemory ──

describe('renderFailureMemory — schema to prompt block', () => {
  test('renders every populated field', () => {
    const md = renderFailureMemory(FULL)
    assert.match(md, /Approach tried.*null guard/)
    assert.match(md, /Rejected by gate.*task-tests/)
    assert.match(md, /src\/parse\.ts/)
    assert.match(md, /rejects an empty payload/)
    assert.match(md, /Tests: 1 failed/)
    assert.match(md, /Do NOT repeat/)
    assert.match(md, /do NOT restart from scratch/, 'the retry instruction must survive')
  })

  test('omits empty fields entirely rather than printing blank headings', () => {
    // A labelled blank is a distractor, and a single distractor measurably
    // degrades the model — that is the reason this schema is fixed at all.
    const md = renderFailureMemory({
      ...FULL,
      filesTouched: [],
      failingGate: '',
      doNotRepeat: []
    })
    assert.doesNotMatch(md, /Files it wrote/)
    assert.doesNotMatch(md, /Rejected by gate/)
    assert.doesNotMatch(md, /Do NOT repeat/)
    assert.match(md, /Approach tried/, 'the fields that ARE present still render')
  })

  test('does not print the same evidence twice', () => {
    // On a short failure the head and the tail are legitimately identical.
    const md = renderFailureMemory({ ...FULL, evidenceTail: FULL.evidenceHead })
    assert.equal(md.split('Failure evidence').length - 1, 1)
  })

  test('the rendered block is capped below the raw dump it replaces', () => {
    const huge = renderFailureMemory(OVERSIZED)
    assert.ok(huge.length <= MAX_RENDERED_CHARS + 20, `rendered ${huge.length} chars`)
    assert.ok(
      huge.length < RAW_DUMP_CAP,
      'a structured block that costs more than the unstructured dump has no reason to exist'
    )
  })

  // ── R3 — the cap must not eat the block's own instructions ──

  test('the retry instruction survives a render that is over budget', () => {
    // The regression: the cap was applied by slicing the tail off the joined
    // string, and the instruction is the tail. The block that most needed "do
    // not restart from scratch" was exactly the block that lost it.
    const huge = renderFailureMemory(OVERSIZED)
    assert.match(huge, /do NOT restart from scratch/, 'the instruction is first-class, not tail')
    assert.match(huge, /What the previous attempt did/, 'and so is the header')
    assert.match(huge, /Do NOT repeat/, 'the most actionable field is the last one sacrificed')
    assert.ok(huge.length <= MAX_RENDERED_CHARS, `rendered ${huge.length} chars`)
  })

  test('even an UNCAPPED memory renders a usable block rather than a sliced one', () => {
    // renderFailureMemory is exported and pure, so it can be handed a memory
    // that never went through the parser's field caps. Everything may then have
    // to go — but the two parts that are not fields must not.
    const unparsed = JSON.parse(HUGE_REPLY) as FailureMemory
    const md = renderFailureMemory(unparsed)
    assert.match(md, /do NOT restart from scratch/)
    assert.match(md, /What the previous attempt did/)
    assert.ok(md.length <= MAX_RENDERED_CHARS)
  })

  test('an over-budget render drops whole fields rather than half a line', () => {
    const huge = renderFailureMemory(OVERSIZED)
    // Every rendered field is a complete bullet; a sliced one would end mid-word
    // with no newline and no closing fence.
    assert.doesNotMatch(huge, /…\[truncated\]/, 'nothing is tail-sliced any more')
    for (const line of huge.split('\n')) {
      if (line.startsWith('- **')) {
        assert.match(line, /- \*\*[^*]+\*\*:/, `field label cut in half: ${line.slice(0, 40)}`)
      }
    }
  })

  test('fence markers are balanced even when the evidence contains its own', () => {
    // Command output contains fences often enough to matter, and an unbalanced
    // fence swallows everything after it — including the retry instruction.
    const md = renderFailureMemory({
      ...FULL,
      evidenceHead: 'error in:\n```ts\nconst x = 1\n```\nsee above',
      evidenceTail: 'summary ``` dangling'
    })
    const fences = md.split('\n').filter((l) => l.trim() === '```').length
    assert.equal(fences % 2, 0, `unbalanced fences (${fences}) in the rendered block`)
    assert.equal(fences, 4, 'exactly the two fences this render opens, and their closers')
    assert.match(md, /do NOT restart from scratch/, 'the instruction is outside every fence')
  })
})

// ── extractFailureMemory: the fallback contract ──

describe('extractFailureMemory — null on every failure path', () => {
  test('returns the parsed memory on a good reply', async () => {
    const got = await extractFailureMemory(PARAMS, replying(JSON.stringify(FULL)))
    assert.equal(got?.memory.failingGate, 'task-tests')
  })

  // ── R4 — what the extraction cost comes back with what it produced ──

  test('the Haiku call’s tokens and cost come back with the memory', async () => {
    // Without this the plan’s "<5% of build tokens" ceiling is not checkable:
    // the usage_log row is attributed to the feature, not to the task or the
    // attempt, so it cannot be divided by that attempt’s build tokens.
    const got = await extractFailureMemory(PARAMS, {
      getModel: () => 'claude-haiku-4-5',
      runClaude: async () => ({
        text: JSON.stringify(FULL),
        usage: { input: 900, output: 120, cacheRead: 40, cacheCreation: 60 },
        model: 'claude-haiku-4-5',
        costCents: 3
      })
    })
    assert.equal(got?.inputTokens, 1000, 'cached input is still input — it counts against the cap')
    assert.equal(got?.outputTokens, 120)
    assert.equal(got?.costCents, 3)
  })

  test('returns null when the transcript is too short to extract from', async () => {
    let called = false
    const deps = replying(JSON.stringify(FULL))
    const got = await extractFailureMemory(
      { ...PARAMS, text: 'died early' },
      {
        ...deps,
        runClaude: async () => {
          called = true
          throw new Error('should not be reached')
        }
      }
    )
    assert.equal(got, null)
    assert.equal(called, false, 'a short transcript must not cost a Haiku call at all')
  })

  test('returns null when the CLI call throws', async () => {
    const got = await extractFailureMemory(PARAMS, {
      getModel: () => 'claude-haiku-4-5',
      runClaude: async () => {
        throw new Error('CLI timed out after 120s')
      }
    })
    assert.equal(got, null)
  })

  test('returns null when no haiku model can be resolved', async () => {
    const got = await extractFailureMemory(PARAMS, {
      runClaude: async () => {
        throw new Error('should not be reached')
      },
      getModel: () => {
        throw new Error('no model bound')
      }
    })
    assert.equal(got, null)
  })

  test('returns null when the reply does not parse', async () => {
    const got = await extractFailureMemory(PARAMS, replying('sorry, I could not do that'))
    assert.equal(got, null)
  })

  test('passes the gate verdict to the extractor so it can name the failing gate', async () => {
    let prompt = ''
    await extractFailureMemory(
      {
        ...PARAMS,
        gateReport: {
          overall: 'fail',
          gates: [
            {
              name: 'write-set',
              verdict: 'fail',
              evidence: ['outside write-set: node_modules'],
              durationMs: 0
            }
          ]
        }
      },
      {
        getModel: () => 'claude-haiku-4-5',
        runClaude: async (opts) => {
          prompt = opts.args.join('\n')
          return {
            text: JSON.stringify(FULL),
            usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
            model: 'claude-haiku-4-5',
            costCents: 0
          }
        }
      }
    )
    assert.match(prompt, /write-set/, 'the gate name must reach the extractor')
    assert.match(prompt, /outside write-set: node_modules/, 'so must its evidence')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
