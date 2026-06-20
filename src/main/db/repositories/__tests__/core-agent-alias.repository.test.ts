/**
 * Unit tests for CoreAgentAliasRepository — upsert-based alias store
 * for core agent roles.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('CoreAgentAliasRepository (skipped — native module unavailable)', () => {
    test('placeholder', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { coreAgentAliasRepository } = require('../core-agent-alias.repository')

  describe('CoreAgentAliasRepository', () => {
    // ── findAll ──

    test('findAll() returns empty array initially', () => {
      // Clear any existing aliases
      env.db.prepare('DELETE FROM core_agent_aliases').run()
      const all = coreAgentAliasRepository.findAll()
      assert.deepEqual(all, [])
    })

    // ── upsert ──

    test('upsert() creates new alias', () => {
      env.db.prepare('DELETE FROM core_agent_aliases').run()
      const alias = coreAgentAliasRepository.upsert('da-vinci', 'Claude', 'avatar-ai')
      assert.equal(alias.agentRole, 'da-vinci')
      assert.equal(alias.alias, 'Claude')
      assert.equal(alias.avatarKey, 'avatar-ai')
      assert.ok(alias.updatedAt, 'should have updatedAt')
    })

    test('upsert() updates existing alias (upsert semantics)', () => {
      env.db.prepare('DELETE FROM core_agent_aliases').run()
      coreAgentAliasRepository.upsert('da-vinci', 'First Name', 'key-1')
      coreAgentAliasRepository.upsert('da-vinci', 'Second Name', 'key-2')

      const all = coreAgentAliasRepository.findAll()
      assert.equal(all.length, 1, 'should have exactly 1 alias (upsert, not insert)')
      assert.equal(all[0].alias, 'Second Name')
      assert.equal(all[0].avatarKey, 'key-2')
    })

    test('findAll() returns all aliases after upsert', () => {
      env.db.prepare('DELETE FROM core_agent_aliases').run()
      coreAgentAliasRepository.upsert('da-vinci', 'Helper', 'key-h')

      const all = coreAgentAliasRepository.findAll()
      assert.equal(all.length, 1)
      assert.equal(all[0].agentRole, 'da-vinci')
      assert.equal(all[0].alias, 'Helper')
    })

    test('upsert() handles null alias and avatarKey', () => {
      env.db.prepare('DELETE FROM core_agent_aliases').run()
      const alias = coreAgentAliasRepository.upsert('da-vinci', null, null)
      assert.equal(alias.agentRole, 'da-vinci')
      assert.equal(alias.alias, null)
      assert.equal(alias.avatarKey, null)
    })
  })
}
