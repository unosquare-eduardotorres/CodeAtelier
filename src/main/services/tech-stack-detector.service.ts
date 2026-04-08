import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log'

const detectLogger = log.scope('tech-stack-detector')

export interface TechStackResult {
  detectedTechs: string[]
  recommendedSpecialists: string[]
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
 * Maps detected techs to specialist agentId values.
 * These should match agent_id values in the specialists table.
 */
const TECH_TO_SPECIALIST: Record<string, string[]> = {
  react: ['frontend-architect', 'design-specialist'],
  vue: ['frontend-architect', 'design-specialist'],
  angular: ['frontend-architect', 'design-specialist'],
  svelte: ['frontend-architect', 'design-specialist'],
  typescript: ['generalist-developer'],
  'node-backend': ['platform-engineer', 'generalist-developer'],
  tailwind: ['design-specialist'],
  electron: ['platform-architect', 'platform-engineer', 'frontend-architect'],
  dotnet: ['dotnet-architect'],
  python: ['generalist-developer'],
  'python-web': ['generalist-developer', 'platform-engineer'],
  rust: ['generalist-developer'],
  go: ['generalist-developer'],
  java: ['generalist-developer'],
  ruby: ['generalist-developer'],
  php: ['generalist-developer'],
  sqlite: ['data-architect'],
  database: ['data-architect'],
  supabase: ['data-architect'],
  docker: ['platform-engineer'],
  terraform: ['platform-engineer'],
  testing: ['testing-specialist']
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

  // Deduplicate recommended specialists
  const specialistSet = new Set<string>()
  for (const tech of detectedTechs) {
    const specialists = TECH_TO_SPECIALIST[tech]
    if (specialists) {
      for (const s of specialists) specialistSet.add(s)
    }
  }

  const result: TechStackResult = {
    detectedTechs,
    recommendedSpecialists: Array.from(specialistSet),
    confidence
  }

  detectLogger.info(
    `Detected techs: ${detectedTechs.join(', ')} → recommended specialists: ${result.recommendedSpecialists.join(', ')}`
  )

  return result
}
