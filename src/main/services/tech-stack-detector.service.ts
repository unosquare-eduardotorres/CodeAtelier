import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log'

const detectLogger = log.scope('tech-stack-detector')

export interface TechStackResult {
  detectedTechs: string[]
  /**
   * @deprecated App-global specialists were removed in migration 66. The field
   * is preserved so legacy callers compile; it now always returns an empty
   * array. New callers should use `recommendedSkills` and `recommendedMcps`.
   */
  recommendedSpecialists: string[]
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

  // Electron
  {
    files: ['electron-builder.yml', 'electron.vite.config.ts', 'electron.vite.config.mts'],
    tech: 'electron'
  },
  { files: ['package.json'], deps: ['electron'], tech: 'electron' },

  // .NET
  { files: ['*.csproj', '*.sln', 'global.json'], tech: 'dotnet' },

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
  testing: ['testing-specialist']
}

/**
 * Maps detected techs to MCP server IDs that should be composed into
 * specialists.mcp_config by the McpComposer.
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

function filePatternExists(workspacePath: string, pattern: string): boolean {
  if (pattern.includes('*')) {
    // Glob pattern — check if any matching files exist in the root
    const ext = pattern.replace('*', '')
    try {
      const entries = readdirSync(workspacePath)
      return entries.some((e) => e.endsWith(ext))
    } catch {
      return false
    }
  }

  // Check root-level file or directory
  return existsSync(join(workspacePath, pattern))
}

function readPackageJsonDeps(workspacePath: string): Set<string> {
  const pkgPath = join(workspacePath, 'package.json')
  if (!existsSync(pkgPath)) return new Set()

  try {
    const raw = readFileSync(pkgPath, 'utf-8')
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const allDeps = new Set<string>()
    for (const dep of Object.keys(pkg.dependencies ?? {})) allDeps.add(dep)
    for (const dep of Object.keys(pkg.devDependencies ?? {})) allDeps.add(dep)
    return allDeps
  } catch {
    return new Set()
  }
}

export function detectTechStack(workspacePath: string): TechStackResult {
  const detected = new Map<string, number>()
  let packageDeps: Set<string> | null = null

  for (const marker of TECH_MARKERS) {
    let fileMatch = false
    for (const filePattern of marker.files) {
      if (filePatternExists(workspacePath, filePattern)) {
        fileMatch = true
        break
      }
    }

    if (!fileMatch) continue

    // If marker requires checking deps inside package.json
    if (marker.deps && marker.deps.length > 0) {
      if (packageDeps === null) {
        packageDeps = readPackageJsonDeps(workspacePath)
      }
      const matchedDep = marker.deps.some((dep) => packageDeps!.has(dep))
      if (!matchedDep) continue
      // Higher confidence if dep explicitly found
      detected.set(marker.tech, Math.max(detected.get(marker.tech) ?? 0, 0.9))
    } else {
      // File marker only — slightly lower confidence
      detected.set(marker.tech, Math.max(detected.get(marker.tech) ?? 0, 0.7))
    }
  }

  const detectedTechs = Array.from(detected.keys())
  const confidence: Record<string, number> = {}
  for (const [tech, conf] of detected) {
    confidence[tech] = conf
  }

  // Project-Specialist world: we no longer recommend app-global specialists.
  // Keep the field as an empty array for backward compatibility.
  const skillSet = new Set<string>()
  const mcpSet = new Set<string>()
  for (const tech of detectedTechs) {
    for (const s of TECH_TO_SKILL[tech] ?? []) skillSet.add(s)
    for (const m of TECH_TO_MCP[tech] ?? []) mcpSet.add(m)
  }

  const result: TechStackResult = {
    detectedTechs,
    recommendedSpecialists: [],
    recommendedSkills: Array.from(skillSet),
    recommendedMcps: Array.from(mcpSet),
    confidence
  }

  detectLogger.info(
    `Detected techs: ${detectedTechs.join(', ')} → skills: [${result.recommendedSkills.join(', ')}] mcps: [${result.recommendedMcps.join(', ')}]`
  )

  return result
}
