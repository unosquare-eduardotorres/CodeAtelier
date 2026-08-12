/**
 * Unit tests for tech-stack-detector — exercises monorepo-aware candidate
 * directory scanning with real on-disk fixtures (no mocks).
 *
 * Each test creates an isolated tmp workspace, writes a minimal set of
 * marker files, and asserts the detected techs.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { detectTechStack, collectCandidateDirs } from '../tech-stack-detector.service'

function makeTmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'tsd-fixture-'))
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

function writeFile(root: string, relPath: string, content: string): void {
  const full = join(root, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

describe('tech-stack-detector', () => {
  test('root_only_react_typescript', () => {
    const root = makeTmpWorkspace()
    try {
      writeFile(
        root,
        'package.json',
        JSON.stringify({
          name: 'simple',
          dependencies: { react: '^19.0.0' }
        })
      )
      writeFile(root, 'tsconfig.json', '{}')

      const result = detectTechStack(root)
      assert.ok(result.detectedTechs.includes('react'), 'should detect react')
      assert.ok(result.detectedTechs.includes('typescript'), 'should detect typescript')
    } finally {
      cleanup(root)
    }
  })

  test('monorepo_react_dotnet_conectdah_shape', () => {
    const root = makeTmpWorkspace()
    try {
      // Root infra
      writeFile(root, 'Dockerfile', 'FROM node:24')
      // Frontend app (react + vite + ts) one level deep
      writeFile(
        root,
        'frontend/package.json',
        JSON.stringify({
          name: 'frontend',
          dependencies: { react: '^19.0.0' },
          devDependencies: { vite: '^7.0.0' }
        })
      )
      writeFile(root, 'frontend/tsconfig.json', '{}')
      writeFile(root, 'frontend/vite.config.ts', 'export default {}')
      // Backend .NET — ONLY the nested .csproj. Deliberately no top-level
      // solution file: with a depth-0 glob scan this shape detects nothing,
      // which is exactly the bug that made large C# repos look docker-only.
      writeFile(root, 'backend/src/Api/Api.csproj', '<Project></Project>')

      const result = detectTechStack(root)
      assert.ok(
        result.detectedTechs.includes('react'),
        `expected react, got ${result.detectedTechs.join(',')}`
      )
      assert.ok(
        result.detectedTechs.includes('typescript'),
        `expected typescript, got ${result.detectedTechs.join(',')}`
      )
      assert.ok(
        result.detectedTechs.includes('vite'),
        `expected vite, got ${result.detectedTechs.join(',')}`
      )
      assert.ok(
        result.detectedTechs.includes('dotnet'),
        `expected dotnet, got ${result.detectedTechs.join(',')}`
      )
      assert.ok(
        result.detectedTechs.includes('docker'),
        `expected docker, got ${result.detectedTechs.join(',')}`
      )
    } finally {
      cleanup(root)
    }
  })

  test('dotnet_framework_48_non_convention_dir', () => {
    const root = makeTmpWorkspace()
    try {
      // Classic ASP.NET shape: solution-named dir that is NOT in CONVENTION_DIRS,
      // no SDK-style project file at the root, no package.json anywhere.
      writeFile(root, 'Mulligan.Web/packages.config', '<packages></packages>')
      writeFile(root, 'Mulligan.Web/web.config', '<configuration></configuration>')
      writeFile(root, 'Mulligan.Web/Mulligan.Web.csproj', '<Project></Project>')
      writeFile(root, 'Mulligan.Web/Controllers/HomeController.cs', 'class HomeController {}')
      writeFile(root, 'Mulligan.Data/Scripts/schema.sqlproj', '<Project></Project>')

      const result = detectTechStack(root)
      assert.ok(
        result.detectedTechs.includes('dotnet'),
        `expected dotnet, got ${result.detectedTechs.join(',')}`
      )
      assert.ok(
        result.detectedTechs.includes('csharp'),
        `expected csharp, got ${result.detectedTechs.join(',')}`
      )
      assert.ok(
        result.detectedTechs.includes('sql'),
        `expected sql, got ${result.detectedTechs.join(',')}`
      )
      assert.ok(
        result.recommendedSkills.includes('dotnet-architect'),
        `expected dotnet-architect skill, got ${result.recommendedSkills.join(',')}`
      )
    } finally {
      cleanup(root)
    }
  })

  test('glob_depth_is_bounded', () => {
    const root = makeTmpWorkspace()
    try {
      // 5 levels below root — beyond MAX_GLOB_DEPTH (3), so it must NOT match.
      writeFile(root, 'a/b/c/d/e/Deep.csproj', '<Project></Project>')

      const result = detectTechStack(root)
      assert.ok(
        !result.detectedTechs.includes('dotnet'),
        `depth-5 marker should be out of range, got ${result.detectedTechs.join(',')}`
      )
    } finally {
      cleanup(root)
    }
  })

  test('monorepo_apps_pnpm_workspace', () => {
    const root = makeTmpWorkspace()
    try {
      writeFile(root, 'pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n")
      // apps/web — Next.js
      writeFile(
        root,
        'apps/web/package.json',
        JSON.stringify({
          name: 'web',
          dependencies: { next: '^14.0.0', react: '^19.0.0' }
        })
      )
      writeFile(root, 'apps/web/tsconfig.json', '{}')
      writeFile(root, 'apps/web/next.config.mjs', 'export default {}')
      // apps/api — express
      writeFile(
        root,
        'apps/api/package.json',
        JSON.stringify({
          name: 'api',
          dependencies: { express: '^4.0.0' }
        })
      )
      writeFile(root, 'apps/api/tsconfig.json', '{}')

      const result = detectTechStack(root)
      assert.ok(
        result.detectedTechs.includes('nextjs'),
        `expected nextjs, got ${result.detectedTechs.join(',')}`
      )
      assert.ok(
        result.detectedTechs.includes('react'),
        `expected react (transitive via next dep), got ${result.detectedTechs.join(',')}`
      )
      assert.ok(
        result.detectedTechs.includes('node-backend'),
        `expected node-backend, got ${result.detectedTechs.join(',')}`
      )
      assert.ok(
        result.detectedTechs.includes('typescript'),
        `expected typescript, got ${result.detectedTechs.join(',')}`
      )
    } finally {
      cleanup(root)
    }
  })

  test('denylist_skips_node_modules', () => {
    const root = makeTmpWorkspace()
    try {
      // Root has NO package.json — only nested under node_modules.
      writeFile(
        root,
        'node_modules/react/package.json',
        JSON.stringify({ name: 'react', version: '19.0.0' })
      )

      const result = detectTechStack(root)
      assert.ok(
        !result.detectedTechs.includes('react'),
        `should not descend into node_modules, got ${result.detectedTechs.join(',')}`
      )
    } finally {
      cleanup(root)
    }
  })

  test('candidate_dir_cap_under_30', () => {
    const root = makeTmpWorkspace()
    try {
      // Spawn 50 dummy children under packages/ — only 12 (per-container cap)
      // should be probed, and total must respect the 30-dir cap.
      for (let i = 0; i < 50; i++) {
        writeFile(root, `packages/p${i}/.keep`, '')
      }

      const dirs = collectCandidateDirs(root)
      assert.ok(dirs.length <= 30, `candidate dir count (${dirs.length}) must be <= 30`)
      // Container cap of 12 + the workspace root should put us comfortably under
      // 30 even before the global cap fires, so just sanity-check both bounds.
      assert.ok(dirs.length >= 1, 'should always include the workspace root')
    } finally {
      cleanup(root)
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
