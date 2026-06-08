/**
 * Unit tests for audit-response-parser.ts — extraction strategies, coverage
 * gate, score inference, severity normalization, inline-score extraction, and
 * analysis-preview building.
 *
 * Pure logic, no external deps (randomUUID + electron-log only). Each public
 * function is exercised across its branches; the four parse strategies are
 * covered end-to-end via parseAuditResponse.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  parseAuditResponse,
  applyCoverageGate,
  inferScoreFromFindings,
  type ParsedAuditResponse
} from '../audit-response-parser'
import type { AuditFinding, AuditCoverageStats } from '../../../shared/types'

function finding(severity: AuditFinding['severity'], overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    id: 'x',
    severity,
    title: 'T',
    description: 'D',
    ...overrides
  }
}

describe('audit-response-parser › parseAuditResponse — Strategy 1: progressive blocks', () => {
  test('parses audit-finding blocks + audit-score block', () => {
    const text = [
      '```audit-finding',
      '{"severity":"high","title":"SQL injection","description":"unsanitized input","filePath":"db.ts","recommendation":"use params"}',
      '```',
      '```audit-finding',
      '{"severity":"low","title":"Style nit","description":"spacing"}',
      '```',
      '```audit-score',
      '{"score":72,"summary":"Two issues found"}',
      '```'
    ].join('\n')

    const result = parseAuditResponse(text)
    assert.equal(result.score, 72)
    assert.equal(result.summary, 'Two issues found')
    assert.equal(result.findings.length, 2)
    assert.equal(result.findings[0].severity, 'high')
    assert.equal(result.findings[0].title, 'SQL injection')
    assert.equal(result.findings[0].filePath, 'db.ts')
    assert.equal(result.findings[0].recommendation, 'use params')
    // Each finding gets a generated UUID
    assert.ok(result.findings[0].id && result.findings[0].id !== result.findings[1].id)
  })

  test('infers score from findings when audit-score block is absent', () => {
    const text = [
      '```audit-finding',
      '{"severity":"critical","title":"RCE"}',
      '```'
    ].join('\n')

    const result = parseAuditResponse(text)
    // critical penalty = 25 → 100 - 25 = 75
    assert.equal(result.score, 75)
    assert.match(result.summary, /Partial audit: 1 finding discovered/)
    assert.equal(result.findings.length, 1)
  })

  test('pluralizes the partial-audit summary for multiple findings', () => {
    const text = [
      '```audit-finding',
      '{"severity":"low","title":"a"}',
      '```',
      '```audit-finding',
      '{"severity":"low","title":"b"}',
      '```'
    ].join('\n')
    const result = parseAuditResponse(text)
    assert.match(result.summary, /2 findings discovered/)
  })

  test('falls back to inferred score when audit-score JSON is malformed', () => {
    const text = [
      '```audit-finding',
      '{"severity":"medium","title":"x"}',
      '```',
      '```audit-score',
      '{ not valid json',
      '```'
    ].join('\n')
    const result = parseAuditResponse(text)
    // medium penalty = 8 → 92, and summary is the partial-audit message
    assert.equal(result.score, 92)
    assert.match(result.summary, /Partial audit/)
  })

  test('skips malformed individual findings but keeps valid ones', () => {
    const text = [
      '```audit-finding',
      '{ broken',
      '```',
      '```audit-finding',
      '{"severity":"high","title":"ok"}',
      '```'
    ].join('\n')
    const result = parseAuditResponse(text)
    assert.equal(result.findings.length, 1)
    assert.equal(result.findings[0].title, 'ok')
  })

  test('matches inline-format finding blocks (tag + JSON on same line)', () => {
    const text = '```audit-finding {"severity":"low","title":"inline"} ```'
    const result = parseAuditResponse(text)
    assert.equal(result.findings.length, 1)
    assert.equal(result.findings[0].title, 'inline')
  })

  test('defaults missing finding fields (title/description/severity)', () => {
    const text = ['```audit-finding', '{}', '```'].join('\n')
    const result = parseAuditResponse(text)
    assert.equal(result.findings[0].title, 'Untitled finding')
    assert.equal(result.findings[0].description, '')
    assert.equal(result.findings[0].severity, 'info')
    assert.equal(result.findings[0].filePath, undefined)
    assert.equal(result.findings[0].recommendation, undefined)
  })
})

describe('audit-response-parser › parseAuditResponse — Strategy 2: legacy JSON block', () => {
  test('parses a single ```json block', () => {
    const text = [
      'Here is the audit:',
      '```json',
      '{"score":88,"summary":"Looks good","findings":[{"severity":"low","title":"nit","description":"d","filePath":"a.ts","recommendation":"r"}]}',
      '```'
    ].join('\n')
    const result = parseAuditResponse(text)
    assert.equal(result.score, 88)
    assert.equal(result.summary, 'Looks good')
    assert.equal(result.findings.length, 1)
    assert.equal(result.findings[0].filePath, 'a.ts')
  })

  test('uses the last json block when several exist', () => {
    const text = [
      '```json',
      '{"score":10,"summary":"first","findings":[]}',
      '```',
      '```json',
      '{"score":90,"summary":"second","findings":[]}',
      '```'
    ].join('\n')
    const result = parseAuditResponse(text)
    assert.equal(result.score, 90)
    assert.equal(result.summary, 'second')
  })

  test('clamps and rounds out-of-range scores; non-array findings → []', () => {
    const text = '```json\n{"score":150.7,"summary":"x","findings":"oops"}\n```'
    const result = parseAuditResponse(text)
    assert.equal(result.score, 100)
    assert.deepEqual(result.findings, [])
  })

  test('returns failure summary for malformed JSON in the block', () => {
    const text = '```json\n{ totally broken\n```'
    const result = parseAuditResponse(text)
    assert.equal(result.score, 0)
    assert.match(result.summary, /Failed to parse auditor response JSON/)
  })

  test('normalizes invalid severity to info and filters non-object findings', () => {
    const text =
      '```json\n{"score":50,"summary":"s","findings":[{"severity":"BOGUS","title":"t"},null,42]}\n```'
    const result = parseAuditResponse(text)
    assert.equal(result.findings.length, 1)
    assert.equal(result.findings[0].severity, 'info')
  })
})

describe('audit-response-parser › parseAuditResponse — Strategy 3: bare JSON fallback', () => {
  test('extracts a bare JSON object containing score + findings', () => {
    const text =
      'preamble {"score":65,"summary":"bare","findings":[{"severity":"medium","title":"m"}]} trailing'
    const result = parseAuditResponse(text)
    assert.equal(result.score, 65)
    assert.equal(result.summary, 'bare')
    assert.equal(result.findings.length, 1)
  })
})

describe('audit-response-parser › parseAuditResponse — Strategy 4: inline/preview fallback', () => {
  test('extracts inline "Score: NN/100" and builds a preview summary', () => {
    const text =
      'I reviewed the module thoroughly across several files and dimensions.\n\n' +
      'Overall the codebase is reasonably well structured with decent tests.\n\n' +
      'Score: 85/100 based on the above analysis.'
    const result = parseAuditResponse(text)
    assert.equal(result.score, 85)
    assert.ok(result.summary.length > 0)
    assert.equal(result.findings.length, 0)
  })

  test('matches "Rating: NN" pattern', () => {
    const text =
      'A long-enough analysis paragraph that exceeds the twenty character preview floor.\n\nRating: 42'
    const result = parseAuditResponse(text)
    assert.equal(result.score, 42)
  })

  test('matches "NN/100 overall" reversed pattern', () => {
    const text =
      'A long-enough analysis paragraph that exceeds the twenty character preview floor.\n\n90/100 overall'
    const result = parseAuditResponse(text)
    assert.equal(result.score, 90)
  })

  test('score=0 and default summary when no inline score and text is tiny', () => {
    const result = parseAuditResponse('nope')
    assert.equal(result.score, 0)
    assert.equal(result.summary, 'No structured response received from auditor.')
    assert.deepEqual(result.findings, [])
  })

  test('preview strips tool-use artifacts and prefers trailing paragraphs', () => {
    const text = [
      '```tool_use',
      'Read file foo.ts',
      '```',
      '[Tool call: Grep pattern=x]',
      '',
      'This first conclusion paragraph is well over twenty characters long here.',
      '',
      'This final conclusion paragraph is also well over twenty characters long.'
    ].join('\n')
    const result = parseAuditResponse(text)
    assert.equal(result.score, 0)
    assert.ok(!result.summary.includes('tool_use'))
    assert.ok(!result.summary.includes('[Tool call:'))
    assert.match(result.summary, /final conclusion paragraph/)
  })

  test('preview truncates very long summaries with an ellipsis', () => {
    const para = 'x'.repeat(2000)
    const result = parseAuditResponse(para)
    assert.ok(result.summary.length <= 1001)
    assert.ok(result.summary.endsWith('…'))
  })

  test('preview falls back to first 800 chars when no qualifying paragraphs', () => {
    // Single block of text with no blank-line separators, > 20 chars.
    const text = 'a'.repeat(50)
    const result = parseAuditResponse(text)
    assert.equal(result.summary, 'a'.repeat(50))
  })
})

describe('audit-response-parser › inferScoreFromFindings', () => {
  test('empty findings → 0', () => {
    assert.equal(inferScoreFromFindings([]), 0)
  })

  test('severity-weighted penalties subtract from 100', () => {
    // high (15) + medium (8) + low (3) = 26 → 74
    const score = inferScoreFromFindings([finding('high'), finding('medium'), finding('low')])
    assert.equal(score, 74)
  })

  test('info findings carry no penalty', () => {
    assert.equal(inferScoreFromFindings([finding('info'), finding('info')]), 100)
  })

  test('clamps to a floor of 10 for catastrophic penalty totals', () => {
    const many = Array.from({ length: 10 }, () => finding('critical'))
    assert.equal(inferScoreFromFindings(many), 10)
  })
})

describe('audit-response-parser › applyCoverageGate', () => {
  const stats: AuditCoverageStats = {
    fileCount: 3,
    toolCallCount: 10
  } as AuditCoverageStats

  function parsed(findingCount: number): ParsedAuditResponse {
    return {
      score: 80,
      summary: 's',
      findings: Array.from({ length: findingCount }, () => finding('low'))
    }
  }

  test('sufficient when findings ≥ 3 and files ≥ 2', () => {
    const result = applyCoverageGate(parsed(3), stats)
    assert.equal(result.isSufficient, true)
    assert.equal(result.coverageStats, stats)
    assert.equal(result.coveragePercent, null)
    // Passthrough of parsed fields
    assert.equal(result.score, 80)
  })

  test('insufficient when too few findings', () => {
    const result = applyCoverageGate(parsed(2), stats)
    assert.equal(result.isSufficient, false)
  })

  test('insufficient when too few files even with enough findings', () => {
    const lowFiles = { fileCount: 1, toolCallCount: 5 } as AuditCoverageStats
    const result = applyCoverageGate(parsed(5), lowFiles)
    assert.equal(result.isSufficient, false)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
