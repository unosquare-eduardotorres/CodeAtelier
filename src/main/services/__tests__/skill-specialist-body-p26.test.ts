/**
 * Phase 26 Wave 5 — skill.service.ts + specialist-builder.service.ts deep coverage.
 *
 * R003: rewritten to assert real behaviour instead of bare catch{} swallows
 * and typeof-guard skips. importSkill/buildSpecialist (the old test's guessed
 * method names — the real one is buildProjectSpecialist) both end in a real
 * `claude`/Opus process spawn, which FR-023 forbids exercising directly.
 * Instead:
 *  - validateSkillFile is pure filesystem logic (no spawn) — tested against
 *    real temp files, hermetically.
 *  - buildProjectSpecialist's "workspace not found" guard is exercised for
 *    real: the mocked `db.prepare(...).get()` returns null by default, so
 *    the lookup genuinely fails and the method genuinely throws — no LLM
 *    call is ever reached.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test, beforeEach, afterEach } from './test-harness'
import { setupFullMock, resetAllMocks } from './setup-full-mock'
import { SKILL_MAX_FILE_SIZE_BYTES } from '../../../shared/constants'
setupFullMock()

const { skillService } = require('../skill.service')
const { specialistBuilderService } = require('../specialist-builder.service')

describe('Skill & SpecialistBuilder (P26-W5)', () => {
  let tmpDir: string

  beforeEach(() => {
    resetAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'ca-skill-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('services export the real class instances', () => {
    assert.ok(skillService)
    assert.ok(specialistBuilderService)
    assert.equal(typeof skillService.validateSkillFile, 'function')
    assert.equal(typeof specialistBuilderService.buildProjectSpecialist, 'function')
  })

  // ─── SkillService.validateSkillFile — pure filesystem logic ─────────────
  test('validateSkillFile rejects a file that does not exist', () => {
    const result = skillService.validateSkillFile(join(tmpDir, 'nope.md'))
    assert.equal(result.valid, false)
    assert.equal(result.error, 'File not found')
  })

  test('validateSkillFile rejects a file missing the "Last updated" field', () => {
    const filePath = join(tmpDir, 'my-skill.md')
    writeFileSync(filePath, '# My Skill\n\nSome instructions with no date field.')

    const result = skillService.validateSkillFile(filePath)
    assert.equal(result.valid, false)
    assert.match(result.error, /Last updated/)
  })

  test('validateSkillFile rejects a file larger than the max size', () => {
    const filePath = join(tmpDir, 'huge-skill.md')
    const oversized = 'x'.repeat(SKILL_MAX_FILE_SIZE_BYTES + 1)
    writeFileSync(filePath, oversized)

    const result = skillService.validateSkillFile(filePath)
    assert.equal(result.valid, false)
    assert.match(result.error, /File too large/)
  })

  test('validateSkillFile accepts a well-formed skill file and extracts its date', () => {
    const filePath = join(tmpDir, 'good-skill.md')
    writeFileSync(filePath, '# Good Skill\n\nDoes useful things.\n\nLast updated: 2026-01-15\n')

    const result = skillService.validateSkillFile(filePath)
    assert.equal(result.valid, true)
    assert.equal(result.lastUpdated, '2026-01-15')
    assert.equal(result.error, undefined)
  })

  // ─── SpecialistBuilderService.buildProjectSpecialist — real guard clause ──
  test('buildProjectSpecialist throws when the workspace does not exist', async () => {
    // The mocked db.prepare(...).get() returns null by default — the SELECT
    // genuinely finds nothing, so this exercises the real not-found guard,
    // never reaching the LLM/tech-detection path (FR-023 respected).
    await assert.rejects(
      specialistBuilderService.buildProjectSpecialist('ws-does-not-exist'),
      /Workspace ws-does-not-exist not found/
    )
  })

  test('rebuildPrompt throws when the specialist does not exist', async () => {
    await assert.rejects(
      specialistBuilderService.rebuildPrompt('specialist-missing'),
      /Specialist specialist-missing not found/
    )
  })
})
