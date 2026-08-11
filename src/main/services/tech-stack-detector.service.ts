import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import log from 'electron-log'

const detectLogger = log.scope('tech-stack-detector')

export interface TechStackResult {
  detectedTechs: string[]
  /** Skill IDs the Project Specialist should auto-attach (all start disabled). */
  recommendedSkills: string[]
  /** MCP server IDs the Project Specialist should enable by default. */
  recommendedMcps: string[]
  confidence: Record<string, number>
}

interface TechMarker {
  files: string[]
  deps?: string[]
  tech: string
}

const TECH_MARKERS: TechMarker[] = [
  // JavaScript/TypeScript ecosystem
  { files: ['package.json'], deps: ['react', 'react-dom', 'next'], tech: 'react' },
  { files: ['package.json'], deps: ['vue', 'nuxt'], tech: 'vue' },
  { files: ['package.json'], deps: ['angular', '@angular/core'], tech: 'angular' },
  { files: ['package.json'], deps: ['svelte', '@sveltejs/kit'], tech: 'svelte' },
  { files: ['tsconfig.json'], tech: 'typescript' },
  { files: ['package.json'], deps: ['express', 'fastify', 'koa', 'hono'], tech: 'node-backend' },
  { files: ['package.json'], deps: ['tailwindcss', '@tailwindcss/typography'], tech: 'tailwind' },

  // Vite / Next.js (config-file driven, also useful for monorepo subdir detection)
  { files: ['vite.config.ts', 'vite.config.mts', 'vite.config.js'], tech: 'vite' },
  { files: ['next.config.mjs', 'next.config.ts', 'next.config.js'], tech: 'nextjs' },

  // Electron
  {
    files: ['electron-builder.yml', 'electron.vite.config.ts', 'electron.vite.config.mts'],
    tech: 'electron'
  },
  { files: ['package.json'], deps: ['electron'], tech: 'electron' },

  // .NET (modern SDK-style + classic .NET Framework markers)
  {
    files: [
      '*.csproj',
      '*.vbproj',
      '*.sln',
      '*.slnx',
      'global.json',
      'packages.config',
      'web.config',
      'App.config',
      'Global.asax'
    ],
    tech: 'dotnet'
  },
  // C# source presence — the single most reliable .NET signal in repos whose
  // project files sit below the candidate-dir horizon.
  { files: ['*.cs'], tech: 'csharp' },

  // SQL / database projects
  { files: ['*.sqlproj', '*.dacpac'], tech: 'sql' },

  // Python
  {
    files: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'poetry.lock'],
    tech: 'python'
  },
  {
    files: ['pyproject.toml', 'requirements.txt'],
    deps: ['django', 'flask', 'fastapi'],
    tech: 'python-web'
  },

  // Rust
  { files: ['Cargo.toml'], tech: 'rust' },

  // Go
  { files: ['go.mod', 'go.sum'], tech: 'go' },

  // Java/Kotlin
  { files: ['pom.xml', 'build.gradle', 'build.gradle.kts'], tech: 'java' },

  // Ruby
  { files: ['Gemfile', 'Rakefile'], tech: 'ruby' },

  // PHP
  { files: ['composer.json'], tech: 'php' },

  // Database
  { files: ['package.json'], deps: ['better-sqlite3', 'sqlite3'], tech: 'sqlite' },
  {
    files: ['package.json'],
    deps: ['pg', 'knex', 'prisma', 'drizzle-orm', 'typeorm', 'sequelize'],
    tech: 'database'
  },
  { files: ['supabase/config.toml', '.supabase'], tech: 'supabase' },

  // Docker / infra
  { files: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'], tech: 'docker' },
  { files: ['terraform.tf', 'main.tf'], tech: 'terraform' },

  // Testing
  {
    files: ['package.json'],
    deps: ['jest', 'vitest', '@playwright/test', 'mocha', 'cypress'],
    tech: 'testing'
  },
  // Playwright — config file alone is a strong signal; deps optional.
  {
    files: ['playwright.config.ts', 'playwright.config.js'],
    deps: ['@playwright/test', 'playwright'],
    tech: 'playwright'
  }
]

/**
 * Maps detected techs to skill filenames/IDs the Project Specialist should
 * auto-attach (starting disabled — user enables from the Skills tab).
 * Values must match `skills.filename` (or whatever stable key the skill
 * repository exposes) so the builder can look them up.
 */
export const TECH_TO_SKILL: Record<string, string[]> = {
  react: ['ui-ux-pro-max', 'design-system'],
  vue: ['ui-ux-pro-max'],
  angular: ['ui-ux-pro-max'],
  svelte: ['ui-ux-pro-max'],
  typescript: ['general-dev'],
  'node-backend': ['general-dev'],
  tailwind: ['design-system', 'design'],
  electron: ['electron-pro', 'ipc-patterns'],
  dotnet: ['dotnet-architect'],
  csharp: ['dotnet-architect'],
  sql: ['sqlite-patterns'],
  python: ['general-dev'],
  'python-web': ['general-dev'],
  rust: ['general-dev'],
  go: ['general-dev'],
  java: ['general-dev'],
  ruby: ['general-dev'],
  php: ['general-dev'],
  sqlite: ['sqlite-patterns'],
  database: ['sqlite-patterns'],
  supabase: ['supabase-architect'],
  docker: ['infrastructure'],
  terraform: ['infrastructure'],
  testing: ['testing-specialist'],
  vite: ['general-dev'],
  nextjs: ['general-dev', 'ui-ux-pro-max'],
  playwright: ['testing-specialist']
}

/**
 * Maps detected techs to MCP server IDs. Surfaced as non-binding
 * recommendations on the workspace-settings UI — the workspace still
 * decides which MCPs are enabled via its feature flags.
 */
export const TECH_TO_MCP: Record<string, string[]> = {
  // Code-graph and semantic search are universally useful for code navigation.
  typescript: ['code-graph', 'semantic-search'],
  react: ['code-graph', 'semantic-search'],
  vue: ['code-graph', 'semantic-search'],
  angular: ['code-graph', 'semantic-search'],
  svelte: ['code-graph', 'semantic-search'],
  'node-backend': ['code-graph', 'semantic-search'],
  electron: ['code-graph', 'semantic-search'],
  dotnet: ['code-graph'],
  csharp: ['code-graph'],
  sql: ['code-graph'],
  python: ['code-graph', 'semantic-search'],
  'python-web': ['code-graph', 'semantic-search'],
  rust: ['code-graph'],
  go: ['code-graph'],
  java: ['code-graph'],
  ruby: ['code-graph'],
  php: ['code-graph']
}

// ── Candidate-directory scanning (monorepo-aware) ──────────────────

/** Convention dirs we always probe at depth 1 when present. */
const CONVENTION_DIRS = [
  'frontend',
  'backend',
  'web',
  'api',
  'client',
  'server',
  'src',
  'app',
  'electron',
  'services',
  'ui',
  'desktop',
  'mobile'
] as const

/** Container dirs whose direct children are individually scanned (monorepo apps/packages). */
const MONOREPO_CONTAINER_DIRS = ['apps', 'packages'] as const

/** Directory names that must NEVER be scanned, even at the workspace root. */
const DIR_DENYLIST = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'bin',
  'obj',
  '.next',
  '.cache',
  '.output',
  'coverage',
  'target',
  'vendor'
])

/** Hard cap on total candidate dirs scanned per workspace — keeps detection fast. */
const MAX_CANDIDATE_DIRS = 30
/** Cap per monorepo container (apps/, packages/) — protects against gigantic monorepos. */
const MAX_PER_CONTAINER = 12

/**
 * Build the list of candidate directories to probe for tech-stack markers.
 *
 * - Always includes the workspace root.
 * - Includes one-level convention dirs (frontend, backend, web, …) when present.
 * - Includes each direct child of monorepo containers (apps/, packages/), capped at 12 per container.
 * - Skips anything in DIR_DENYLIST (node_modules, dist, .git, …).
 * - Hard-caps the returned list at 30 dirs.
 *
 * Exported for unit-test inspection.
 */
export function collectCandidateDirs(workspacePath: string): string[] {
  const root = resolve(workspacePath)
  const dirs: string[] = [root]

  const isUsableDir = (abs: string, name: string): boolean => {
    if (DIR_DENYLIST.has(name)) return false
    try {
      return statSync(abs).isDirectory()
    } catch {
      return false
    }
  }

  // 1. Convention dirs at depth 1.
  for (const name of CONVENTION_DIRS) {
    const abs = join(root, name)
    if (isUsableDir(abs, name)) dirs.push(abs)
  }

  // 2. Monorepo containers (apps/, packages/) — include each direct child.
  for (const container of MONOREPO_CONTAINER_DIRS) {
    const containerAbs = join(root, container)
    if (!isUsableDir(containerAbs, container)) continue
    let children: string[]
    try {
      children = readdirSync(containerAbs)
    } catch {
      continue
    }
    let added = 0
    for (const child of children) {
      if (added >= MAX_PER_CONTAINER) break
      const childAbs = join(containerAbs, child)
      if (isUsableDir(childAbs, child)) {
        dirs.push(childAbs)
        added++
      }
    }
  }

  // 3. Hard cap.
  if (dirs.length > MAX_CANDIDATE_DIRS) {
    detectLogger.info(
      `Candidate dirs capped: ${dirs.length} → ${MAX_CANDIDATE_DIRS} (workspace=${root})`
    )
    return dirs.slice(0, MAX_CANDIDATE_DIRS)
  }
  return dirs
}

// ── Bounded recursive glob scanning ────────────────────────────────

/**
 * How deep below each candidate dir glob markers (`*.csproj`, `*.cs`, …) are
 * searched. Depth 0 alone missed the extremely common .NET layout
 * `<Root>/<Project>/<Project>.csproj`, which is why large C# repos previously
 * detected nothing but `docker` (a root-level Dockerfile).
 */
const MAX_GLOB_DEPTH = 3

/**
 * Shared cap on directory entries visited by glob scanning across ONE
 * detection pass. Candidate dirs overlap (root already covers `backend/`),
 * so a single budget keeps huge monorepos from turning detection into a
 * full-tree walk.
 */
const MAX_GLOB_ENTRIES = 20_000

interface GlobScanContext {
  /** Candidate dir → lowercased file extensions found within MAX_GLOB_DEPTH. */
  cache: Map<string, Set<string>>
  /** Remaining directory-entry budget for this detection pass. */
  budget: number
}

function newGlobScanContext(): GlobScanContext {
  return { cache: new Map(), budget: MAX_GLOB_ENTRIES }
}

/**
 * Collect the set of file extensions present under `dirPath`, walking at most
 * MAX_GLOB_DEPTH levels and never entering denylisted or dot-directories.
 * Cached per dir; charged against the pass-wide entry budget.
 */
function collectExtensions(dirPath: string, ctx: GlobScanContext): Set<string> {
  const cached = ctx.cache.get(dirPath)
  if (cached) return cached

  const exts = new Set<string>()
  const walk = (abs: string, depth: number): void => {
    if (depth > MAX_GLOB_DEPTH || ctx.budget <= 0) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (ctx.budget <= 0) return
      ctx.budget--
      if (entry.isDirectory()) {
        if (DIR_DENYLIST.has(entry.name) || entry.name.startsWith('.')) continue
        walk(join(abs, entry.name), depth + 1)
      } else {
        const dot = entry.name.lastIndexOf('.')
        if (dot > 0) exts.add(entry.name.slice(dot).toLowerCase())
      }
    }
  }
  walk(dirPath, 0)

  ctx.cache.set(dirPath, exts)
  return exts
}

function filePatternExists(dirPath: string, pattern: string, ctx: GlobScanContext): boolean {
  if (pattern.includes('*')) {
    // Glob pattern — search the bounded subtree, not just this dir.
    const ext = pattern.replace('*', '').toLowerCase()
    return collectExtensions(dirPath, ctx).has(ext)
  }

  // Check file or directory directly under this dir.
  return existsSync(join(dirPath, pattern))
}

// ── Code-graph evidence ────────────────────────────────────────────

/**
 * File extensions in the code-graph index that imply a technology. This is the
 * strongest available signal: it reflects what was actually parsed in the repo
 * rather than which marker files happened to sit near the root.
 */
const CODE_GRAPH_EXT_TO_TECH: Record<string, string[]> = {
  '.cs': ['dotnet', 'csharp'],
  '.vb': ['dotnet'],
  '.sql': ['sql'],
  '.ts': ['typescript'],
  '.tsx': ['typescript'],
  '.py': ['python'],
  '.go': ['go'],
  '.rs': ['rust'],
  '.java': ['java'],
  '.kt': ['java'],
  '.rb': ['ruby'],
  '.php': ['php']
}

/** Minimum indexed files of one extension before it counts as evidence. */
const CODE_GRAPH_MIN_FILES = 5

/** Confidence assigned to code-graph-derived techs (above file-marker 0.7). */
const CODE_GRAPH_CONFIDENCE = 0.85

/**
 * Derive techs from the workspace's code-graph index. Best-effort: any DB
 * problem (not initialised, table missing, workspace never indexed) yields an
 * empty map rather than failing detection.
 *
 * Exported for unit-test inspection.
 */
export function detectFromCodeGraph(workspaceId: string): Map<string, number> {
  const found = new Map<string, number>()
  let rows: Array<{ rel_fname: string }>
  try {
    // Lazy require: a static `../db/index` import would drag better-sqlite3 and
    // the `?raw` schema import into every consumer of this module (7 callers,
    // several of which run outside an Electron/DB context).
    // KNOWN BROKEN IN PACKAGED BUILDS — relative require() does not survive
    // electron-vite bundling, so detectFromCodeGraph always returns an empty
    // map at runtime. The laziness above is a deliberate tradeoff (7 callers
    // run outside an Electron/DB context), so the fix needs an injected
    // accessor rather than a plain static import. Tracked separately.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-restricted-syntax
    const { getDatabase } = require('../db/index') as typeof import('../db/index')
    // DISTINCT collapses the many tags-per-file down to a file list, which is
    // what the ≥N-files threshold is actually about.
    rows = getDatabase()
      .prepare(`SELECT DISTINCT rel_fname FROM code_graph_tags WHERE workspace_id = ?`)
      .all(workspaceId) as Array<{ rel_fname: string }>
  } catch (err) {
    detectLogger.debug(`[detect:code-graph] unavailable for ${workspaceId}: ${String(err)}`)
    return found
  }

  const histogram = new Map<string, number>()
  for (const row of rows) {
    const name = row.rel_fname
    if (!name) continue
    const dot = name.lastIndexOf('.')
    if (dot <= 0) continue
    const ext = name.slice(dot).toLowerCase()
    if (!(ext in CODE_GRAPH_EXT_TO_TECH)) continue
    histogram.set(ext, (histogram.get(ext) ?? 0) + 1)
  }

  const evidence: string[] = []
  for (const [ext, count] of histogram) {
    if (count < CODE_GRAPH_MIN_FILES) continue
    evidence.push(`${ext}=${count}`)
    for (const tech of CODE_GRAPH_EXT_TO_TECH[ext]) {
      found.set(tech, CODE_GRAPH_CONFIDENCE)
    }
  }

  detectLogger.info(
    `[detect:code-graph] ${rows.length} indexed files → ${
      evidence.length > 0 ? evidence.join(' ') : '(no qualifying extensions)'
    } → techs: [${Array.from(found.keys()).join(', ')}]`
  )
  return found
}

/** Per-dir cache for package.json deps so each dir is parsed at most once per detection. */
function readPackageJsonDeps(dirPath: string, cache: Map<string, Set<string>>): Set<string> {
  const cached = cache.get(dirPath)
  if (cached) return cached

  const pkgPath = join(dirPath, 'package.json')
  if (!existsSync(pkgPath)) {
    const empty = new Set<string>()
    cache.set(dirPath, empty)
    return empty
  }

  try {
    const raw = readFileSync(pkgPath, 'utf-8')
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const allDeps = new Set<string>()
    for (const dep of Object.keys(pkg.dependencies ?? {})) allDeps.add(dep)
    for (const dep of Object.keys(pkg.devDependencies ?? {})) allDeps.add(dep)
    cache.set(dirPath, allDeps)
    return allDeps
  } catch {
    const empty = new Set<string>()
    cache.set(dirPath, empty)
    return empty
  }
}

/**
 * Detect the workspace tech stack from two independent sources:
 *
 *   1. Marker files under candidate dirs (glob markers searched recursively to
 *      MAX_GLOB_DEPTH, under a shared entry budget).
 *   2. The code-graph index, when `workspaceId` is supplied — an extension
 *      histogram over indexed files. This is the stronger signal and the only
 *      one that survives unusual repo layouts.
 *
 * `workspaceId` is optional so the six callers that have no workspace id keep
 * working unchanged; they simply lose source 2.
 */
export function detectTechStack(workspacePath: string, workspaceId?: string): TechStackResult {
  const detected = new Map<string, number>()
  const depsCache = new Map<string, Set<string>>()
  const globCtx = newGlobScanContext()
  const candidates = collectCandidateDirs(workspacePath)
  // One aggregated diagnostic line: which dirs were probed and what each
  // yielded. Dirs reporting '(none)' are how a mis-scoped scan shows itself.
  const dirSummary: string[] = []

  for (const dir of candidates) {
    const perDirHits: string[] = []
    for (const marker of TECH_MARKERS) {
      let fileMatch = false
      for (const filePattern of marker.files) {
        if (filePatternExists(dir, filePattern, globCtx)) {
          fileMatch = true
          break
        }
      }

      if (!fileMatch) continue

      // If marker requires checking deps inside package.json
      if (marker.deps && marker.deps.length > 0) {
        const deps = readPackageJsonDeps(dir, depsCache)
        const matchedDep = marker.deps.some((dep) => deps.has(dep))
        if (!matchedDep) continue
        // Higher confidence if dep explicitly found
        detected.set(marker.tech, Math.max(detected.get(marker.tech) ?? 0, 0.9))
        perDirHits.push(marker.tech)
      } else {
        // File marker only — slightly lower confidence
        detected.set(marker.tech, Math.max(detected.get(marker.tech) ?? 0, 0.7))
        perDirHits.push(marker.tech)
      }
    }
    const rel = dir === resolve(workspacePath) ? '.' : dir.slice(resolve(workspacePath).length + 1)
    dirSummary.push(`${rel}=[${perDirHits.join(' ') || 'none'}]`)
  }

  detectLogger.info(
    `[detect:dirs] ${workspacePath} — ${candidates.length} candidate(s): ${dirSummary.join(' ')}`
  )

  if (globCtx.budget <= 0) {
    detectLogger.warn(
      `[detect] Glob entry budget (${MAX_GLOB_ENTRIES}) exhausted — deep markers may have been missed in ${workspacePath}`
    )
  }

  // Source 2 — code-graph evidence. Wins on confidence where it overlaps.
  if (workspaceId) {
    for (const [tech, conf] of detectFromCodeGraph(workspaceId)) {
      detected.set(tech, Math.max(detected.get(tech) ?? 0, conf))
    }
  }

  const detectedTechs = Array.from(detected.keys())
  const confidence: Record<string, number> = {}
  for (const [tech, conf] of detected) {
    confidence[tech] = conf
  }

  // Project-Specialist world: recommend skills + MCPs scoped to the detected tech stack.
  const skillSet = new Set<string>()
  const mcpSet = new Set<string>()
  for (const tech of detectedTechs) {
    for (const s of TECH_TO_SKILL[tech] ?? []) skillSet.add(s)
    for (const m of TECH_TO_MCP[tech] ?? []) mcpSet.add(m)
  }

  const result: TechStackResult = {
    detectedTechs,
    recommendedSkills: Array.from(skillSet),
    recommendedMcps: Array.from(mcpSet),
    confidence
  }

  detectLogger.info(
    `Detected techs: ${detectedTechs.join(', ')} → skills: [${result.recommendedSkills.join(', ')}] mcps: [${result.recommendedMcps.join(', ')}] (scanned ${candidates.length} dirs, codeGraph=${workspaceId ? 'on' : 'off'})`
  )

  return result
}
