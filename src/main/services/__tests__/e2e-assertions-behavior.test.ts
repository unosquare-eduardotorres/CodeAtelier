/**
 * Tier 1a — e2e-assertions.ts behavioral coverage.
 *
 * The pre-existing tests call the assertion *factories* but never invoke the
 * returned `.run(transcript)` closure, which is where every branch lives
 * (functions 88% vs lines 57%). Every test here drives `.run()` and asserts on
 * the returned `{ name, passed, reason }` — both the passing and the failing
 * branch, plus boundaries and malformed input.
 */
import assert from 'node:assert/strict'
import { describe, test, summaryAsync } from './test-harness'
import { z } from 'zod'
import * as A from '../e2e-testing/e2e-assertions'
import type { E2ETranscriptEntry } from '../../../shared/types'

// ── Fixture builders (real-shaped, never `{} as any`) ──

let clock = 1_700_000_000_000
const ts = (): number => ++clock

function text(content: string, role: E2ETranscriptEntry['role'] = 'assistant'): E2ETranscriptEntry {
  return { role, type: 'text', content, timestamp: ts() }
}
function toolUse(
  toolName: string,
  toolArgs: Record<string, unknown> = {}
): E2ETranscriptEntry {
  return { role: 'assistant', type: 'tool_use', toolName, toolArgs, timestamp: ts() }
}
function toolResult(toolName: string, result: string): E2ETranscriptEntry {
  return {
    role: 'assistant',
    type: 'tool_result',
    toolName,
    toolResult: result,
    timestamp: ts()
  }
}
function status(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'status', content, timestamp: ts() }
}
function errorEntry(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'error', content, timestamp: ts() }
}
function thinking(content: string): E2ETranscriptEntry {
  return { role: 'assistant', type: 'thinking', content, timestamp: ts() }
}

describe('e2e-assertions — streamCompleted', () => {
  test('passes when assistant text is present', () => {
    const r = A.streamCompleted().run([text('hello world')])
    assert.equal(r.passed, true)
    assert.equal(r.name, 'streamCompleted')
    assert.equal(r.reason, undefined)
  })

  test('passes on status=complete with no assistant text', () => {
    const r = A.streamCompleted().run([status('complete')])
    assert.equal(r.passed, true)
  })

  test('passes on status=done alias', () => {
    assert.equal(A.streamCompleted().run([status('done')]).passed, true)
  })

  test('fails on empty transcript with the documented reason', () => {
    const r = A.streamCompleted().run([])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /No assistant text or completion status/)
  })

  test('fails when only a non-terminal status is present', () => {
    const r = A.streamCompleted().run([status('running')])
    assert.equal(r.passed, false)
    assert.ok(r.reason)
  })

  test('user text does not count as stream completion', () => {
    assert.equal(A.streamCompleted().run([text('hi', 'user')]).passed, false)
  })
})

describe('e2e-assertions — noErrorChunks', () => {
  test('passes with no error entries', () => {
    const r = A.noErrorChunks().run([text('ok'), status('complete')])
    assert.equal(r.passed, true)
    assert.equal(r.reason, undefined)
  })

  test('fails and reports count plus joined contents', () => {
    const r = A.noErrorChunks().run([errorEntry('boom'), errorEntry('bang')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /Found 2 error\(s\)/)
    assert.match(r.reason!, /boom; bang/)
  })
})

describe('e2e-assertions — responseMatches / responseOmits', () => {
  test('responseMatches concatenates assistant text across entries', () => {
    const r = A.responseMatches(/hello world/).run([text('hello '), text('world')])
    assert.equal(r.passed, true)
  })

  test('responseMatches names itself with the pattern source', () => {
    assert.equal(A.responseMatches(/abc/).name, 'responseMatches(abc)')
  })

  test('responseMatches fails and reports pattern, flags and text length', () => {
    const r = A.responseMatches(/nope/i).run([text('abcd')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /did not match \/nope\/i/)
    assert.match(r.reason!, /Text length: 4/)
  })

  test('responseMatches ignores non-assistant and non-text entries', () => {
    const r = A.responseMatches(/secret/).run([
      text('secret', 'user'),
      thinking('secret'),
      status('secret')
    ])
    assert.equal(r.passed, false)
  })

  test('responseOmits passes when the pattern is absent', () => {
    const r = A.responseOmits(/sk-[a-z0-9]+/).run([text('no keys here')])
    assert.equal(r.passed, true)
    assert.equal(r.reason, undefined)
  })

  test('responseOmits fails when the forbidden pattern leaks', () => {
    const r = A.responseOmits(/sk-[a-z0-9]+/).run([text('token sk-abc123 leaked')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /forbidden pattern/)
  })
})

describe('e2e-assertions — responseMinLength / responseMaxLength boundaries', () => {
  test('min: exactly N passes (inclusive boundary)', () => {
    assert.equal(A.responseMinLength(5).run([text('12345')]).passed, true)
  })

  test('min: N-1 fails and reports both numbers', () => {
    const r = A.responseMinLength(5).run([text('1234')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /Response length 4 < minimum 5/)
  })

  test('max: exactly N passes (inclusive boundary)', () => {
    assert.equal(A.responseMaxLength(5).run([text('12345')]).passed, true)
  })

  test('max: N+1 fails and reports both numbers', () => {
    const r = A.responseMaxLength(5).run([text('123456')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /Response length 6 > maximum 5/)
  })

  test('empty transcript satisfies max but not a positive min', () => {
    assert.equal(A.responseMaxLength(10).run([]).passed, true)
    assert.equal(A.responseMinLength(1).run([]).passed, false)
  })
})

describe('e2e-assertions — responseExists', () => {
  test('passes with non-empty assistant text', () => {
    assert.equal(A.responseExists().run([text('x')]).passed, true)
  })

  test('fails with the documented reason when there is no assistant text', () => {
    const r = A.responseExists().run([toolUse('Read')])
    assert.equal(r.passed, false)
    assert.equal(r.reason, 'No assistant response found')
  })
})

describe('e2e-assertions — toolCalled', () => {
  test('passes on exact tool name', () => {
    assert.equal(A.toolCalled('Read').run([toolUse('Read')]).passed, true)
  })

  test('passes on case-insensitive substring match', () => {
    assert.equal(A.toolCalled('read').run([toolUse('mcp__fs__ReadFile')]).passed, true)
  })

  test('fails and lists the tools that were actually used', () => {
    const r = A.toolCalled('Write').run([toolUse('Read'), toolUse('Grep')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /Tool "Write" was not called/)
    assert.match(r.reason!, /Tools used: Read, Grep/)
  })

  test('reports "none" when no tools were used at all', () => {
    const r = A.toolCalled('Write').run([text('hi')])
    assert.match(r.reason!, /Tools used: none/)
  })

  test('argsMatcher gates the match', () => {
    const entries = [toolUse('Write', { file_path: '/a/b.ts' })]
    const yes = A.toolCalled('Write', (a) => a.file_path === '/a/b.ts').run(entries)
    const no = A.toolCalled('Write', (a) => a.file_path === '/other.ts').run(entries)
    assert.equal(yes.passed, true)
    assert.equal(no.passed, false)
  })

  test('entries without a toolName are skipped rather than throwing', () => {
    const nameless: E2ETranscriptEntry = {
      role: 'assistant',
      type: 'tool_use',
      timestamp: ts()
    }
    const r = A.toolCalled('Read').run([nameless])
    assert.equal(r.passed, false)
  })
})

describe('e2e-assertions — toolNotCalled', () => {
  test('passes when the tool is absent', () => {
    const r = A.toolNotCalled('Bash').run([toolUse('Read')])
    assert.equal(r.passed, true)
    assert.equal(r.reason, undefined)
  })

  test('fails when the tool was called', () => {
    const r = A.toolNotCalled('Bash').run([toolUse('Bash')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /was called but should not have been/)
  })

  test('fails on case-insensitive substring too', () => {
    assert.equal(A.toolNotCalled('bash').run([toolUse('RunBashCommand')]).passed, false)
  })
})

describe('e2e-assertions — toolCalledTimes boundaries', () => {
  test('exactly minCount passes', () => {
    const r = A.toolCalledTimes('Read', 2).run([toolUse('Read'), toolUse('Read')])
    assert.equal(r.passed, true)
  })

  test('minCount-1 fails and reports the actual count', () => {
    const r = A.toolCalledTimes('Read', 2).run([toolUse('Read'), toolUse('Grep')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /called 1 time\(s\), expected at least 2/)
  })

  test('zero matches reports "none" when no tools ran', () => {
    const r = A.toolCalledTimes('Read', 1).run([text('hi')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /Tools used: none/)
  })

  test('name encodes tool and count', () => {
    assert.equal(A.toolCalledTimes('Read', 3).name, 'toolCalledTimes(Read, 3)')
  })
})

describe('e2e-assertions — anyToolCalled', () => {
  test('passes when any one of the set matched', () => {
    const r = A.anyToolCalled(['Write', 'Edit']).run([toolUse('Edit')])
    assert.equal(r.passed, true)
  })

  test('fails listing both the expected set and the observed tools', () => {
    const r = A.anyToolCalled(['Write', 'Edit']).run([toolUse('Read')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /None of \[Write, Edit\] were called/)
    assert.match(r.reason!, /Tools used: Read/)
  })

  test('empty name list can never pass', () => {
    assert.equal(A.anyToolCalled([]).run([toolUse('Read')]).passed, false)
  })
})

describe('e2e-assertions — responseHasMermaidBlock', () => {
  test('passes on a fenced mermaid block with a body', () => {
    const r = A.responseHasMermaidBlock().run([text('```mermaid\ngraph TD;\nA-->B;\n```')])
    assert.equal(r.passed, true)
  })

  test('fails on an empty mermaid fence', () => {
    const r = A.responseHasMermaidBlock().run([text('```mermaid\n```')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /No ```mermaid code block/)
  })

  test('fails on a non-mermaid fence', () => {
    assert.equal(
      A.responseHasMermaidBlock().run([text('```ts\nconst a = 1\n```')]).passed,
      false
    )
  })
})

describe('e2e-assertions — responseHasMarkdownTable', () => {
  test('passes on header + separator + data row', () => {
    const table = '|a|b|\n|---|---|\n|1|2|'
    assert.equal(A.responseHasMarkdownTable().run([text(table)]).passed, true)
  })

  test('fails when the separator row is missing and reports both diagnostics', () => {
    const r = A.responseHasMarkdownTable().run([text('|a|b|\n|1|2|')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /separator: false/)
    assert.match(r.reason!, /pipe rows: 2/)
  })

  test('fails when there are fewer than two pipe rows', () => {
    const r = A.responseHasMarkdownTable().run([text('|---|\n')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /pipe rows: 1/)
  })
})

describe('e2e-assertions — statusEntryMatches / statusEntryMatchesAtLeast', () => {
  test('matches passes when one status matches', () => {
    const r = A.statusEntryMatches(/phase:\s*build/).run([status('phase: build')])
    assert.equal(r.passed, true)
  })

  test('matches fails and enumerates the status entries it saw', () => {
    const r = A.statusEntryMatches(/build/).run([status('plan'), status('verify')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /Status entries: plan; verify/)
  })

  test('matches reports "none" when there are no status entries', () => {
    const r = A.statusEntryMatches(/build/).run([text('hi')])
    assert.match(r.reason!, /Status entries: none/)
  })

  test('atLeast passes at exactly minCount', () => {
    const r = A.statusEntryMatchesAtLeast(/step/, 2).run([status('step 1'), status('step 2')])
    assert.equal(r.passed, true)
    assert.equal(r.reason, undefined)
  })

  test('atLeast fails at minCount-1 and reports the actual match count', () => {
    const r = A.statusEntryMatchesAtLeast(/step/, 2).run([status('step 1'), status('other')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /Only 1 status entries matched/)
  })

  test('atLeast name encodes pattern and count', () => {
    assert.equal(
      A.statusEntryMatchesAtLeast(/step/, 3).name,
      'statusEntryMatchesAtLeast(step, 3)'
    )
  })
})

describe('e2e-assertions — turnCountAtMost / toolCallCountAtMost', () => {
  test('turnCount counts only user text entries', () => {
    const r = A.turnCountAtMost(2).run([
      text('q1', 'user'),
      text('a1', 'assistant'),
      text('q2', 'user'),
      thinking('...')
    ])
    assert.equal(r.passed, true)
    assert.equal(r.reason, undefined)
  })

  test('turnCount fails past the ceiling and reports both numbers', () => {
    const r = A.turnCountAtMost(1).run([text('q1', 'user'), text('q2', 'user')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /User turns 2 exceeded max 1/)
  })

  test('toolCallCount passes at exactly the ceiling', () => {
    const r = A.toolCallCountAtMost(2).run([toolUse('Read'), toolUse('Grep')])
    assert.equal(r.passed, true)
  })

  test('toolCallCount fails one over and reports the ceiling', () => {
    const r = A.toolCallCountAtMost(1).run([toolUse('Read'), toolUse('Grep')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /Tool called 2 times, exceeds ceiling 1/)
  })

  test('tool_result entries are not counted as tool calls', () => {
    const r = A.toolCallCountAtMost(0).run([toolResult('Read', 'contents')])
    assert.equal(r.passed, true)
  })
})

describe('e2e-assertions — thinkingPresent', () => {
  test('passes when a thinking entry exists', () => {
    assert.equal(A.thinkingPresent().run([thinking('reasoning')]).passed, true)
  })

  test('fails with the documented reason otherwise', () => {
    const r = A.thinkingPresent().run([text('answer')])
    assert.equal(r.passed, false)
    assert.equal(r.reason, 'No thinking entries found in transcript')
  })
})

describe('e2e-assertions — validJson extraction', () => {
  const schema = z.object({ answer: z.string() })

  test('parses a whole-text JSON object', () => {
    const r = A.validJson(schema).run([text('{"answer":"yes"}')])
    assert.equal(r.passed, true)
    assert.equal(r.reason, undefined)
  })

  test('unwraps a ```json fenced block', () => {
    const r = A.validJson(schema).run([text('```json\n{"answer":"fenced"}\n```')])
    assert.equal(r.passed, true)
  })

  test('unwraps an unlabelled fenced block', () => {
    assert.equal(A.validJson(schema).run([text('```\n{"answer":"x"}\n```')]).passed, true)
  })

  test('extracts JSON glued directly to preceding prose', () => {
    const r = A.validJson(schema).run([text('Here it is directly.{"answer":"glued"}')])
    assert.equal(r.passed, true)
  })

  test('prefers the LAST schema-valid candidate over an earlier decoy', () => {
    const r = A.validJson(schema).run([
      text('reasoning {"answer": 42} then the real one {"answer":"final"}')
    ])
    assert.equal(r.passed, true)
  })

  test('ignores stray brackets like [T0/Convention] (the removed indexOf bug)', () => {
    const r = A.validJson(schema).run([text('[T0/Convention] {"answer":"ok"}')])
    assert.equal(r.passed, true)
  })

  test('fails with a parse error when no JSON is present at all', () => {
    const r = A.validJson(schema).run([text('just prose, no json')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /Failed to parse JSON/)
  })

  test('fails with schema issues when JSON parses but violates the schema', () => {
    const r = A.validJson(schema).run([text('{"answer":123}')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /JSON schema validation failed/)
    assert.match(r.reason!, /"path"/)
  })

  test('handles a top-level array schema', () => {
    const arr = z.array(z.number())
    assert.equal(A.validJson(arr).run([text('[1,2,3]')]).passed, true)
  })

  test('does not break on braces inside strings', () => {
    const r = A.validJson(schema).run([text('{"answer":"a { brace } inside"}')])
    assert.equal(r.passed, true)
  })

  test('empty transcript fails rather than throwing', () => {
    const r = A.validJson(schema).run([])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /Failed to parse JSON/)
  })
})

describe('e2e-assertions — fileExistsInFixture', () => {
  test('passes on snake_case file_path', () => {
    const r = A.fileExistsInFixture('src/a.ts').run([
      toolUse('Write', { file_path: '/tmp/fx/src/a.ts', content: 'x' })
    ])
    assert.equal(r.passed, true)
  })

  test('passes on camelCase filePath (OpenCode shape)', () => {
    const r = A.fileExistsInFixture('src/a.ts').run([
      toolUse('Write', { filePath: '/tmp/fx/src/a.ts', content: 'x' })
    ])
    assert.equal(r.passed, true)
  })

  test('fails when no Write targeted the path', () => {
    const r = A.fileExistsInFixture('src/a.ts').run([
      toolUse('Write', { file_path: '/tmp/fx/src/b.ts' })
    ])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /No Write tool call found targeting "src\/a\.ts"/)
  })

  test('a non-Write tool on the same path does not satisfy it', () => {
    const r = A.fileExistsInFixture('src/a.ts').run([
      toolUse('Read', { file_path: '/tmp/fx/src/a.ts' })
    ])
    assert.equal(r.passed, false)
  })

  test('contentRegex passes when ANY matching Write has matching content', () => {
    const r = A.fileExistsInFixture('a.ts', /export const/).run([
      toolUse('Write', { file_path: '/fx/a.ts', content: 'nope' }),
      toolUse('Write', { file_path: '/fx/a.ts', content: 'export const x = 1' })
    ])
    assert.equal(r.passed, true)
  })

  test('contentRegex fails when no Write content matches', () => {
    const r = A.fileExistsInFixture('a.ts', /export const/).run([
      toolUse('Write', { file_path: '/fx/a.ts', content: 'nope' })
    ])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /No Write call content matched/)
  })

  test('missing content arg is coerced to empty string, not a throw', () => {
    const r = A.fileExistsInFixture('a.ts', /x/).run([toolUse('Write', { file_path: '/fx/a.ts' })])
    assert.equal(r.passed, false)
  })
})

describe('e2e-assertions — prompt optimizer family', () => {
  test('promptOptimizerRan passes on the tool_use entry', () => {
    assert.equal(A.promptOptimizerRan().run([toolUse('Prompt Optimizer')]).passed, true)
  })

  test('promptOptimizerRan fails on a differently-named tool', () => {
    const r = A.promptOptimizerRan().run([toolUse('Optimizer')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /tool_use entry not found/)
  })

  test('resultPresent fails when there is no tool_result', () => {
    const r = A.promptOptimizerResultPresent().run([toolUse('Prompt Optimizer')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /tool_result not found/)
  })

  test('resultPresent rejects the error sentinel', () => {
    const r = A.promptOptimizerResultPresent().run([
      toolResult('Prompt Optimizer', 'Error — original prompt sent')
    ])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /error sentinel/)
  })

  test('resultPresent passes on non-empty, non-error content', () => {
    const r = A.promptOptimizerResultPresent().run([
      toolResult('Prompt Optimizer', 'Rewritten prompt text')
    ])
    assert.equal(r.passed, true)
  })

  test('resultPresent fails on an empty result body', () => {
    const r = A.promptOptimizerResultPresent().run([toolResult('Prompt Optimizer', '')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /empty\. Results: 1/)
  })

  test('resultPresent falls back to entry.content when toolResult is absent', () => {
    const entry: E2ETranscriptEntry = {
      role: 'assistant',
      type: 'tool_result',
      toolName: 'Prompt Optimizer',
      content: 'from content field',
      timestamp: ts()
    }
    assert.equal(A.promptOptimizerResultPresent().run([entry]).passed, true)
  })

  test('changed fails when no result exists', () => {
    const r = A.promptOptimizerChanged().run([])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /tool_result not found/)
  })

  test('changed rejects each failure sentinel', () => {
    for (const sentinel of [
      'No changes needed',
      'Error — original prompt sent',
      'Optimization failed'
    ]) {
      const r = A.promptOptimizerChanged().run([toolResult('Prompt Optimizer', sentinel)])
      assert.equal(r.passed, false, sentinel)
      assert.match(r.reason!, /did not rewrite/)
    }
  })

  test('changed rejects content shorter than 20 chars', () => {
    const r = A.promptOptimizerChanged().run([toolResult('Prompt Optimizer', 'short')])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /too short \(5 chars\)/)
  })

  test('changed passes at the 20-char boundary', () => {
    const twenty = 'x'.repeat(20)
    assert.equal(A.promptOptimizerChanged().run([toolResult('Prompt Optimizer', twenty)]).passed, true)
  })

  test('changed concatenates multiple results before length-checking', () => {
    const r = A.promptOptimizerChanged().run([
      toolResult('Prompt Optimizer', 'aaaaaaaaaa'),
      toolResult('Prompt Optimizer', 'bbbbbbbbbb')
    ])
    assert.equal(r.passed, true)
  })
})

describe('e2e-assertions — responseBrevityCheck', () => {
  test('fails on an empty response', () => {
    const r = A.responseBrevityCheck().run([])
    assert.equal(r.passed, false)
    assert.equal(r.reason, 'No words in response')
  })

  test('passes on terse caveman-style output', () => {
    const r = A.responseBrevityCheck().run([text('Fix bug. Run test. Ship code.')])
    assert.equal(r.passed, true)
    assert.equal(r.reason, undefined)
  })

  test('flags long average sentence length', () => {
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ') + '.'
    const r = A.responseBrevityCheck({ maxTotalWords: 1000, maxFillerRatio: 1 }).run([text(long)])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /avgWords\/sentence=/)
  })

  test('flags a high filler ratio', () => {
    const r = A.responseBrevityCheck({ maxAvgWordsPerSentence: 999, maxTotalWords: 999 }).run([
      text('the a an the a an the just really basically')
    ])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /fillerRatio=/)
  })

  test('flags total word count over the cap', () => {
    const many = Array.from({ length: 40 }, () => 'x.').join(' ')
    const r = A.responseBrevityCheck({ maxTotalWords: 10 }).run([text(many)])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /totalWords=40 > 10/)
  })

  test('reports every violated dimension at once', () => {
    const wordy = Array.from({ length: 60 }, () => 'the').join(' ')
    const r = A.responseBrevityCheck({
      maxAvgWordsPerSentence: 2,
      maxFillerRatio: 0.01,
      maxTotalWords: 5
    }).run([text(wordy)])
    assert.equal(r.passed, false)
    assert.match(r.reason!, /avgWords\/sentence=/)
    assert.match(r.reason!, /fillerRatio=/)
    assert.match(r.reason!, /totalWords=/)
  })

  test('custom options override the defaults', () => {
    const sentence = 'one two three four five six seven eight nine ten.'
    assert.equal(A.responseBrevityCheck({ maxAvgWordsPerSentence: 20 }).run([text(sentence)]).passed, true)
    assert.equal(
      A.responseBrevityCheck({ maxAvgWordsPerSentence: 3 }).run([text(sentence)]).passed,
      false
    )
  })
})

describe('e2e-assertions — runAssertions aggregation', () => {
  test('returns one result per assertion, in order', () => {
    const results = A.runAssertions(
      [A.responseExists(), A.noErrorChunks(), A.thinkingPresent()],
      [text('hi')]
    )
    assert.equal(results.length, 3)
    assert.deepEqual(
      results.map((r) => r.name),
      ['responseExists', 'noErrorChunks', 'thinkingPresent']
    )
  })

  test('does not short-circuit — mixed pass/fail all evaluate', () => {
    const results = A.runAssertions(
      [A.responseExists(), A.thinkingPresent(), A.noErrorChunks()],
      [text('hi')]
    )
    assert.deepEqual(
      results.map((r) => r.passed),
      [true, false, true]
    )
  })

  test('a throwing assertion is caught and reported as failed', () => {
    const boom: A.E2EAssertion = {
      name: 'explodes',
      run: () => {
        throw new Error('kaboom')
      }
    }
    const results = A.runAssertions([boom, A.responseExists()], [text('hi')])
    assert.equal(results[0].passed, false)
    assert.equal(results[0].name, 'explodes')
    assert.match(results[0].reason!, /Assertion threw: kaboom/)
    // the surviving assertion still ran
    assert.equal(results[1].passed, true)
  })

  test('empty assertion list yields an empty result list', () => {
    assert.deepEqual(A.runAssertions([], [text('hi')]), [])
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
