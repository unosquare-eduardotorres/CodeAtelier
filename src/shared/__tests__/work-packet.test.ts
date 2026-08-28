/**
 * Unit tests for work-packet extraction and prompt rendering.
 *
 * The packet is the gate contract, so the parser's bias matters: a half-filled
 * packet is kept (its `allowedFiles` still makes the write-set gate real),
 * while a criterion with no stated check is dropped (nothing could settle it).
 *
 * Run: tsx src/shared/__tests__/work-packet.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../main/services/__tests__/test-harness'
import { extractWorkPacket } from '../work-packet-parser'
import { isPacketActionable, renderWorkPacket } from '../work-packet-prompt'

describe('extractWorkPacket', () => {
  test('reads a full nested packet', () => {
    const packet = extractWorkPacket({
      taskId: 'T001',
      packet: {
        allowedFiles: ['src/a.ts'],
        forbiddenFiles: ['db/schema.sql'],
        testFiles: ['src/a.test.ts'],
        testCommand: 'npm test src/a.test.ts',
        conventions: ['repositories return null on a miss'],
        interfaces: ['export function a(): void'],
        acceptanceCriteria: [{ text: 'a() exists', howVerified: 'npm test' }],
        contextExcerpts: [{ path: 'src/b.ts', excerpt: 'const b = 1', note: 'pattern' }]
      }
    })
    assert.deepEqual(packet?.allowedFiles, ['src/a.ts'])
    assert.deepEqual(packet?.testFiles, ['src/a.test.ts'])
    assert.equal(packet?.testCommand, 'npm test src/a.test.ts')
    assert.equal(packet?.acceptanceCriteria?.length, 1)
    assert.equal(packet?.contextExcerpts?.[0].note, 'pattern')
  })

  test('reads the same fields inline on the task — models emit both shapes', () => {
    const packet = extractWorkPacket({
      taskId: 'T001',
      allowedFiles: ['src/a.ts'],
      testFiles: ['src/a.test.ts']
    })
    assert.deepEqual(packet?.allowedFiles, ['src/a.ts'])
  })

  test('falls back to the legacy `files` field so old task shapes still gate', () => {
    const packet = extractWorkPacket({ taskId: 'T001', files: ['src/legacy.ts'] })
    assert.deepEqual(packet?.allowedFiles, ['src/legacy.ts'])
  })

  // ── R1.1 — testCommand sanitisation (security) ──

  test('R1.1: a testCommand with shell metacharacters is dropped at parse time', () => {
    const injections = [
      'npm test; rm -rf /',
      'npm test && curl http://evil.example',
      'npm test | sh',
      'npm test > /etc/passwd',
      'npm test `whoami`',
      'npm test $(id)',
      'npm test {1..3}',
      'npm\ntest',
      'npm\rtest'
    ]
    for (const injection of injections) {
      const packet = extractWorkPacket({ packet: { testCommand: injection } })
      assert.equal(
        packet?.testCommand,
        undefined,
        `injection must be dropped: ${JSON.stringify(injection)}`
      )
    }
  })

  test('R1.1: an over-long testCommand is dropped (500-char cap)', () => {
    const packet = extractWorkPacket({
      packet: { testCommand: 'a'.repeat(501) }
    })
    assert.equal(packet?.testCommand, undefined)
  })

  test('R1.1: a safe testCommand survives sanitisation', () => {
    for (const safe of [
      'npm run test:unit',
      'npx vitest run src/a.test.ts',
      'pytest tests/test_a.py',
      'go test ./pkg/foo'
    ]) {
      const packet = extractWorkPacket({ packet: { testCommand: safe } })
      assert.equal(packet?.testCommand, safe)
    }
  })

  test('R1.1: dropping an unsafe testCommand does not discard the rest of the packet', () => {
    const packet = extractWorkPacket({
      packet: {
        allowedFiles: ['src/a.ts'],
        testFiles: ['src/a.test.ts'],
        testCommand: 'npm test; rm -rf /'
      }
    })
    assert.deepEqual(packet?.allowedFiles, ['src/a.ts'])
    assert.deepEqual(packet?.testFiles, ['src/a.test.ts'])
    assert.equal(packet?.testCommand, undefined)
  })

  test('an acceptance criterion without howVerified is dropped — nothing could settle it', () => {
    const packet = extractWorkPacket({
      packet: {
        allowedFiles: ['src/a.ts'],
        acceptanceCriteria: [
          { text: 'it works well' },
          { text: 'returns 404', howVerified: 'curl -i /x | head -1' }
        ]
      }
    })
    assert.equal(packet?.acceptanceCriteria?.length, 1)
    assert.equal(packet?.acceptanceCriteria?.[0].text, 'returns 404')
  })

  test('snake_case how_verified is accepted', () => {
    const packet = extractWorkPacket({
      packet: { acceptanceCriteria: [{ text: 'x', how_verified: 'npm test' }] }
    })
    assert.equal(packet?.acceptanceCriteria?.[0].howVerified, 'npm test')
  })

  test('a malformed optional field does not discard the usable rest of the packet', () => {
    const packet = extractWorkPacket({
      packet: {
        allowedFiles: ['src/a.ts'],
        contextExcerpts: 'oops, a string',
        conventions: [42, null],
        interfaces: {}
      }
    })
    assert.deepEqual(packet?.allowedFiles, ['src/a.ts'])
    assert.equal(packet?.contextExcerpts, undefined)
    assert.equal(packet?.conventions, undefined)
  })

  test('a task with nothing packet-shaped returns null, so gates can say no_packet', () => {
    assert.equal(extractWorkPacket({ taskId: 'T001', description: 'do a thing' }), null)
    assert.equal(extractWorkPacket(null), null)
    assert.equal(extractWorkPacket('nope'), null)
    assert.equal(extractWorkPacket([]), null)
  })

  test('empty and whitespace-only list entries are dropped', () => {
    const packet = extractWorkPacket({ packet: { allowedFiles: ['  ', '', 'src/a.ts'] } })
    assert.deepEqual(packet?.allowedFiles, ['src/a.ts'])
  })

  test('conventions are capped so a style guide cannot crowd out the task', () => {
    const packet = extractWorkPacket({
      packet: { conventions: Array.from({ length: 30 }, (_, i) => `rule ${i}`) }
    })
    assert.equal(packet?.conventions?.length, 8)
  })

  test('an oversized excerpt is truncated rather than dropped', () => {
    const packet = extractWorkPacket({
      packet: { contextExcerpts: [{ path: 'a.ts', excerpt: 'x'.repeat(50_000) }] }
    })
    assert.equal(packet?.contextExcerpts?.[0].excerpt.length, 8000)
  })
})

describe('renderWorkPacket', () => {
  const packet = {
    allowedFiles: ['src/a.ts'],
    forbiddenFiles: ['db/schema.sql'],
    testFiles: ['src/a.test.ts'],
    testCommand: 'npm test src/a.test.ts',
    acceptanceCriteria: [{ text: 'returns 404', howVerified: 'npm test' }],
    conventions: ['repositories return null on a miss'],
    interfaces: ['export function a(): void'],
    contextExcerpts: [{ path: 'src/b.ts', excerpt: 'const b = 1' }]
  }

  test('every section reaches the prompt', () => {
    const text = renderWorkPacket(packet)
    for (const needle of [
      'src/a.ts',
      'db/schema.sql',
      'src/a.test.ts',
      'npm test src/a.test.ts',
      'returns 404',
      'repositories return null on a miss',
      'export function a(): void',
      'const b = 1'
    ]) {
      assert.ok(text.includes(needle), `missing from the rendered packet: ${needle}`)
    }
  })

  test('the tests are described as the specification, not as editable', () => {
    const text = renderWorkPacket(packet)
    assert.ok(/do not edit, delete, skip or weaken them/i.test(text))
  })

  test('strict mode forbids exploration outright for small local models', () => {
    assert.ok(/do not explore the codebase/i.test(renderWorkPacket(packet, { strict: true })))
    assert.ok(!/do not explore the codebase/i.test(renderWorkPacket(packet)))
  })

  test('a null packet renders nothing rather than an empty heading', () => {
    assert.equal(renderWorkPacket(null), '')
    assert.equal(renderWorkPacket(undefined), '')
  })

  test('excerpt rendering is bounded in total', () => {
    const big = {
      contextExcerpts: Array.from({ length: 12 }, (_, i) => ({
        path: `f${i}.ts`,
        excerpt: 'y'.repeat(8000)
      }))
    }
    assert.ok(renderWorkPacket(big).length < 30_000)
  })
})

describe('isPacketActionable', () => {
  test('a packet with a write-set, tests or ACs is actionable', () => {
    assert.equal(isPacketActionable({ allowedFiles: ['a.ts'] }), true)
    assert.equal(isPacketActionable({ testFiles: ['a.test.ts'] }), true)
    assert.equal(
      isPacketActionable({ acceptanceCriteria: [{ text: 'x', howVerified: 'y' }] }),
      true
    )
  })

  test('conventions alone are not actionable — nothing there can be checked', () => {
    assert.equal(isPacketActionable({ conventions: ['be nice'] }), false)
    assert.equal(isPacketActionable(null), false)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
