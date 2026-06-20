/**
 * Tests for CodeGraphEdgeRepository — upsertEdges, callers/callees, coupling, module metrics.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('CodeGraphEdgeRepository (skipped — native module unavailable)', () => {
    test('upsertEdges()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env
  const { codeGraphEdgeRepository } = require('../code-graph-edge.repository')

  const sampleEdges = [
    { workspaceId: wsId, sourceFile: 'src/a.ts', sourceSymbol: 'fnA', targetFile: 'src/b.ts', targetSymbol: 'fnB', edgeType: 'calls' as const },
    { workspaceId: wsId, sourceFile: 'src/a.ts', sourceSymbol: 'fnA', targetFile: 'src/c.ts', targetSymbol: 'ClassC', edgeType: 'imports' as const },
    { workspaceId: wsId, sourceFile: 'src/b.ts', sourceSymbol: 'fnB', targetFile: 'src/c.ts', targetSymbol: 'ClassC', edgeType: 'calls' as const },
    { workspaceId: wsId, sourceFile: 'src/d.ts', sourceSymbol: 'ClassD', targetFile: 'src/c.ts', targetSymbol: 'ClassC', edgeType: 'extends' as const }
  ]

  describe('CodeGraphEdgeRepository', () => {
    test('upsertEdges() inserts edges', () => {
      codeGraphEdgeRepository.upsertEdges(wsId, sampleEdges)
      const all = codeGraphEdgeRepository.findByWorkspace(wsId)
      assert.equal(all.length, 4)
    })

    test('upsertEdges() replaces existing edges on re-call', () => {
      codeGraphEdgeRepository.upsertEdges(wsId, sampleEdges.slice(0, 2))
      const all = codeGraphEdgeRepository.findByWorkspace(wsId)
      assert.equal(all.length, 2)
      // Restore full set for subsequent tests
      codeGraphEdgeRepository.upsertEdges(wsId, sampleEdges)
    })

    test('findCallersOf() finds edges targeting a symbol', () => {
      const callers = codeGraphEdgeRepository.findCallersOf(wsId, 'ClassC')
      assert.ok(callers.length >= 3) // fnA imports, fnB calls, ClassD extends
    })

    test('findCalleesOf() finds edges sourced from a symbol', () => {
      const callees = codeGraphEdgeRepository.findCalleesOf(wsId, 'fnA')
      assert.equal(callees.length, 2) // calls fnB, imports ClassC
    })

    test('mapRow() maps snake_case to camelCase', () => {
      const edges = codeGraphEdgeRepository.findByWorkspace(wsId)
      const edge = edges[0]
      assert.ok('sourceFile' in edge)
      assert.ok('sourceSymbol' in edge)
      assert.ok('targetFile' in edge)
      assert.ok('edgeType' in edge)
      assert.ok('pageRank' in edge)
    })

    test('findDependenciesOf() returns target files for source file', () => {
      const deps = codeGraphEdgeRepository.findDependenciesOf(wsId, 'src/a.ts')
      assert.ok(deps.length >= 2) // depends on src/b.ts and src/c.ts
      assert.ok(deps.some((d: any) => d.targetFile === 'src/b.ts'))
      assert.ok(deps.some((d: any) => d.targetFile === 'src/c.ts'))
    })

    test('findDependentsOf() returns source files for target file', () => {
      const dependents = codeGraphEdgeRepository.findDependentsOf(wsId, 'src/c.ts')
      assert.ok(dependents.length >= 3) // a.ts, b.ts, d.ts all reference c.ts
    })

    test('countByWorkspace() returns correct count', () => {
      const count = codeGraphEdgeRepository.countByWorkspace(wsId)
      assert.equal(count, 4)
    })

    test('findCoupledFiles() finds file pairs by edge count', () => {
      const coupled = codeGraphEdgeRepository.findCoupledFiles(wsId, { minCoupling: 1 })
      assert.ok(Array.isArray(coupled))
      if (coupled.length > 0) {
        assert.ok('sourceFile' in coupled[0])
        assert.ok('targetFile' in coupled[0])
        assert.ok('edgeCount' in coupled[0])
      }
    })

    test('findCoupledFiles() respects path filter', () => {
      const coupled = codeGraphEdgeRepository.findCoupledFiles(wsId, {
        minCoupling: 1, path: 'src/a'
      })
      assert.ok(
        coupled.every(
          (c: any) => c.sourceFile.startsWith('src/a') || c.targetFile.startsWith('src/a')
        )
      )
    })

    test('getModuleBoundaryMetrics() computes internal/external ratios', () => {
      const metrics = codeGraphEdgeRepository.getModuleBoundaryMetrics(wsId, 1)
      assert.ok(Array.isArray(metrics))
      if (metrics.length > 0) {
        const m = metrics[0]
        assert.ok('module' in m)
        assert.ok('internal' in m)
        assert.ok('external' in m)
        assert.ok('ratio' in m)
        assert.ok(m.ratio >= 0 && m.ratio <= 1)
      }
    })

    test('deleteByWorkspace() clears all edges', () => {
      const deleted = codeGraphEdgeRepository.deleteByWorkspace(wsId)
      assert.ok(deleted >= 4)
      assert.equal(codeGraphEdgeRepository.countByWorkspace(wsId), 0)
    })
  })
}
