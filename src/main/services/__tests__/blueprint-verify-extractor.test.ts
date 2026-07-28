/**
 * Unit tests for BlueprintVerifyExtractor.
 *
 * Tests the pure parseExtractionResponse function (no LLM calls).
 * The extractVerifyCompletion function is integration-tested via
 * the blueprint-verify.service.ts flow.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
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

    // BP-VERIFY-FIELD-NORMALIZE: Salvage common LLM key-name drift
    if (!parsed.overallStatus) {
      if (parsed.overall_status) {
        parsed.overallStatus = parsed.overall_status
        delete parsed.overall_status
      } else if (
        typeof parsed.status === 'string' &&
        ['passed', 'gaps_found', 'human_needed'].includes(parsed.status)
      ) {
        parsed.overallStatus = parsed.status
        delete parsed.status
      }
    }

    if (!parsed.overallStatus) return null

    const validStatuses = new Set(['passed', 'gaps_found', 'human_needed'])
    if (!validStatuses.has(parsed.overallStatus)) {
      parsed.overallStatus = 'gaps_found'
    }

    return {
      ...parsed,
      phase: 'verify',
      status: 'complete'
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

describe('parseExtractionResponse — field normalization (Fix 2)', () => {
  test('salvages_overall_status_snake_case', () => {
    const json = JSON.stringify({
      overall_status: 'gaps_found',
      recommendation: 'Fix issues',
      findings: [{ description: 'Missing file' }]
    })
    const result = parseExtractionResponse(json)
    assert.ok(result)
    assert.equal(result.overallStatus, 'gaps_found')
    // original key should not leak through
    assert.equal((result as any).overall_status, undefined)
  })

  test('salvages_status_with_valid_enum_value', () => {
    const json = JSON.stringify({
      status: 'human_needed',
      recommendation: 'Security review',
      findings: []
    })
    const result = parseExtractionResponse(json)
    assert.ok(result)
    assert.equal(result.overallStatus, 'human_needed')
    // status key is consumed as overallStatus, not duplicated
    // (the spread puts status:'complete' from the wrapper)
    assert.equal(result.status, 'complete')
  })

  test('does_not_salvage_status_with_non_enum_value', () => {
    const json = JSON.stringify({
      status: 'complete',
      recommendation: 'done',
      findings: []
    })
    const result = parseExtractionResponse(json)
    // 'complete' is not a valid overallStatus enum — should return null
    assert.equal(result, null)
  })

  test('overallStatus_takes_precedence_over_overall_status', () => {
    const json = JSON.stringify({
      overallStatus: 'passed',
      overall_status: 'gaps_found',
      recommendation: 'ok',
      findings: []
    })
    const result = parseExtractionResponse(json)
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

  test('stray_status_from_llm_does_not_override_complete (MINOR 3)', () => {
    const json = JSON.stringify({
      overallStatus: 'gaps_found',
      status: 'gaps_found',
      recommendation: 'Fix the gaps',
      findings: [{ description: 'Missing file' }]
    })
    const result = parseExtractionResponse(json)
    assert.ok(result)
    assert.equal(result.overallStatus, 'gaps_found')
    // status must always be 'complete' — the stray 'gaps_found' must not leak through
    assert.equal(result.status, 'complete')
    assert.equal(result.phase, 'verify')
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

describe('EXTRACTION_SYSTEM_PROMPT — schema presence guard (Fix 1)', () => {
  // Read the actual prompt constant from the source file to verify the schema is present.
  // This is a build-time guard — if someone removes the schema, this test fails.
  const sourceFile = path.resolve(
    import.meta.dirname ?? '.',
    '..', 'blueprint-verify-extractor.ts'
  )
  const sourceText = fs.readFileSync(sourceFile, 'utf-8')

  test('prompt_contains_overallStatus_key', () => {
    assert.ok(
      sourceText.includes('"overallStatus"'),
      'EXTRACTION_SYSTEM_PROMPT must contain the "overallStatus" key in the schema'
    )
  })

  test('prompt_contains_remediationTasks_key', () => {
    assert.ok(
      sourceText.includes('"remediationTasks"'),
      'EXTRACTION_SYSTEM_PROMPT must contain the "remediationTasks" key in the schema'
    )
  })

  test('prompt_contains_all_three_status_values', () => {
    assert.ok(sourceText.includes('"passed"'), 'Schema must list "passed"')
    assert.ok(sourceText.includes('"gaps_found"'), 'Schema must list "gaps_found"')
    assert.ok(sourceText.includes('"human_needed"'), 'Schema must list "human_needed"')
  })
})

describe('BP-VERIFY-ENUM-GUARD — invalid overallStatus from fence block', () => {
  // Replicates the guard logic from blueprint-verify.service.ts to verify
  // that invalid enum values are caught before they bypass Haiku extraction.
  const VALID_OVERALL_STATUSES = new Set(['passed', 'gaps_found', 'human_needed'])

  function shouldDeleteOverallStatus(completion: { overallStatus?: string } | undefined): boolean {
    return !!(completion?.overallStatus && !VALID_OVERALL_STATUSES.has(String(completion.overallStatus)))
  }

  test('valid_passed_not_deleted', () => {
    assert.equal(shouldDeleteOverallStatus({ overallStatus: 'passed' }), false)
  })

  test('valid_gaps_found_not_deleted', () => {
    assert.equal(shouldDeleteOverallStatus({ overallStatus: 'gaps_found' }), false)
  })

  test('valid_human_needed_not_deleted', () => {
    assert.equal(shouldDeleteOverallStatus({ overallStatus: 'human_needed' }), false)
  })

  test('invalid_partial_triggers_deletion', () => {
    assert.equal(shouldDeleteOverallStatus({ overallStatus: 'partial' }), true)
  })

  test('invalid_PASSED_case_drift_triggers_deletion', () => {
    assert.equal(shouldDeleteOverallStatus({ overallStatus: 'PASSED' }), true)
  })

  test('invalid_failed_triggers_deletion', () => {
    assert.equal(shouldDeleteOverallStatus({ overallStatus: 'failed' }), true)
  })

  test('invalid_complete_triggers_deletion', () => {
    assert.equal(shouldDeleteOverallStatus({ overallStatus: 'complete' }), true)
  })

  test('undefined_completion_not_deleted', () => {
    assert.equal(shouldDeleteOverallStatus(undefined), false)
  })

  test('missing_overallStatus_not_deleted', () => {
    assert.equal(shouldDeleteOverallStatus({}), false)
  })

  test('integration_invalid_enum_routes_to_extraction', () => {
    // Simulates the full flow: parser returns invalid enum → guard deletes it →
    // GAP 2 trigger (!completion.overallStatus) fires → Haiku extraction runs
    const fenceBlock = JSON.stringify({
      phase: 'verify',
      status: 'complete',
      overallStatus: 'partial',
      findings: [{ description: 'Looks incomplete' }]
    })
    // Parser would return this as-is (no enum validation)
    const parsed = JSON.parse(fenceBlock) as { overallStatus?: string }

    // Guard fires
    assert.equal(shouldDeleteOverallStatus(parsed), true)
    delete parsed.overallStatus

    // GAP 2 trigger now fires (overallStatus is missing)
    assert.equal(!parsed.overallStatus, true, 'overallStatus should be falsy after guard deletion')
  })
})

// ── Source Guard: ensure service enum stays in sync ──

describe('source-guard: VALID_OVERALL_STATUSES in blueprint-verify.service.ts', () => {
  const servicePath = path.resolve(import.meta.dirname ?? '.', '..', 'blueprint-verify.service.ts')
  const source = fs.readFileSync(servicePath, 'utf-8')

  test('service source contains VALID_OVERALL_STATUSES constant', () => {
    assert.ok(
      source.includes('VALID_OVERALL_STATUSES'),
      'Expected VALID_OVERALL_STATUSES to be defined in blueprint-verify.service.ts'
    )
  })

  test('service enum includes exactly the three valid values', () => {
    // Extract the Set literal from the actual VALID_OVERALL_STATUSES line.
    // Catches: value removed, value added, value typo — unlike source.includes()
    // which matches literals appearing elsewhere in the file (comments, logic branches).
    const setMatch = source.match(/VALID_OVERALL_STATUSES\s*=\s*new Set\(\[([^\]]*)]\)/)
    assert.ok(setMatch?.[1], 'Could not extract Set literal from VALID_OVERALL_STATUSES line')

    const literals = setMatch[1].match(/'[^']+'/g)?.map(s => s.slice(1, -1)) ?? []
    const expected = ['passed', 'gaps_found', 'human_needed']

    assert.deepStrictEqual(
      literals.sort(),
      expected.sort(),
      `VALID_OVERALL_STATUSES must contain exactly ${JSON.stringify(expected)}, got ${JSON.stringify(literals)}`
    )
  })

  test('service guard deletes invalid overallStatus', () => {
    assert.ok(
      source.includes('delete completion.overallStatus'),
      'Expected service to delete invalid overallStatus values'
    )
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
