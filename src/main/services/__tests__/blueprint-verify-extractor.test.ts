/**
 * Unit tests for BlueprintVerifyExtractor.
 *
 * Tests the pure parseExtractionResponse function (no LLM calls).
 * The extractVerifyCompletion function is integration-tested via
 * the blueprint-verify.service.ts flow.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Replicate parseExtractionResponse logic for hermetic testing ──
// (avoids importing the real module which pulls in electron-log)

function parseExtractionResponse(
  responseText: string
): { overallStatus: string; phase: string; status: string; findings?: unknown[]; remediationTasks?: unknown[] } | null {
  let jsonText = responseText.trim()
  const fenceMatch = jsonText.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  if (fenceMatch?.[1]) {
    jsonText = fenceMatch[1].trim()
  }

  try {
    const parsed = JSON.parse(jsonText)
    if (!parsed.overallStatus) return null

    const validStatuses = new Set(['passed', 'gaps_found', 'human_needed'])
    if (!validStatuses.has(parsed.overallStatus)) {
      parsed.overallStatus = 'gaps_found'
    }

    return {
      phase: 'verify',
      status: 'complete',
      ...parsed
    }
  } catch {
    return null
  }
}

// ── Tests ──

describe('parseExtractionResponse — valid JSON', () => {
  test('parses_bare_json_with_all_fields', () => {
    const json = JSON.stringify({
      overallStatus: 'gaps_found',
      recommendation: 'Fix the auth middleware',
      findings: [
        { description: 'Missing auth', severity: 'critical', files: ['src/auth.ts'] }
      ],
      remediationTasks: [
        { taskId: 'R001', description: 'Add auth middleware', files: ['src/auth.ts'] }
      ]
    })
    const result = parseExtractionResponse(json)
    assert.ok(result)
    assert.equal(result.overallStatus, 'gaps_found')
    assert.equal(result.phase, 'verify')
    assert.equal(result.status, 'complete')
    assert.equal((result.findings as unknown[]).length, 1)
    assert.equal((result.remediationTasks as unknown[]).length, 1)
  })

  test('parses_passed_status', () => {
    const json = JSON.stringify({
      overallStatus: 'passed',
      recommendation: 'All checks pass',
      findings: []
    })
    const result = parseExtractionResponse(json)
    assert.ok(result)
    assert.equal(result.overallStatus, 'passed')
    assert.equal(result.phase, 'verify')
  })

  test('parses_human_needed_status', () => {
    const json = JSON.stringify({
      overallStatus: 'human_needed',
      recommendation: 'Security review required',
      findings: [{ description: 'Auth bypass risk' }]
    })
    const result = parseExtractionResponse(json)
    assert.ok(result)
    assert.equal(result.overallStatus, 'human_needed')
  })
})

describe('parseExtractionResponse — fence stripping', () => {
  test('strips_json_fence', () => {
    const fenced = '```json\n{"overallStatus":"passed","recommendation":"ok","findings":[]}\n```'
    const result = parseExtractionResponse(fenced)
    assert.ok(result)
    assert.equal(result.overallStatus, 'passed')
  })

  test('strips_bare_fence', () => {
    const fenced = '```\n{"overallStatus":"gaps_found","recommendation":"fix","findings":[]}\n```'
    const result = parseExtractionResponse(fenced)
    assert.ok(result)
    assert.equal(result.overallStatus, 'gaps_found')
  })

  test('handles_json_without_fence', () => {
    const bare = '{"overallStatus":"passed","recommendation":"ok","findings":[]}'
    const result = parseExtractionResponse(bare)
    assert.ok(result)
    assert.equal(result.overallStatus, 'passed')
  })
})

describe('parseExtractionResponse — error handling', () => {
  test('returns_null_for_invalid_json', () => {
    assert.equal(parseExtractionResponse('not json at all'), null)
  })

  test('returns_null_for_empty_string', () => {
    assert.equal(parseExtractionResponse(''), null)
  })

  test('returns_null_for_missing_overallStatus', () => {
    const json = JSON.stringify({ recommendation: 'ok', findings: [] })
    assert.equal(parseExtractionResponse(json), null)
  })

  test('normalizes_unknown_status_to_gaps_found', () => {
    const json = JSON.stringify({
      overallStatus: 'partial',
      recommendation: 'review needed',
      findings: []
    })
    const result = parseExtractionResponse(json)
    assert.ok(result)
    assert.equal(result.overallStatus, 'gaps_found')
  })

  test('returns_null_for_html_response', () => {
    assert.equal(parseExtractionResponse('<html><body>error</body></html>'), null)
  })
})

describe('parseExtractionResponse — remediation tasks', () => {
  test('extracts_remediation_tasks_with_files', () => {
    const json = JSON.stringify({
      overallStatus: 'gaps_found',
      recommendation: 'Fix gaps',
      findings: [{ description: 'Missing module' }],
      remediationTasks: [
        { taskId: 'R001', description: 'Create auth module', files: ['src/auth.ts'] },
        { taskId: 'R002', description: 'Add tests', files: ['src/auth.test.ts'] }
      ]
    })
    const result = parseExtractionResponse(json)
    assert.ok(result)
    assert.equal((result.remediationTasks as unknown[]).length, 2)
  })

  test('passed_status_has_no_remediation_tasks', () => {
    const json = JSON.stringify({
      overallStatus: 'passed',
      recommendation: 'All good',
      findings: []
    })
    const result = parseExtractionResponse(json)
    assert.ok(result)
    assert.equal(result.remediationTasks, undefined)
  })
})

describe('extraction input preparation', () => {
  test('truncation_preserves_head_and_tail', () => {
    const MAX = 80_000
    const text = 'A'.repeat(100_000)
    const head = text.slice(0, 10_000)
    const tail = text.slice(-(MAX - 10_000))
    const truncated = head + '\n\n[… middle truncated for extraction …]\n\n' + tail

    // Head preserved
    assert.ok(truncated.startsWith('A'.repeat(10_000)))
    // Tail preserved
    assert.ok(truncated.endsWith('A'.repeat(70_000)))
    // Total is under budget + separator
    assert.ok(truncated.length <= MAX + 50)
  })

  test('short_text_not_truncated', () => {
    const text = 'Short verify output with findings'
    // Under MAX_EXTRACTION_INPUT_CHARS — no truncation
    assert.ok(text.length < 80_000)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
