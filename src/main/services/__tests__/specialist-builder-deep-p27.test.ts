/**
 * Phase 27 — specialist-builder.service.ts surface + guard-clause coverage.
 *
 * SpecialistBuilderService reads through raw `getDatabase().prepare(...)` SQL,
 * not through repositories, so the mock db (whose `.get()` yields null) drives
 * every "not found" guard deterministically. Those guards are the only branches
 * reachable without a real sqlite file, so they are what this file asserts.
 */
import assert from 'node:assert/strict'
import { describe, test } from './test-harness'
import { setupFullMock, createSpy, mockService } from './setup-full-mock'

setupFullMock()

mockService('model-config.service', {
  modelConfigService: { getModelById: createSpy(() => 'claude-haiku-4-5') }
})
mockService('one-shot-claude', {
  runOneShotClaude: createSpy(async () => ({
    text: '```specialist-profile\n{"name":"Test Specialist","prompt":"You are an expert","skills":[]}\n```'
  }))
})

const mod = require('../specialist-builder.service')
const { SpecialistBuilderService, specialistBuilderService } = mod

describe('SpecialistBuilderService — class structure (P27)', () => {
  test('class is exported', () => {
    assert.equal(typeof SpecialistBuilderService, 'function')
  })

  test('singleton is exported', () => {
    assert.ok(specialistBuilderService instanceof SpecialistBuilderService)
  })

  test('exposes the three public build entrypoints', () => {
    // Named explicitly rather than via a `build || createSpecialist || ...`
    // fallback chain: that fallback shape let the assertion pass against an
    // API which never existed on this class.
    assert.equal(typeof specialistBuilderService.buildProjectSpecialist, 'function')
    assert.equal(typeof specialistBuilderService.rebuildPrompt, 'function')
    assert.equal(typeof specialistBuilderService.rebuildSkills, 'function')
  })

  test('does not expose the legacy build/createSpecialist/generateSpecialist names', () => {
    assert.equal(specialistBuilderService.build, undefined)
    assert.equal(specialistBuilderService.createSpecialist, undefined)
    assert.equal(specialistBuilderService.generateSpecialist, undefined)
  })
})

describe('SpecialistBuilderService — not-found guards (P27)', () => {
  test('buildProjectSpecialist rejects when the workspace row is missing', async () => {
    await assert.rejects(
      () => specialistBuilderService.buildProjectSpecialist('ws-missing'),
      /Workspace ws-missing not found/
    )
  })

  test('rebuildPrompt rejects when the specialist row is missing', async () => {
    await assert.rejects(
      () => specialistBuilderService.rebuildPrompt('spec-missing'),
      /Specialist spec-missing not found/
    )
  })

  test('rebuildSkills rejects when the specialist row is missing', async () => {
    await assert.rejects(
      () => specialistBuilderService.rebuildSkills('spec-missing'),
      /Specialist spec-missing not found/
    )
  })
})
