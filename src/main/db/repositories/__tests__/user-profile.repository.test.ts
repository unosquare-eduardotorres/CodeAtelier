/**
 * Unit tests for UserProfileRepository — single-row user profile store
 * with upsert semantics.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('UserProfileRepository (skipped — native module unavailable)', () => {
    test('placeholder', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { userProfileRepository } = require('../user-profile.repository')

  describe('UserProfileRepository', () => {
    // ── getProfile ──

    test('getProfile() returns null when no profile exists', () => {
      // Fresh DB — no profile row yet (previous tests may have created one)
      // Delete any existing profile to ensure clean state
      env.db.prepare("DELETE FROM user_profile WHERE id = 'default'").run()
      assert.equal(userProfileRepository.getProfile(), null)
    })

    // ── upsertProfile ──

    test('upsertProfile() creates new profile', () => {
      env.db.prepare("DELETE FROM user_profile WHERE id = 'default'").run()
      const profile = userProfileRepository.upsertProfile('Alice', 'avatar-1')
      assert.equal(profile.id, 'default')
      assert.equal(profile.displayName, 'Alice')
      assert.equal(profile.avatarKey, 'avatar-1')
      assert.ok(profile.createdAt, 'should have createdAt')
      assert.ok(profile.updatedAt, 'should have updatedAt')
    })

    test('upsertProfile() + getProfile() round-trip', () => {
      userProfileRepository.upsertProfile('Bob', 'avatar-2')
      const fetched = userProfileRepository.getProfile()
      assert.ok(fetched, 'should find the profile')
      assert.equal(fetched.displayName, 'Bob')
      assert.equal(fetched.avatarKey, 'avatar-2')
    })

    test('upsertProfile() updates existing profile (upsert semantics)', () => {
      userProfileRepository.upsertProfile('First', 'key-1')
      userProfileRepository.upsertProfile('Second', 'key-2')

      const profile = userProfileRepository.getProfile()
      assert.ok(profile)
      assert.equal(profile.displayName, 'Second')
      assert.equal(profile.avatarKey, 'key-2')
    })

    test('upsertProfile() returns mapped UserProfile object', () => {
      const profile = userProfileRepository.upsertProfile('Test', 'test-key')
      // Verify all expected fields exist and are properly mapped
      assert.equal(typeof profile.id, 'string')
      assert.equal(typeof profile.displayName, 'string')
      assert.equal(typeof profile.avatarKey, 'string')
      assert.equal(typeof profile.createdAt, 'string')
      assert.equal(typeof profile.updatedAt, 'string')
    })
  })
}
