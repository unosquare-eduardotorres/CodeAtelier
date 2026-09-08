/**
 * Unit tests for design-agent.service.ts and design-discovery.service.ts
 *
 * Focused on the pure, decision-making parts: the detector/LLM merge rules, the
 * executable-command resolution, and scope-aware file discovery. The session
 * plumbing is exercised indirectly — spinning up a real `AgentSessionService`
 * would spawn a CLI, which unit tests must not do.
 *
 * The merge tests are the important ones: correction 2 of the P3 plan exists
 * because the originally-specified dedupe key would have silently discarded
 * real findings.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe } from './test-harness'
import type { AuditFinding, DesignRunConfig } from '../../../shared/types'
import {
  DesignAgentService,
  mergeDetectorFindings,
  normalizeTitleKey,
  titlesMatch
} from '../design-agent.service'
import { discoverDesignFiles } from '../design-discovery.service'
import { DETECTOR_SOURCE } from '../impeccable-detector.service'

let seq = 0
function finding(
  title: string,
  filePath?: string,
  source?: string,
  severity: AuditFinding['severity'] = 'medium'
): AuditFinding {
  return { id: `f${++seq}`, severity, title, description: 'd', filePath, source }
}

function detectorFinding(title: string, filePath: string): AuditFinding {
  return finding(title, filePath, DETECTOR_SOURCE)
}

// ── normalizeTitleKey ────────────────────────────────────────────────────────

describe('normalizeTitleKey', () => {
  test('ignores case, punctuation and spacing', () => {
    assert.equal(
      normalizeTitleKey('Side-tab accent border'),
      normalizeTitleKey('side tab ACCENT border')
    )
  })

  test('does not truncate, so a longer title stays distinguishable', () => {
    assert.notEqual(
      normalizeTitleKey('Side-tab accent border'),
      normalizeTitleKey('Side-tab accent borders on cards')
    )
  })
})

describe('titlesMatch', () => {
  test('matches a rephrasing that extends the detector title', () => {
    assert.ok(
      titlesMatch(
        normalizeTitleKey('Side-tab accent border'),
        normalizeTitleKey('Side-tab accent borders on cards')
      )
    )
  })

  test('matches identical titles', () => {
    assert.ok(titlesMatch(normalizeTitleKey('Overused font'), normalizeTitleKey('overused font')))
  })

  test('does not match genuinely different titles', () => {
    assert.ok(!titlesMatch(normalizeTitleKey('Overused font'), normalizeTitleKey('Bounce easing')))
  })

  test('refuses to match on a too-short shared prefix', () => {
    // 'Bad UI' normalises to 6 chars — below the overlap floor, so it must not
    // swallow every finding that happens to start the same way.
    assert.ok(!titlesMatch(normalizeTitleKey('Bad UI'), normalizeTitleKey('Bad UI everywhere')))
  })
})

// ── mergeDetectorFindings ────────────────────────────────────────────────────

describe('mergeDetectorFindings', () => {
  test('returns the LLM findings untouched when there is no detector output', () => {
    const llm = [finding('A', 'a.css')]
    assert.deepEqual(mergeDetectorFindings(llm, []), llm)
  })

  test('appends detector findings the agent did not cover', () => {
    const merged = mergeDetectorFindings(
      [finding('Weak hierarchy', 'a.tsx')],
      [detectorFinding('Overused font', 'b.css')]
    )
    assert.equal(merged.length, 2)
    assert.ok(merged.some((f) => f.source === DETECTOR_SOURCE))
  })

  test('REGRESSION: three positional hits of one rule all survive', () => {
    const detector = [
      detectorFinding('Side-tab accent border', 'main.css'),
      detectorFinding('Side-tab accent border', 'main.css'),
      detectorFinding('Side-tab accent border', 'main.css')
    ]
    const merged = mergeDetectorFindings([finding('Something else', 'other.tsx')], detector)
    const sideTabs = merged.filter((f) => f.title === 'Side-tab accent border')
    assert.equal(sideTabs.length, 3, 'a rule firing N times must contribute N findings')
  })

  test('suppresses a whole rule group when the agent already reported it in that file', () => {
    const llm = [finding('Side-tab accent borders on cards', 'main.css')]
    const detector = [
      detectorFinding('Side-tab accent border', 'main.css'),
      detectorFinding('Side-tab accent border', 'main.css')
    ]
    const merged = mergeDetectorFindings(llm, detector)
    assert.equal(merged.length, 1, 'the agent write-up wins for that rule in that file')
    assert.equal(merged[0].source, undefined)
  })

  test('suppression is scoped per file — the same rule elsewhere still reports', () => {
    const llm = [finding('Side-tab accent border', 'main.css')]
    const detector = [
      detectorFinding('Side-tab accent border', 'main.css'),
      detectorFinding('Side-tab accent border', 'other.css')
    ]
    const merged = mergeDetectorFindings(llm, detector)
    const kept = merged.filter((f) => f.source === DETECTOR_SOURCE)
    assert.equal(kept.length, 1)
    assert.equal(kept[0].filePath, 'other.css')
  })

  test('an LLM finding in the same file but about a different rule does not suppress', () => {
    const llm = [finding('Poor colour contrast', 'main.css')]
    const detector = [detectorFinding('Side-tab accent border', 'main.css')]
    assert.equal(mergeDetectorFindings(llm, detector).length, 2)
  })

  test('LLM findings without a filePath never suppress detector findings', () => {
    const llm = [finding('Side-tab accent border', undefined)]
    const detector = [detectorFinding('Side-tab accent border', 'main.css')]
    assert.equal(mergeDetectorFindings(llm, detector).length, 2)
  })

  test('LLM findings always come first in the merged list', () => {
    const merged = mergeDetectorFindings(
      [finding('A', 'a.css'), finding('B', 'b.css')],
      [detectorFinding('C', 'c.css')]
    )
    assert.equal(merged[0].title, 'A')
    assert.equal(merged[2].title, 'C')
  })
})

// ── resolveExecutableCommands ────────────────────────────────────────────────

function config(commandIds: DesignRunConfig['commandIds']): DesignRunConfig {
  return { commandIds, scope: { mode: 'project', paths: [] }, brief: '' }
}

describe('DesignAgentService.resolveExecutableCommands', () => {
  test('runs critique before audit regardless of selection order', () => {
    assert.deepEqual(DesignAgentService.resolveExecutableCommands(config(['audit', 'critique'])), [
      'critique',
      'audit'
    ])
  })

  test('runs only the evaluate commands that were selected', () => {
    assert.deepEqual(DesignAgentService.resolveExecutableCommands(config(['audit'])), ['audit'])
  })

  test('ignores refine commands, which never execute', () => {
    assert.deepEqual(
      DesignAgentService.resolveExecutableCommands(config(['critique', 'animate', 'polish'])),
      ['critique']
    )
  })

  test('falls back to critique when only refine commands were selected', () => {
    assert.deepEqual(DesignAgentService.resolveExecutableCommands(config(['animate', 'bolder'])), [
      'critique'
    ])
  })
})

// ── discoverDesignFiles ──────────────────────────────────────────────────────

function scratchWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'design-discovery-'))
  mkdirSync(join(root, 'src', 'pages'), { recursive: true })
  mkdirSync(join(root, 'src', 'server'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(root, 'src', 'app.css'), 'body{}')
  writeFileSync(join(root, 'src', 'pages', 'Login.tsx'), 'export default 1')
  writeFileSync(join(root, 'src', 'pages', 'Home.tsx'), 'export default 1')
  writeFileSync(join(root, 'src', 'server', 'api.ts'), 'export const a = 1')
  writeFileSync(join(root, 'README.md'), '# hi')
  writeFileSync(join(root, 'node_modules', 'pkg', 'style.css'), 'a{}')
  return root
}

describe('discoverDesignFiles', () => {
  test('project scope finds design files and ignores backend and node_modules', () => {
    const root = scratchWorkspace()
    try {
      const r = discoverDesignFiles(root, { mode: 'project', paths: [] })
      assert.deepEqual(r.filePaths.sort(), [
        'src/app.css',
        'src/pages/Home.tsx',
        'src/pages/Login.tsx'
      ])
      assert.equal(r.totalFiles, 3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('path scope restricts discovery to the chosen directory', () => {
    const root = scratchWorkspace()
    try {
      const r = discoverDesignFiles(root, { mode: 'paths', paths: ['src/pages'] })
      assert.deepEqual(r.filePaths.sort(), ['src/pages/Home.tsx', 'src/pages/Login.tsx'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('path scope accepts an individual file', () => {
    const root = scratchWorkspace()
    try {
      const r = discoverDesignFiles(root, { mode: 'paths', paths: ['src/app.css'] })
      assert.deepEqual(r.filePaths, ['src/app.css'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a non-design file named explicitly is still excluded', () => {
    const root = scratchWorkspace()
    try {
      const r = discoverDesignFiles(root, { mode: 'paths', paths: ['src/server/api.ts'] })
      assert.deepEqual(r.filePaths, [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a missing scope path is skipped rather than throwing', () => {
    const root = scratchWorkspace()
    try {
      const r = discoverDesignFiles(root, { mode: 'paths', paths: ['does/not/exist'] })
      assert.deepEqual(r.filePaths, [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an empty paths list falls back to scanning the project', () => {
    const root = scratchWorkspace()
    try {
      assert.equal(discoverDesignFiles(root, { mode: 'paths', paths: [] }).totalFiles, 3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a backend-only workspace yields zero files, driving the not-applicable path', () => {
    const root = mkdtempSync(join(tmpdir(), 'design-backend-'))
    try {
      writeFileSync(join(root, 'server.ts'), 'export const a = 1')
      assert.equal(discoverDesignFiles(root, { mode: 'project', paths: [] }).totalFiles, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns POSIX-separated workspace-relative paths', () => {
    const root = scratchWorkspace()
    try {
      const r = discoverDesignFiles(root, { mode: 'project', paths: [] })
      for (const p of r.filePaths) {
        assert.ok(!p.startsWith('/'), `not relative: ${p}`)
        assert.ok(!p.includes('\\'), `not POSIX: ${p}`)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
