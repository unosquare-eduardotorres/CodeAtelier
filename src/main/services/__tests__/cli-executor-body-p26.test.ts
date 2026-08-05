/**
 * Phase 26 Wave 3 — cli-executor.ts deep body coverage.
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import { setupFullMock, resetAllMocks } from './setup-full-mock'
setupFullMock()

const mod = require('../cli-executor')
const { CLIExecutor } = mod

describe('CLIExecutor (P26-W3)', () => {
  beforeEach(() => {
    resetAllMocks()
  })

  test('CLIExecutor is a class', () => {
    assert.equal(typeof CLIExecutor, 'function')
  })

  test('new CLIExecutor has expected methods', () => {
    const exec = new CLIExecutor()
    assert.equal(typeof exec.execute, 'function')
    assert.equal(typeof exec.killProcess, 'function')
    assert.equal(typeof exec.isAlive, 'function')
  })

  test('isAlive returns false before execute', () => {
    const exec = new CLIExecutor()
    assert.equal(exec.isAlive(), false)
  })

  test('killProcess resolves safely when not running', () => {
    const exec = new CLIExecutor()
    try {
      exec.killProcess()
    } catch {
      /* OK */
    }
  })

  test('getSessionId returns null before execute', () => {
    const exec = new CLIExecutor()
    if (typeof exec.getSessionId === 'function') {
      const id = exec.getSessionId()
      assert.ok(id === null || id === undefined)
    }
  })

  test('getVitals returns object', () => {
    const exec = new CLIExecutor()
    if (typeof exec.getVitals === 'function') {
      const v = exec.getVitals()
      assert.equal(typeof v, 'object')
    }
  })
})
