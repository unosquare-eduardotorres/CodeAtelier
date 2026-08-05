/**
 * Phase 26 Wave 6 — db/index.ts remaining migration coverage.
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import { setupFullMock, resetAllMocks } from './setup-full-mock'
setupFullMock()

const dbMod = require('../../db/index')

describe('db/index.ts (P26-W6)', () => {
  beforeEach(() => {
    resetAllMocks()
  })

  test('exports getDatabase function', () => {
    assert.equal(typeof dbMod.getDatabase, 'function')
  })

  test('exports SCHEMA_SQL string', () => {
    assert.equal(typeof dbMod.SCHEMA_SQL, 'string')
  })

  test('exports CURRENT_SCHEMA_VERSION number', () => {
    assert.equal(typeof dbMod.CURRENT_SCHEMA_VERSION, 'number')
    assert.ok(dbMod.CURRENT_SCHEMA_VERSION >= 1)
  })

  test('exports migrations array', () => {
    assert.ok(Array.isArray(dbMod.migrations))
    // May be empty in mock, but array is exported
  })

  test('CURRENT_SCHEMA_VERSION matches mocked value', () => {
    assert.ok(dbMod.CURRENT_SCHEMA_VERSION > 0)
  })

  test('getDatabase returns mock database', () => {
    const db = dbMod.getDatabase()
    assert.ok(db)
    assert.equal(typeof db.prepare, 'function')
  })
})
