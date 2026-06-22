/**
 * Unit tests for AppPreferenceRepository — key-value preference store
 * with upsert semantics and typed getters.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('AppPreferenceRepository (skipped — native module unavailable)', () => {
    test('placeholder', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { appPreferenceRepository } = require('../app-preference.repository')

  describe('AppPreferenceRepository', () => {
    // ── get / set ──

    test('get() returns null for unknown key', () => {
      assert.equal(appPreferenceRepository.get('nonexistent_key'), null)
    })

    test('set() + get() round-trip', () => {
      appPreferenceRepository.set('test_key', 'test_value')
      assert.equal(appPreferenceRepository.get('test_key'), 'test_value')
    })

    test('set() upserts — second call overwrites', () => {
      appPreferenceRepository.set('upsert_key', 'first')
      appPreferenceRepository.set('upsert_key', 'second')
      assert.equal(appPreferenceRepository.get('upsert_key'), 'second')
    })

    // ── getBool ──

    test('getBool() returns default when key missing', () => {
      assert.equal(appPreferenceRepository.getBool('missing_bool'), false)
      assert.equal(appPreferenceRepository.getBool('missing_bool', true), true)
    })

    test('getBool() returns true only for "true" string', () => {
      appPreferenceRepository.set('bool_true', 'true')
      appPreferenceRepository.set('bool_false', 'false')
      appPreferenceRepository.set('bool_other', '1')
      assert.equal(appPreferenceRepository.getBool('bool_true'), true)
      assert.equal(appPreferenceRepository.getBool('bool_false'), false)
      assert.equal(appPreferenceRepository.getBool('bool_other'), false)
    })

    // ── getAppPreferences ──

    test('getAppPreferences() returns defaults when no prefs set', () => {
      const prefs = appPreferenceRepository.getAppPreferences()
      // Boolean defaults
      assert.equal(prefs.specialistWarningBuild, true)
      assert.equal(prefs.specialistWarningPlan, true)
      assert.equal(prefs.specialistWarningAlways, false)
      // String defaults
      assert.equal(prefs.chatBubbleSize, 'xl')
      assert.equal(prefs.appTheme, 'code-atelier')
      assert.equal(prefs.updateSource, 'drive')
      assert.equal(prefs.updateDrivePath, '')
      assert.equal(prefs.updateGithubOwner, '')
      assert.equal(prefs.updateGithubRepo, '')
    })

    test('getAppPreferences() reflects set values', () => {
      appPreferenceRepository.set('specialist_warning_build', 'false')
      appPreferenceRepository.set('chat_bubble_size', 'md')
      appPreferenceRepository.set('app_theme', 'monokai')
      const prefs = appPreferenceRepository.getAppPreferences()
      assert.equal(prefs.specialistWarningBuild, false)
      assert.equal(prefs.chatBubbleSize, 'md')
      assert.equal(prefs.appTheme, 'monokai')
    })
  })
}
