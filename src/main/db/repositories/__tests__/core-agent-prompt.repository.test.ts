/**
 * Tests for CoreAgentPromptRepository — findByRoleAndMode, upsert, resetToDefault.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('CoreAgentPromptRepository (skipped — native module unavailable)', () => {
    test('findByRoleAndMode()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId: _wsId } = env
  const { coreAgentPromptRepository } = require('../core-agent-prompt.repository')

  // Seed core_agent_prompts (the schema may not have seeds, so insert them)
  const modes = ['plan', 'build', 'danger'] as const
  for (const mode of modes) {
    db.prepare(
      `INSERT OR IGNORE INTO core_agent_prompts (agent_role, mode, prompt_text, default_prompt_text, is_custom)
       VALUES (?, ?, ?, ?, ?)`
    ).run('da-vinci', mode, `Default ${mode} prompt`, `Default ${mode} prompt`, 0)
  }

  describe('CoreAgentPromptRepository', () => {
    test('findAll() returns all prompts', () => {
      const all = coreAgentPromptRepository.findAll()
      assert.ok(all.length >= 3)
      assert.ok(all.some((p: any) => p.mode === 'plan'))
      assert.ok(all.some((p: any) => p.mode === 'build'))
      assert.ok(all.some((p: any) => p.mode === 'danger'))
    })

    test('findByRoleAndMode() finds specific prompt', () => {
      const prompt = coreAgentPromptRepository.findByRoleAndMode('da-vinci', 'plan')
      assert.ok(prompt)
      assert.equal(prompt.agentRole, 'da-vinci')
      assert.equal(prompt.mode, 'plan')
      assert.equal(prompt.isCustom, false)
    })

    test('findByRoleAndMode() returns undefined for unknown combination', () => {
      // The only valid role is 'da-vinci', so a bad mode should not exist
      const found = coreAgentPromptRepository.findByRoleAndMode('da-vinci', 'nonexistent' as any)
      assert.equal(found, undefined)
    })

    test('mapRow() converts is_custom to boolean', () => {
      const prompt = coreAgentPromptRepository.findByRoleAndMode('da-vinci', 'plan')
      assert.equal(typeof prompt!.isCustom, 'boolean')
    })

    test('upsert() customizes prompt and marks isCustom', () => {
      const updated = coreAgentPromptRepository.upsert('da-vinci', 'plan', 'Custom plan prompt')
      assert.equal(updated.promptText, 'Custom plan prompt')
      assert.equal(updated.isCustom, true)

      // Verify persistence
      const found = coreAgentPromptRepository.findByRoleAndMode('da-vinci', 'plan')
      assert.equal(found!.promptText, 'Custom plan prompt')
      assert.equal(found!.isCustom, true)
    })

    test('upsert() throws for nonexistent role/mode', () => {
      assert.throws(
        () => coreAgentPromptRepository.upsert('da-vinci', 'nonexistent' as any, 'X'),
        /not found/i
      )
    })

    test('resetToDefault() restores default prompt', () => {
      // First customize it
      coreAgentPromptRepository.upsert('da-vinci', 'build', 'Custom build')
      // Then reset
      const reset = coreAgentPromptRepository.resetToDefault('da-vinci', 'build')
      assert.equal(reset.promptText, 'Default build prompt')
      assert.equal(reset.isCustom, false)
    })

    test('resetToDefault() throws for nonexistent role/mode', () => {
      assert.throws(
        () => coreAgentPromptRepository.resetToDefault('da-vinci', 'nonexistent' as any),
        /not found/i
      )
    })

    test('upsert() updates updatedAt timestamp', () => {
      const before = coreAgentPromptRepository.findByRoleAndMode('da-vinci', 'danger')
      const beforeTs = before!.updatedAt
      coreAgentPromptRepository.upsert('da-vinci', 'danger', 'New danger prompt')
      const after = coreAgentPromptRepository.findByRoleAndMode('da-vinci', 'danger')
      assert.ok(after!.updatedAt >= beforeTs)
    })
  })
}
