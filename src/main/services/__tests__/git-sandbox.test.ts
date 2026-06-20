/**
 * Unit tests for git-sandbox.ts — experiment isolation utilities.
 *
 * Tests validate the checkpoint format parsing, diff stats parsing,
 * and module export shape without requiring actual git operations.
 *
 * Fix 4.2 — Git sandbox utility
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Checkpoint format ──

describe('Git Sandbox — checkpoint format', () => {
  test('checkpoint format: branch:hash', () => {
    // The format is "branch:commitHash"
    const checkpoint = 'main:abc123def456'
    const colonIdx = checkpoint.indexOf(':')
    assert.ok(colonIdx > 0)
    const branch = checkpoint.slice(0, colonIdx)
    const hash = checkpoint.slice(colonIdx + 1)
    assert.equal(branch, 'main')
    assert.equal(hash, 'abc123def456')
  })

  test('feature branch with slashes', () => {
    // Branch names can contain slashes: feature/my-fix
    const checkpoint = 'feature/my-fix:abc123'
    const colonIdx = checkpoint.indexOf(':')
    const branch = checkpoint.slice(0, colonIdx)
    const hash = checkpoint.slice(colonIdx + 1)
    assert.equal(branch, 'feature/my-fix')
    assert.equal(hash, 'abc123')
  })

  test('invalid checkpoint format — no colon', () => {
    const checkpoint = 'invalidformat'
    const colonIdx = checkpoint.indexOf(':')
    assert.equal(colonIdx, -1, 'Should not contain colon')
  })
})

// ── Diff stats parsing ──

describe('Git Sandbox — diff stats parsing', () => {
  // Simulate the parsing logic from getExperimentDiffStats
  function parseDiffStats(stat: string): { filesChanged: number; linesAdded: number; linesRemoved: number } {
    if (!stat) return { filesChanged: 0, linesAdded: 0, linesRemoved: 0 }
    const filesMatch = stat.match(/(\d+) files? changed/)
    const insertionsMatch = stat.match(/(\d+) insertions?\(\+\)/)
    const deletionsMatch = stat.match(/(\d+) deletions?\(-\)/)
    return {
      filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
      linesAdded: insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0,
      linesRemoved: deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0
    }
  }

  test('typical diff output', () => {
    const stat = ' 3 files changed, 42 insertions(+), 10 deletions(-)'
    const result = parseDiffStats(stat)
    assert.equal(result.filesChanged, 3)
    assert.equal(result.linesAdded, 42)
    assert.equal(result.linesRemoved, 10)
  })

  test('single file changed', () => {
    const stat = ' 1 file changed, 5 insertions(+)'
    const result = parseDiffStats(stat)
    assert.equal(result.filesChanged, 1)
    assert.equal(result.linesAdded, 5)
    assert.equal(result.linesRemoved, 0)
  })

  test('deletions only', () => {
    const stat = ' 2 files changed, 15 deletions(-)'
    const result = parseDiffStats(stat)
    assert.equal(result.filesChanged, 2)
    assert.equal(result.linesAdded, 0)
    assert.equal(result.linesRemoved, 15)
  })

  test('empty diff', () => {
    const result = parseDiffStats('')
    assert.equal(result.filesChanged, 0)
    assert.equal(result.linesAdded, 0)
    assert.equal(result.linesRemoved, 0)
  })

  test('large numbers', () => {
    const stat = ' 150 files changed, 12345 insertions(+), 6789 deletions(-)'
    const result = parseDiffStats(stat)
    assert.equal(result.filesChanged, 150)
    assert.equal(result.linesAdded, 12345)
    assert.equal(result.linesRemoved, 6789)
  })
})

// ── Module export shape ──

describe('Git Sandbox — module exports', () => {
  test('validates expected exports exist', () => {
    const mod = require('../git-sandbox')
    assert.equal(typeof mod.createExperimentCheckpoint, 'function')
    assert.equal(typeof mod.resetToCheckpoint, 'function')
    assert.equal(typeof mod.getExperimentDiffStats, 'function')
    assert.equal(typeof mod.cleanupBuildArtifacts, 'function')
  })

  test('resetToCheckpoint rejects invalid format', () => {
    const mod = require('../git-sandbox') as typeof import('../git-sandbox')
    assert.throws(
      () => mod.resetToCheckpoint('/tmp/fake', 'no-colon-here'),
      /Invalid checkpoint format/
    )
  })
})

// ─── Guardian: run summary only when standalone ───
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
