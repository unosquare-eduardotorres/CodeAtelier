/**
 * Migrations 69 + 70 — Layer 2 rename + CHECK-constraint tightening.
 *
 * Verified at the SQL shape level. We can't run the full migration in unit
 * tests (it needs a real DB connection), but we can assert the constants
 * + schema.sql are internally consistent with the new names. Migration 70
 * is a pure sqlite_master rewrite so its correctness is validated by the
 * integration smoke test rather than here.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, describe } from './test-harness'
import {
  DA_VINCI_AGENT_ID,
  DEFAULT_MODEL_CONFIG,
  getModelActionForRole
} from '../../../shared/constants'

const schemaPath = join(process.cwd(), 'src/main/db/schema.sql')
const schemaSql = readFileSync(schemaPath, 'utf8')

describe('Layer 2 rename (migration 69)', () => {
  test('DA_VINCI_AGENT_ID wire value is "da-vinci"', () => {
    assert.equal(DA_VINCI_AGENT_ID, 'da-vinci')
  })

  test('DEFAULT_MODEL_CONFIG uses "da-vinci" keys', () => {
    assert.ok(DEFAULT_MODEL_CONFIG['da-vinci'])
    assert.ok(DEFAULT_MODEL_CONFIG['da-vinci:plan'])
    assert.ok(DEFAULT_MODEL_CONFIG['da-vinci:build'])
  })

  test('DEFAULT_MODEL_CONFIG does NOT have legacy "generalist" keys', () => {
    assert.equal('generalist' in DEFAULT_MODEL_CONFIG, false, 'legacy generalist key still present')
  })

  test('getModelActionForRole maps da-vinci → da-vinci:*', () => {
    assert.equal(getModelActionForRole('da-vinci', 'plan'), 'da-vinci:plan')
    assert.equal(getModelActionForRole('da-vinci', 'build'), 'da-vinci:build')
  })

  test('getModelActionForRole maps project-specialist → project-specialist:*', () => {
    assert.equal(getModelActionForRole('project-specialist', 'plan'), 'project-specialist:plan')
    assert.equal(getModelActionForRole('project-specialist', 'build'), 'project-specialist:build')
  })

  test('schema.sql messages.role CHECK accepts da-vinci (and legacy generalist for migration chain)', () => {
    assert.match(
      schemaSql,
      /role\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*role\s+IN\s*\([^)]*'da-vinci'[^)]*\)\s*\)/
    )
  })

  test('schema.sql core_agent_aliases.agent_role CHECK accepts da-vinci', () => {
    assert.match(
      schemaSql,
      /agent_role\s+TEXT\s+PRIMARY\s+KEY\s+CHECK\s*\(\s*agent_role\s+IN\s*\([^)]*'da-vinci'[^)]*\)\s*\)/
    )
  })

  test('schema.sql does not reference dropped tables', () => {
    for (const table of [
      'agent_messages',
      'agent_context',
      'gate_results',
      'specialist_conversation_history',
      'agent_worktrees'
    ]) {
      assert.equal(
        schemaSql.includes(`CREATE TABLE IF NOT EXISTS ${table}`),
        false,
        `schema.sql still declares dropped table: ${table}`
      )
    }
  })

  test('schema.sql conversation_specialists does not have dropped columns', () => {
    // Extract the conversation_specialists table block and assert columns are absent.
    const match = schemaSql.match(/CREATE TABLE IF NOT EXISTS conversation_specialists[\s\S]*?\);/)
    assert.ok(match, 'conversation_specialists table not found in schema.sql')
    const block = match![0]
    assert.equal(block.includes('skill_overrides'), false)
    assert.equal(block.includes('skills_enabled'), false)
  })
})

describe('Migration 70 — tighten CHECK constraints', () => {
  test('CURRENT_SCHEMA_VERSION is at least 70', async () => {
    // Read the migration registry as source text — importing the DB module
    // would require a live better-sqlite3 handle.
    const dbIndexPath = join(process.cwd(), 'src/main/db/index.ts')
    const src = readFileSync(dbIndexPath, 'utf8')
    const versionMatch = src.match(/CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/)
    assert.ok(versionMatch, 'CURRENT_SCHEMA_VERSION declaration missing')
    assert.ok(Number(versionMatch![1]) >= 70, 'CURRENT_SCHEMA_VERSION must be ≥ 70')
    assert.match(src, /version:\s*70/, 'migration 70 entry missing from registry')
    assert.match(src, /tighten-check-constraints-post-rename/, 'migration 70 name mismatch')
  })
})
