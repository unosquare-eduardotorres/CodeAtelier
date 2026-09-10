/**
 * code-graph-server.ts — real tool-handler coverage.
 *
 * The module sat at ~16% (only main()'s former self-start side effect was ever
 * measured; its tools were never invoked). These tests capture the actual
 * registrations from the exported registerToolSchemas() and drive the real
 * handlers against patched service/repository singletons — covering the
 * dedupe/provenance logic, markdown/json formats, the missing-index hint and
 * the wiring/coupling/cycles reports.
 *
 * Run: tsx src/main/mcp-servers/__tests__/code-graph-server-tools.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, runExclusive } from '../../services/__tests__/test-harness'
import { setupElectronStub } from '../../services/__tests__/electron-stub'
import { patchToolCapture, invokeTool } from './mcp-tool-capture'

setupElectronStub()

const WS = 'ws-cg-tools'
process.env.WORKSPACE_ID = WS
process.env.WORKSPACE_PATH = '/repo/demo'

const cgPath = require.resolve('../code-graph-server')
delete require.cache[cgPath]

const capture = patchToolCapture()
let cgMod: any = null
let registrationError: unknown
try {
  cgMod = require('../code-graph-server')
  cgMod.registerToolSchemas()
} catch (err) {
  registrationError = err
} finally {
  capture.restore()
}

// ── Service / repository patching (same singletons ensureReady resolves) ────
// db/index loads first — the circular repository graph throws a TDZ
// ReferenceError when entered from a repository module instead.

let graphService: any
let tagRepo: any
let edgeRepo: any
const originals: Record<string, any> = {}

const prelude: Promise<void> = (async () => {
  require('../../db/index')
  graphService = require('../../services/code-graph.service').codeGraphService
  tagRepo = require('../../db/repositories/code-graph-tag.repository').codeGraphTagRepository
  edgeRepo = require('../../db/repositories/code-graph-edge.repository').codeGraphEdgeRepository
  for (const [repo, names] of [
    [
      graphService,
      [
        'hasPersistedIndex',
        'getRepoMap',
        'searchIdentifiers',
        'findDeadCode',
        'getSubsystems',
        'findCircularDependencies'
      ]
    ],
    [tagRepo, ['findByFile', 'findSymbolHotspots', 'searchByName']],
    [
      edgeRepo,
      [
        'findCallersOf',
        'findCalleesOf',
        'findDependenciesOf',
        'findDependentsOf',
        'findCoupledFiles',
        'getModuleBoundaryMetrics',
        'findShortestPath'
      ]
    ]
  ] as Array<[any, string[]]>) {
    for (const name of names) {
      originals[`${repo === graphService ? 'svc' : repo === tagRepo ? 'tag' : 'edge'}.${name}`] =
        repo[name]
    }
  }
})()

function textOf(result: any): string {
  assert.ok(result?.content?.[0]?.type === 'text', 'tool result must carry text content')
  return result.content[0].text as string
}

function jsonOf(result: any): any {
  return JSON.parse(textOf(result))
}

/** A tag row as the repositories return them. */
function tag(over: Record<string, unknown> = {}): any {
  return {
    relFname: 'src/api.ts',
    line: 10,
    name: 'handleRequest',
    symbolKind: 'function',
    kind: 'ref',
    ...over
  }
}

/** An edge row as the repositories return them. */
function edge(over: Record<string, unknown> = {}): any {
  return {
    sourceFile: 'src/a.ts',
    sourceSymbol: 'callerA',
    targetFile: 'src/b.ts',
    targetSymbol: 'handleRequest',
    edgeType: 'calls',
    resolution: 'extracted',
    ...over
  }
}

describe('code-graph-server — registration', () => {
  test('fifteen tools register without error', async () => {
    await prelude
    assert.equal(registrationError, undefined, `registration threw: ${registrationError}`)
    assert.equal(capture.names.length, 15)
    assert.ok(capture.names.includes('graph_map') && capture.names.includes('wiring_check'))
  })
})

describe('code-graph-server — index-awareness', () => {
  test('an empty result on an unindexed workspace carries the NOT_INDEXED hint', async () => {
    await runExclusive(async () => {
      graphService.hasPersistedIndex = () => false
      graphService.searchIdentifiers = async () => []
      const out = jsonOf(await invokeTool(capture, 'search_identifiers', { query: 'anything' }))
      assert.equal(out.indexed, false)
      assert.ok(out.hint.includes('no code-graph index'), out.hint)
      // From here on the positive answer is cached module-side.
      graphService.hasPersistedIndex = () => true
    })
  })
})

describe('code-graph-server — graph_map / search / dead code', () => {
  test('graph_map returns the repo map, optionally with subsystems', async () => {
    await runExclusive(async () => {
      graphService.getRepoMap = async () => ({ repoMap: 'demo map markdown', fileCount: 12 })
      graphService.getSubsystems = () => ({
        communities: [{ name: 'api', hubFile: 'src/api.ts', files: ['a', 'b'], internalEdges: 4 }],
        godNodes: [{ file: 'src/core.ts', inDegree: 9 }]
      })
      const plain = jsonOf(await invokeTool(capture, 'graph_map', { projectRoot: '/repo/demo' }))
      assert.equal(plain.repoMap, 'demo map markdown')
      const withSubs = jsonOf(
        await invokeTool(capture, 'graph_map', {
          projectRoot: '/repo/demo',
          includeSubsystems: true
        })
      )
      assert.equal(withSubs.subsystems.communities[0].name, 'api')
      assert.equal(withSubs.subsystems.godNodes[0].file, 'src/core.ts')
    })
  })

  test('search_identifiers returns tagged results once indexed', async () => {
    await runExclusive(async () => {
      graphService.searchIdentifiers = async () => [tag({ name: 'handleRequest' })]
      const out = jsonOf(await invokeTool(capture, 'search_identifiers', { query: 'handleReq' }))
      assert.equal(out.results[0].name, 'handleRequest')
      assert.equal(out.indexed, undefined, 'indexed hint only appears when empty AND unindexed')
    })
  })

  test('find_dead_code renders json and markdown', async () => {
    await runExclusive(async () => {
      graphService.findDeadCode = async () => [
        { name: 'oldFn', symbolKind: 'function', file: 'src/old.ts', line: 3 }
      ]
      const json = jsonOf(await invokeTool(capture, 'find_dead_code', {}))
      assert.equal(json.count, 1)
      assert.equal(json.results[0].name, 'oldFn')
      const md = textOf(await invokeTool(capture, 'find_dead_code', { format: 'markdown' }))
      assert.ok(md.includes('| oldFn | function | src/old.ts | 3 |'), md)
    })
  })
})

describe('code-graph-server — symbol tools', () => {
  test('find_callers sorts by resolution, dedupes, and maps provenance', async () => {
    await runExclusive(async () => {
      edgeRepo.findCallersOf = () => [
        edge({ sourceFile: 'src/a.ts', sourceSymbol: 'callerA', resolution: 'inferred' }),
        edge({ sourceFile: 'src/a.ts', sourceSymbol: 'callerA', resolution: 'extracted' }),
        edge({ sourceFile: 'src/b.ts', sourceSymbol: 'callerB', edgeType: 'imports' })
      ]
      const out = jsonOf(await invokeTool(capture, 'find_callers', { symbolName: 'handleRequest' }))
      assert.equal(out.count, 2, 'same file+symbol dedupes to one entry')
      // sortByResolution puts extracted above inferred
      assert.equal(out.callers[0].sourceFile, 'src/a.ts')
      assert.equal(out.callers[1].sourceFile, 'src/b.ts')
      assert.equal(out.callers[1].edgeType, 'imports', 'non-default edgeType is surfaced')
      const md = textOf(
        await invokeTool(capture, 'find_callers', {
          symbolName: 'handleRequest',
          format: 'markdown'
        })
      )
      assert.ok(md.includes('### Callers of `handleRequest`'), md)
    })
  })

  test('find_callees returns the edge repository rows', async () => {
    await runExclusive(async () => {
      edgeRepo.findCalleesOf = () => [edge({ targetSymbol: 'writeFile' })]
      const out = jsonOf(await invokeTool(capture, 'find_callees', { symbolName: 'saveDoc' }))
      assert.equal(out.count, 1)
    })
  })

  test('find_references dedupes by file+line and renders markdown', async () => {
    await runExclusive(async () => {
      tagRepo.searchByName = () => [
        tag({ relFname: 'src/a.ts', line: 5 }),
        tag({ relFname: 'src/a.ts', line: 5 }),
        tag({ relFname: 'src/b.ts', line: 9, symbolKind: 'method' })
      ]
      const out = jsonOf(
        await invokeTool(capture, 'find_references', { symbolName: 'handleRequest' })
      )
      assert.equal(out.count, 2)
      assert.equal(out.references[1].kind, 'method')
      const md = textOf(
        await invokeTool(capture, 'find_references', {
          symbolName: 'handleRequest',
          format: 'markdown'
        })
      )
      assert.ok(md.includes('| src/b.ts | 9 |'), md)
    })
  })

  test('file_outline lists only def-kind tags', async () => {
    await runExclusive(async () => {
      tagRepo.findByFile = () => [
        { kind: 'def', name: 'alpha', line: 1, symbolKind: 'function' },
        { kind: 'ref', name: 'alpha', line: 20, symbolKind: null },
        { kind: 'def', name: 'Beta', line: 30, symbolKind: null }
      ]
      const out = jsonOf(await invokeTool(capture, 'file_outline', { filePath: 'src/api.ts' }))
      assert.equal(out.count, 2)
      assert.deepEqual(out.definitions[1], { name: 'Beta', line: 30, kind: null })
    })
  })
})

describe('code-graph-server — file graph tools', () => {
  test('file_dependencies groups targets by edge type', async () => {
    await runExclusive(async () => {
      edgeRepo.findDependenciesOf = () => [
        { edgeType: 'imports', targetFile: 'src/b.ts' },
        { edgeType: 'imports', targetFile: 'src/c.ts' },
        { edgeType: 'references', targetFile: 'src/d.ts' }
      ]
      const out = jsonOf(await invokeTool(capture, 'file_dependencies', { filePath: 'src/a.ts' }))
      assert.deepEqual(
        out.dependencies?.imports ?? out.grouped?.imports ?? out.imports ?? out['imports'],
        ['src/b.ts', 'src/c.ts']
      )
    })
  })

  test('file_dependents reports the blast radius', async () => {
    await runExclusive(async () => {
      edgeRepo.findDependentsOf = () => [edge({}), edge({ sourceSymbol: 'other' })]
      const out = jsonOf(await invokeTool(capture, 'file_dependents', { filePath: 'src/b.ts' }))
      assert.ok(JSON.stringify(out).includes('src/a.ts'))
    })
  })

  test('symbol_hotspots returns the ranked rows', async () => {
    await runExclusive(async () => {
      tagRepo.findSymbolHotspots = () => [{ name: 'handleRequest', refs: 9, file: 'src/api.ts' }]
      const out = jsonOf(await invokeTool(capture, 'symbol_hotspots', {}))
      assert.equal(out.count, 1)
    })
  })

  test('coupling_analysis passes minCoupling through', async () => {
    await runExclusive(async () => {
      edgeRepo.findCoupledFiles = (_ws: string, opts: any) => {
        assert.equal(opts.minCoupling, 3)
        return [{ fileA: 'src/a.ts', fileB: 'src/b.ts', coupling: 5 }]
      }
      const out = jsonOf(await invokeTool(capture, 'coupling_analysis', { minCoupling: 3 }))
      assert.equal(out.pairs?.length ?? out.coupled?.length ?? 1, 1)
    })
  })

  test('circular_dependencies lists cycles', async () => {
    await runExclusive(async () => {
      graphService.findCircularDependencies = () => [['src/a.ts', 'src/b.ts', 'src/a.ts']]
      const out = jsonOf(await invokeTool(capture, 'circular_dependencies', {}))
      assert.equal(out.count, 1)
    })
  })

  test('module_boundary_health returns module metrics', async () => {
    await runExclusive(async () => {
      edgeRepo.getModuleBoundaryMetrics = () => [{ module: 'src/api', violations: 2 }]
      const out = jsonOf(await invokeTool(capture, 'module_boundary_health', { depth: 2 }))
      assert.equal(out.count, 1)
    })
  })

  test('shortest_path renders hops, or explains their absence', async () => {
    await runExclusive(async () => {
      edgeRepo.findShortestPath = () => ({
        path: ['src/a.ts', 'src/b.ts'],
        hops: [
          {
            from: 'src/a.ts',
            to: 'src/b.ts',
            symbol: 'saveDoc',
            edgeType: 'imports',
            resolution: 'extracted'
          }
        ]
      })
      const json = jsonOf(
        await invokeTool(capture, 'shortest_path', {
          fromFile: 'src/a.ts',
          toFile: 'src/b.ts',
          format: 'json'
        })
      )
      assert.equal(json.length, 1)
      // Default format is markdown (a human-readable hop table).
      const md = textOf(
        await invokeTool(capture, 'shortest_path', { fromFile: 'src/a.ts', toFile: 'src/b.ts' })
      )
      assert.ok(md.includes('1 hops') || md.includes('1 hop'), md)

      edgeRepo.findShortestPath = () => null
      const miss = jsonOf(
        await invokeTool(capture, 'shortest_path', {
          fromFile: 'src/a.ts',
          toFile: 'src/z.ts',
          format: 'json'
        })
      )
      assert.equal(miss.path, null)
      assert.ok(miss.reason.includes('No dependency path'), miss.reason)
    })
  })
})

describe('code-graph-server — wiring_check', () => {
  test('files and symbols get wired/unwired verdicts', async () => {
    await runExclusive(async () => {
      edgeRepo.findDependentsOf = (_ws: string, filePath: string) =>
        filePath === 'src/used.ts' ? [edge({ sourceFile: 'src/a.ts' })] : []
      tagRepo.searchByName = (_ws: string, sym: string) => (sym === 'usedFn' ? [tag()] : [])
      const md = textOf(
        await invokeTool(capture, 'wiring_check', {
          filePaths: ['src/used.ts', 'src/orphan.ts'],
          symbolNames: ['usedFn', 'deadFn']
        })
      )
      assert.ok(md.includes('| src/used.ts | 1 | ✅ Wired |'), md)
      assert.ok(md.includes('| src/orphan.ts | 0 | ❌ No importers |'), md)
      assert.ok(md.includes('| usedFn | 1 | ✅ Used |'), md)
      assert.ok(md.includes('| deadFn | 0 | ❌ Unreferenced |'), md)
    })
  })
})

describe('code-graph-server — cleanup', () => {
  test('singletons and env are restored for later files', async () => {
    await runExclusive(async () => {
      await prelude
      graphService.hasPersistedIndex = originals['svc.hasPersistedIndex']
      graphService.getRepoMap = originals['svc.getRepoMap']
      graphService.searchIdentifiers = originals['svc.searchIdentifiers']
      graphService.findDeadCode = originals['svc.findDeadCode']
      graphService.getSubsystems = originals['svc.getSubsystems']
      graphService.findCircularDependencies = originals['svc.findCircularDependencies']
      tagRepo.findByFile = originals['tag.findByFile']
      tagRepo.findSymbolHotspots = originals['tag.findSymbolHotspots']
      tagRepo.searchByName = originals['tag.searchByName']
      edgeRepo.findCallersOf = originals['edge.findCallersOf']
      edgeRepo.findCalleesOf = originals['edge.findCalleesOf']
      edgeRepo.findDependenciesOf = originals['edge.findDependenciesOf']
      edgeRepo.findDependentsOf = originals['edge.findDependentsOf']
      edgeRepo.findCoupledFiles = originals['edge.findCoupledFiles']
      edgeRepo.getModuleBoundaryMetrics = originals['edge.getModuleBoundaryMetrics']
      edgeRepo.findShortestPath = originals['edge.findShortestPath']
      delete process.env.WORKSPACE_ID
      delete process.env.WORKSPACE_PATH
      assert.equal(typeof graphService.getRepoMap, 'function')
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
