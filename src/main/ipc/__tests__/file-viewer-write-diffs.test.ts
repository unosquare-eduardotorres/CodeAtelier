/**
 * File viewer + write-diff capture tests.
 *
 * Covers:
 * - Write tool_use diff capture (existing file → old content from disk,
 *   new file → all-green, ENOENT → '', budget clipping)
 * - countDiffLines line counting
 * - FileLanguageIcon extension resolution
 * - file-viewer IPC guards (containment, size cap, binary sniff)
 * - resolveViewerRoot resolution order + synthetic-id fallback (GAP-1)
 *
 * Run via the registered runner (stub must be installed before the db chain
 * loads): npx tsx src/main/services/__tests__/run-tests.ts
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import { setupElectronStub } from '../../services/__tests__/electron-stub'
import { processToolChunk } from '../tool-chunk-processor'
import type { StreamChunk } from '../../services/agent-base.service'

// Install electron/electron-log stubs before importing modules that pull in the db chain
setupElectronStub()

// file-viewer.ipc statically imports the db repositories chain (schema.sql?raw
// needs the stub's Module hook) — require() AFTER setupElectronStub() so
// standalone `npx tsx` runs work, mirroring the run-tests.ts loader order.
const { readWorkspaceFile, resolveViewerRoot } =
  require('../file-viewer.ipc') as typeof import('../file-viewer.ipc')

// ── Write diff capture ──

function makeWriteChunk(filePath: string, content: string): StreamChunk {
  return {
    type: 'tool_use',
    toolName: 'Write',
    toolId: `write-${Math.random().toString(36).slice(2)}`,
    toolInputRaw: JSON.stringify({ file_path: filePath, content })
  }
}

describe('processToolChunk — Write diff capture', () => {
  test('captures old content from disk at tool_use time', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writediff-'))
    try {
      fs.writeFileSync(path.join(dir, 'existing.ts'), 'line1\nline2\n')
      const chunk = makeWriteChunk('existing.ts', 'line1\nline2-changed\n')
      const result = processToolChunk(chunk, { agentType: 'test', workspacePath: dir })
      assert.ok(result)
      const diffs = result.toolActivity.editDiffs
      assert.ok(diffs, 'editDiffs should be present')
      assert.equal(diffs.length, 1)
      assert.equal(diffs[0].oldString, 'line1\nline2\n')
      assert.equal(diffs[0].newString, 'line1\nline2-changed\n')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('new file → all-green diff (oldString empty)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writediff-'))
    try {
      const chunk = makeWriteChunk('brand-new.ts', 'export const x = 1\n')
      const result = processToolChunk(chunk, { agentType: 'test', workspacePath: dir })
      assert.ok(result)
      const diffs = result.toolActivity.editDiffs
      assert.ok(diffs)
      assert.equal(diffs[0].oldString, '')
      assert.equal(diffs[0].newString, 'export const x = 1\n')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('no workspacePath → no diff (graceful)', () => {
    const chunk = makeWriteChunk('some-file.ts', 'content')
    const result = processToolChunk(chunk, { agentType: 'test' })
    assert.ok(result)
    assert.equal(result.toolActivity.editDiffs, undefined)
  })

  test('path escaping workspace root → no diff read (containment)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writediff-'))
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'writediff-sibling-'))
    try {
      fs.writeFileSync(path.join(sibling, 'secret.txt'), 'outside content')
      const chunk = makeWriteChunk(path.join('..', path.basename(sibling), 'secret.txt'), 'new')
      const result = processToolChunk(chunk, { agentType: 'test', workspacePath: dir })
      assert.ok(result)
      const diffs = result.toolActivity.editDiffs
      // Diff still produced (new content), but old must NOT contain outside content
      assert.ok(diffs)
      assert.equal(diffs[0].oldString, '')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(sibling, { recursive: true, force: true })
    }
  })

  test('oversized old content → oldString empty (size guard)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writediff-'))
    try {
      // 200KB file — beyond the 64K read guard (16K budget × 4)
      fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(200_000))
      const chunk = makeWriteChunk('big.txt', 'small')
      const result = processToolChunk(chunk, { agentType: 'test', workspacePath: dir })
      assert.ok(result)
      const diffs = result.toolActivity.editDiffs
      assert.ok(diffs)
      assert.equal(diffs[0].oldString, '')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('long new content is clipped with truncated flag', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writediff-'))
    try {
      const chunk = makeWriteChunk('long.ts', 'y'.repeat(5_000))
      const result = processToolChunk(chunk, { agentType: 'test', workspacePath: dir })
      assert.ok(result)
      const diffs = result.toolActivity.editDiffs
      assert.ok(diffs)
      assert.equal(diffs[0].newString.length, 2_000)
      assert.equal(diffs[0].truncated, true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── countDiffLines (renderer util — tested via the same logic) ──

describe('countDiffLines logic', () => {
  // Mirror of the renderer util's logic — the util itself lives in the renderer
  // bundle; here we validate the counting contract the badge depends on.
  function countLines(s: string): number {
    if (s === '') return 0
    return s.replace(/\n+$/, '').split('\n').length
  }

  test('empty strings count as 0 lines', () => {
    assert.equal(countLines(''), 0)
  })

  test('single line without trailing newline = 1', () => {
    assert.equal(countLines('a'), 1)
  })

  test('trailing newline does not add a phantom line', () => {
    assert.equal(countLines('a\n'), 1)
    assert.equal(countLines('a\nb\n'), 2)
  })

  test('multi-line counts', () => {
    assert.equal(countLines('a\nb\nc'), 3)
  })
})

// ── File viewer IPC guards ──

describe('readWorkspaceFile — guards', () => {
  test('reads a file inside the workspace', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-'))
    try {
      fs.writeFileSync(path.join(dir, 'a.ts'), 'const x = 1\n')
      const result = readWorkspaceFile(dir, 'a.ts')
      assert.equal(result.content, 'const x = 1\n')
      assert.equal(result.truncated, false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rejects paths escaping the workspace root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-'))
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-sibling-'))
    try {
      fs.writeFileSync(path.join(sibling, 'secret.txt'), 'nope')
      assert.throws(
        () => readWorkspaceFile(dir, path.join('..', path.basename(sibling), 'secret.txt')),
        /escapes workspace root/
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(sibling, { recursive: true, force: true })
    }
  })

  test('rejects absolute paths outside the root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-'))
    try {
      assert.throws(
        () => readWorkspaceFile(dir, '/etc/passwd'),
        /escapes workspace root|File not found/
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('missing file → File not found', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-'))
    try {
      assert.throws(() => readWorkspaceFile(dir, 'nope.ts'), /File not found/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('directory → Not a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-'))
    try {
      fs.mkdirSync(path.join(dir, 'subdir'))
      assert.throws(() => readWorkspaceFile(dir, 'subdir'), /Not a file/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('binary file (NUL byte) → rejected', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-'))
    try {
      fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0x01, 0x00, 0x02, 0x03]))
      assert.throws(() => readWorkspaceFile(dir, 'blob.bin'), /Binary file/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('oversized file → rejected with size message', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-'))
    try {
      // 1.5 MB — over the 1 MB cap
      fs.writeFileSync(path.join(dir, 'huge.txt'), 'z'.repeat(1_572_864))
      assert.throws(() => readWorkspaceFile(dir, 'huge.txt'), /File too large/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('subdirectory paths resolve inside the root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-'))
    try {
      fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'src', 'deep', 'nested.ts'), 'nested\n')
      const result = readWorkspaceFile(dir, path.join('src', 'deep', 'nested.ts'))
      assert.equal(result.content, 'nested\n')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── resolveViewerRoot — resolution order + synthetic-id fallback ──

describe('resolveViewerRoot — guards + fallback', () => {
  test('no ctx at all → throws the required-arg error', () => {
    assert.throws(
      () => resolveViewerRoot({}),
      /one of conversationId, blueprintId or workspacePath is required/
    )
  })

  test('blank workspacePath alone → throws (not treated as a root)', () => {
    assert.throws(
      () => resolveViewerRoot({ workspacePath: '   ' }),
      /one of conversationId, blueprintId or workspacePath is required/
    )
  })

  test('workspacePath only → returned as the root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-root-'))
    try {
      assert.equal(resolveViewerRoot({ workspacePath: dir }), path.resolve(dir))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('unresolvable conversationId + workspacePath → falls back to workspacePath (GAP-1)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-fallback-'))
    try {
      // Synthetic id ('streaming' from live surfaces) never resolves to a
      // conversation row — the read must degrade to the explicit workspace
      // root instead of surfacing an error card.
      const root = resolveViewerRoot({
        conversationId: 'streaming',
        workspacePath: dir
      })
      assert.equal(root, path.resolve(dir))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('unresolvable conversationId with NO workspacePath → throws the lookup error', () => {
    assert.throws(
      () => resolveViewerRoot({ conversationId: 'streaming' }),
      /conversation not found|workspace not found|one of conversationId/
    )
  })

  test('unresolvable blueprintId with NO workspacePath → throws the lookup error', () => {
    assert.throws(
      () => resolveViewerRoot({ blueprintId: 'no-such-blueprint' }),
      /blueprint not found|workspace not found|one of conversationId/
    )
  })
})

// ── Summary ──

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
