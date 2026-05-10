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

  // .NET
  { files: ['*.csproj', '*.sln', '*.slnx', 'global.json'], tech: 'dotnet' },

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

function filePatternExists(dirPath: string, pattern: string): boolean {
  if (pattern.includes('*')) {
    // Glob pattern — check if any matching files exist in this dir.
    const ext = pattern.replace('*', '')
    try {
      const entries = readdirSync(dirPath)
      return entries.some((e) => e.endsWith(ext))
    } catch {
      return false
    }
  }

  // Check file or directory directly under this dir.
  return existsSync(join(dirPath, pattern))
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

export function detectTechStack(workspacePath: string): TechStackResult {
  const detected = new Map<string, number>()
  const depsCache = new Map<string, Set<string>>()
  const candidates = collectCandidateDirs(workspacePath)

  for (const dir of candidates) {
    const perDirHits: string[] = []
    for (const marker of TECH_MARKERS) {
      let fileMatch = false
      for (const filePattern of marker.files) {
        if (filePatternExists(dir, filePattern)) {
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
    if (perDirHits.length > 0) {
      detectLogger.debug(`[detect] ${dir} → ${perDirHits.join(', ')}`)
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
    `Detected techs: ${detectedTechs.join(', ')} → skills: [${result.recommendedSkills.join(', ')}] mcps: [${result.recommendedMcps.join(', ')}] (scanned ${candidates.length} dirs)`
  )

  return result
}
