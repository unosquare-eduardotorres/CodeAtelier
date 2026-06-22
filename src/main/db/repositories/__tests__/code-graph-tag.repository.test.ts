/**
 * Tests for CodeGraphTagRepository — upsertTags, searchByName, findDeadCode, hotspots.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('CodeGraphTagRepository (skipped — native module unavailable)', () => {
    test('upsertTags()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const { codeGraphTagRepository } = require('../code-graph-tag.repository')

  describe('CodeGraphTagRepository', () => {
    test('upsertTags() inserts tags and findDefsByWorkspace() retrieves defs', () => {
      const tags = [
        { relFname: 'src/a.ts', fname: '/repo/src/a.ts', line: 10, name: 'MyClass', kind: 'def' as const },
        { relFname: 'src/a.ts', fname: '/repo/src/a.ts', line: 20, name: 'MyClass', kind: 'ref' as const },
        { relFname: 'src/b.ts', fname: '/repo/src/b.ts', line: 5, name: 'helperFn', kind: 'def' as const }
      ]
      const mtimes = new Map([['src/a.ts', 1000], ['src/b.ts', 2000]])
      codeGraphTagRepository.upsertTags(wsId, tags, mtimes)

      const defs = codeGraphTagRepository.findDefsByWorkspace(wsId)
      assert.ok(defs.length >= 2)
      assert.ok(defs.some((d: any) => d.name === 'MyClass' && d.kind === 'def'))
      assert.ok(defs.some((d: any) => d.name === 'helperFn' && d.kind === 'def'))
    })

    test('upsertTags() replaces existing tags for same file', () => {
      const initial = [
        { relFname: 'src/replace.ts', fname: '/repo/src/replace.ts', line: 1, name: 'old', kind: 'def' as const }
      ]
      codeGraphTagRepository.upsertTags(wsId, initial, new Map([['src/replace.ts', 100]]))

      const updated = [
        { relFname: 'src/replace.ts', fname: '/repo/src/replace.ts', line: 1, name: 'new', kind: 'def' as const }
      ]
      codeGraphTagRepository.upsertTags(wsId, updated, new Map([['src/replace.ts', 200]]))

      const tags = codeGraphTagRepository.findByFile(wsId, 'src/replace.ts')
      assert.equal(tags.length, 1)
      assert.equal(tags[0].name, 'new')
    })

    test('findByFile() returns tags for specific file', () => {
      const tags = codeGraphTagRepository.findByFile(wsId, 'src/a.ts')
      assert.ok(tags.length >= 2) // def + ref from first test
    })

    test('searchByName() finds tags by substring', () => {
      const results = codeGraphTagRepository.searchByName(wsId, 'Class')
      assert.ok(results.some((r: any) => r.name === 'MyClass'))
    })

    test('searchByName() respects includeDefinitions/includeReferences', () => {
      const defsOnly = codeGraphTagRepository.searchByName(wsId, 'MyClass', {
        includeDefinitions: true, includeReferences: false
      })
      assert.ok(defsOnly.every((t: any) => t.kind === 'def'))

      const refsOnly = codeGraphTagRepository.searchByName(wsId, 'MyClass', {
        includeDefinitions: false, includeReferences: true
      })
      assert.ok(refsOnly.every((t: any) => t.kind === 'ref'))
    })

    test('searchByName() respects maxResults', () => {
      const results = codeGraphTagRepository.searchByName(wsId, '', { maxResults: 2 })
      assert.ok(results.length <= 2)
    })

    test('getFileMtimes() returns mtime map', () => {
      const mtimes = codeGraphTagRepository.getFileMtimes(wsId)
      assert.ok(mtimes instanceof Map)
      assert.ok(mtimes.size > 0)
    })

    test('deleteByFile() removes tags for one file', () => {
      const count = codeGraphTagRepository.deleteByFile(wsId, 'src/replace.ts')
      assert.ok(count >= 1)
      const remaining = codeGraphTagRepository.findByFile(wsId, 'src/replace.ts')
      assert.equal(remaining.length, 0)
    })

    test('countByWorkspace() returns total tag count', () => {
      const count = codeGraphTagRepository.countByWorkspace(wsId)
      assert.ok(count >= 0)
    })

    test('findAllByWorkspace() returns all tags', () => {
      const all = codeGraphTagRepository.findAllByWorkspace(wsId)
      assert.ok(Array.isArray(all))
    })

    test('findDeadCode() finds defs without cross-file refs', () => {
      // helperFn is defined in src/b.ts but only has refs in src/a.ts for MyClass
      const dead = codeGraphTagRepository.findDeadCode(wsId)
      assert.ok(Array.isArray(dead))
      // helperFn should appear as dead code (no cross-file refs)
      assert.ok(dead.some((d: any) => d.name === 'helperFn'))
    })

    test('findDeadCode() respects path filter', () => {
      const dead = codeGraphTagRepository.findDeadCode(wsId, { path: 'src/b' })
      assert.ok(dead.every((d: any) => d.relFname.startsWith('src/b')))
    })

    test('findSymbolHotspots() returns most-referenced symbols', () => {
      const hotspots = codeGraphTagRepository.findSymbolHotspots(wsId)
      assert.ok(Array.isArray(hotspots))
      if (hotspots.length > 0) {
        assert.ok(typeof hotspots[0].name === 'string')
        assert.ok(typeof hotspots[0].refCount === 'number')
      }
    })

    test('deleteByWorkspace() clears all tags', () => {
      const count = codeGraphTagRepository.deleteByWorkspace(wsId)
      assert.ok(count >= 0)
      assert.equal(codeGraphTagRepository.countByWorkspace(wsId), 0)
    })
  })
}
