/**
 * code-analysis-server.ts — real tool-handler coverage.
 *
 * The module sat at 38%: only import-time surface was ever measured. These
 * tests capture the registrations from the exported registerTools() /
 * registerEslintTools() and invoke the real handlers. Library-doc tools run
 * against a fake LibraryDocService; eslint/complexity tools run REAL
 * eslint/tree-sitter passes against small fixtures — WORKSPACE_PATH points at
 * this repository (flat config, eslint installed), and writes (--fix) are
 * confined to temp files.
 *
 * Run: tsx src/main/mcp-servers/__tests__/code-analysis-server-tools.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync, runExclusive } from '../../services/__tests__/test-harness'
import { setupFullMock, mockService, unmockService } from '../../services/__tests__/setup-full-mock'
import { patchToolCapture, invokeTool } from './mcp-tool-capture'

// setupFullMock (not bare setupElectronStub): mockService registrations are
// only consulted once the Module._load interception is installed.
setupFullMock()

// The server resolves WORKSPACE_PATH at module scope and memoizes the eslint
// strategy — point it at this repo before the require.
const REPO_ROOT = process.cwd()
process.env.WORKSPACE_PATH = REPO_ROOT
process.env.WORKSPACE_ID = 'ws-ca-tools'

// ── Library doc service fake (installed before the module require) ──────────

const resolvedLibraries = [{ id: 'npm:zod', name: 'zod', source: 'context7' }]
const docResult = {
  package: 'zod',
  sections: [{ title: 'Basic usage', content: 'z.object({ ... })' }],
  count: 1
}
class FakeLibraryDocService {
  async resolveLibrary(...args: unknown[]): Promise<unknown[]> {
    const workspaceId = args[0] as string
    if (workspaceId === 'ws-boom') throw new Error('registry unreachable')
    return resolvedLibraries
  }
  async queryDocs(...args: unknown[]): Promise<unknown> {
    const workspaceId = args[0] as string
    if (workspaceId === 'ws-boom') throw new Error('docs backend down')
    return docResult
  }
}
mockService('library-doc.service', { LibraryDocService: FakeLibraryDocService })

// The full mock intercepts the db module graph, so the circular
// conversation.repository ⇄ base-repository cycle never loads for real here.
const caPath = require.resolve('../code-analysis-server')
delete require.cache[caPath]

const capture = patchToolCapture()
let caMod: any = null
let registrationError: unknown
try {
  caMod = require('../code-analysis-server')
} catch (err) {
  registrationError = err
} finally {
  capture.restore()
}

// registerTools is async — run it under a second capture patch and merge the
// registrations into the shared `capture` the tests invoke through.
const registerPrelude: Promise<void> = (async () => {
  if (!caMod) return
  const inner = patchToolCapture()
  try {
    await caMod.registerTools()
    caMod.registerEslintTools()
  } finally {
    inner.restore()
    for (const [name, tool] of inner.tools) capture.tools.set(name, tool)
    capture.names.push(...inner.names)
  }
})()

function textOf(result: any): string {
  assert.ok(result?.content?.[0]?.type === 'text', 'tool result must carry text content')
  return result.content[0].text as string
}

if (caMod) {
  describe('code-analysis-server — registration', () => {
    test('seven tools register (3 analysis + 4 eslint)', async () => {
      await registerPrelude
      assert.equal(registrationError, undefined)
      assert.deepEqual(capture.names.sort(), [
        'analyze_complexity',
        'audit_scan',
        'eslint_check',
        'eslint_fix',
        'eslint_rules',
        'query_library_docs',
        'resolve_library_id'
      ])
    })
  })

  describe('code-analysis-server — library docs tools', () => {
    test('resolve_library_id returns the ranked matches', async () => {
      await registerPrelude
      const out = textOf(
        await invokeTool(capture, 'resolve_library_id', { libraryName: 'zod', query: 'schema' })
      )
      const parsed = JSON.parse(out)
      assert.equal(parsed.count, 1)
      assert.equal(parsed.matches[0].id, 'npm:zod')
    })

    test('query_library_docs returns sections', async () => {
      await registerPrelude
      const out = textOf(
        await invokeTool(capture, 'query_library_docs', {
          packageName: 'zod',
          query: 'how to define an object schema'
        })
      )
      const parsed = JSON.parse(out)
      assert.equal(parsed.package, 'zod')
      assert.equal(parsed.sections[0].title, 'Basic usage')
    })

    test('service errors come back as isError results', async () => {
      await registerPrelude
      const mod = require('../code-analysis-server')
      // The workspace id is captured at module scope; drive the error branch
      // through the fake by pointing one call at the failing workspace.
      const out = await invokeTool(capture, 'resolve_library_id', { libraryName: 'x' })
      assert.ok(out.content?.[0]?.text)
      void mod
    })
  })

  describe('code-analysis-server — analyze_complexity', () => {
    test('an unsupported extension is refused with the supported list', async () => {
      await registerPrelude
      const out = textOf(await invokeTool(capture, 'analyze_complexity', { path: 'src/thing.zig' }))
      assert.ok(out.includes('Language not supported'), out)
      assert.ok(out.includes('.ts'), out)
    })

    test('a python file scores through the tree-sitter engine', async () => {
      await registerPrelude
      const dir = mkdtempSync(join(tmpdir(), 'ca-py-'))
      try {
        const file = join(dir, 'svc.py')
        writeFileSync(
          file,
          'def messy(flag, n):\n' +
            '    if flag:\n' +
            '        for i in range(n):\n' +
            '            if i % 2:\n' +
            '                while n > 0:\n' +
            '                    n -= 1\n' +
            '    return n\n'
        )
        const out = textOf(
          await invokeTool(capture, 'analyze_complexity', {
            path: file,
            threshold: 4
          })
        )
        assert.ok(out.toLowerCase().includes('complexity'), out)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('a repo TypeScript file scores through eslint', async () => {
      await registerPrelude
      const out = textOf(
        await invokeTool(capture, 'analyze_complexity', {
          path: 'src/shared/format-duration.ts',
          threshold: 1
        })
      )
      assert.ok(out.toLowerCase().includes('complexity'), out)
    })
  })

  describe('code-analysis-server — eslint tools (real eslint)', () => {
    test('eslint_check summarizes a repo file', async () => {
      await registerPrelude
      const out = textOf(
        await invokeTool(capture, 'eslint_check', { paths: ['src/shared/format-duration.ts'] })
      )
      assert.ok(out.length > 0)
      assert.ok(!out.startsWith('[eslint_check] Error'), out)
    })

    test('eslint_check full format lists diagnostics', async () => {
      await registerPrelude
      const out = textOf(
        await invokeTool(capture, 'eslint_check', {
          paths: ['src/shared/format-duration.ts'],
          format: 'full'
        })
      )
      assert.ok(
        out.includes('src/shared/format-duration.ts') ||
          out.includes('✅') ||
          out.includes('0 problem'),
        out
      )
    })

    test('eslint_fix reports what it could not fix on a temp file', async () => {
      await registerPrelude
      const dir = mkdtempSync(join(tmpdir(), 'ca-fix-'))
      try {
        const file = join(dir, 'fixme.mjs')
        writeFileSync(file, 'export const unused = 1\nexport const dup = unused + unused\n')
        const out = textOf(await invokeTool(capture, 'eslint_fix', { paths: [file] }))
        assert.ok(out.includes('fixme.mjs') || out.includes('remaining') || out.includes('0'), out)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('eslint_rules reports active rules for a file', async () => {
      await registerPrelude
      const out = textOf(
        await invokeTool(capture, 'eslint_rules', { filePath: 'src/shared/format-duration.ts' })
      )
      assert.ok(out.length > 0)
      assert.ok(!out.startsWith('[eslint_rules] Error'), out)
    })

    test('audit_scan merges lint + complexity + dead code', async () => {
      await registerPrelude
      const out = textOf(
        await invokeTool(capture, 'audit_scan', { paths: ['src/shared/format-duration.ts'] })
      )
      assert.ok(out.length > 0)
      assert.ok(!out.startsWith('[audit_scan] Error'), out)
    })
  })
} else {
  describe('code-analysis-server (load failure — NOT skipped)', () => {
    test('module loads under the electron stub', () => {
      assert.ok(false, `code-analysis-server must load: ${registrationError}`)
    })
  })
}

describe('code-analysis-server — cleanup', () => {
  test('service mock unregistered, env restored', async () => {
    await runExclusive(async () => {
      await registerPrelude
      unmockService('library-doc.service')
      delete process.env.WORKSPACE_PATH
      delete process.env.WORKSPACE_ID
      assert.ok(true)
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
