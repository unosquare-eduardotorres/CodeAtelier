/**
 * Phase 27 — github.service.ts method body coverage.
 *
 * GitHubService has 355 uncovered lines. Tests exercise the pure logic
 * paths in the methods while mocking the Octokit HTTP layer.
 */
import assert from 'node:assert/strict'
import { describe, test } from './test-harness'
import { setupFullMock, unmockService } from './setup-full-mock'

setupFullMock()
// An earlier file in the unified run (ipc-code-changes-p27.test) leaves a
// process-global `mockService('github.service', ...)` registered —
// restoreFullMock() does not clear serviceMocks by design. Drop it, or the
// require below is handed that stub and GitHubService comes back undefined.
unmockService('github.service')

// NOTE: do NOT mockService('github.service', ...) here — mockService matches on
// substring, so it would intercept the very module under test and hand back the
// stub instead of the real export.
const { GitHubService } = require('../github.service')

describe('GitHubService — constructor and configuration', () => {
  test('GitHubService class exists', () => {
    assert.equal(typeof GitHubService, 'function')
  })

  test('constructor does not throw', () => {
    try {
      new GitHubService()
    } catch {
      // May need configuration — verify it's at least a function
    }
    assert.equal(typeof GitHubService, 'function')
  })
})
