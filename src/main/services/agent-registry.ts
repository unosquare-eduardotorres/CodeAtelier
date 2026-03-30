import { readFileSync, readdirSync, existsSync, watchFile, unwatchFile } from 'node:fs'
import { join } from 'node:path'
import type { Skill } from '../../shared/types'
import { agentRegistryLogger } from '../logger'
import { specialistRepository, skillRepository } from '../db/repositories'

const log = agentRegistryLogger

// ── Types ──

export interface AgentDefinition {
  /** Unique agent identifier (e.g. 'react-architect') — from YAML `name:` field */
  agentId: string
  /** Human-readable display name */
  displayName: string
  /** Agent description from YAML */
  description: string
  /** Model to use (e.g. 'sonnet', 'opus') */
  model: string
  /** Tools the agent can use */
  tools: string[]
  /** Skill directory names (e.g. ['electron-pro', 'ipc-patterns']) */
  skillNames: string[]
  /** Full body content from YAML (the prompt below the frontmatter) */
  prompt: string
  /** Source YAML filename (e.g. 'react-architect.yml') */
  sourceFilename: string
  /** Absolute file path to the YAML */
  filePath: string
  /** UI metadata (from AGENT_META defaults) */
  icon: string
  color: string
  priority: number
}

/** Default icon/color/displayName for known agents */
const AGENT_META: Record<string, { icon: string; color: string; displayName: string; priority: number }> = {
  generalist: { icon: '🎨', color: '#D97706', displayName: 'Da Vinci', priority: 0 },
  'generalist-agent': { icon: '🎨', color: '#D97706', displayName: 'Da Vinci', priority: 0 },
  'frontend-architect': { icon: '⚛️', color: '#61DAFB', displayName: 'Frontend Architect', priority: 2 },
  'platform-architect': { icon: '⚡', color: '#47848F', displayName: 'Platform Architect', priority: 3 },
  'data-architect': { icon: '🗄️', color: '#336791', displayName: 'Data Architect', priority: 4 },
  'design-specialist': { icon: '🎨', color: '#DB2777', displayName: 'Design Specialist', priority: 5 },
  planner: { icon: '📋', color: '#059669', displayName: 'Planner', priority: 6 },
  'platform-engineer': { icon: '🚀', color: '#DC2626', displayName: 'Platform Engineer', priority: 7 },
  'dx-specialist': { icon: '📄', color: '#7C3AED', displayName: 'DX Specialist', priority: 8 },
  'dotnet-architect': { icon: '🟣', color: '#512BD4', displayName: '.NET Architect', priority: 9 },
  'generalist-developer': { icon: '🔧', color: '#6366F1', displayName: 'Generalist Dev', priority: 10 },
  // Legacy aliases — keep for existing DB records referencing old agent IDs
  'react-architect': { icon: '⚛️', color: '#61DAFB', displayName: 'Frontend Architect', priority: 2 },
  'db-architect': { icon: '🗄️', color: '#336791', displayName: 'Data Architect', priority: 4 },
  'ux-ui-specialist': { icon: '🎨', color: '#DB2777', displayName: 'Design Specialist', priority: 5 },
  'electron-architect': { icon: '⚡', color: '#47848F', displayName: 'Platform Architect', priority: 3 },
  'agentic-architect': { icon: '⚡', color: '#47848F', displayName: 'Platform Architect', priority: 3 }
}

// ── Simple YAML Parser (reused from workspace-deploy.service.ts) ──

function parseAgentYaml(content: string): {
  frontmatter: Record<string, unknown>
  body: string
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return { frontmatter: {}, body: content }
  }

  const frontmatterRaw = match[1]
  const body = match[2].trim()
  const frontmatter: Record<string, unknown> = {}

  let currentKey = ''
  let currentValue = ''
  let isMultiline = false

  for (const line of frontmatterRaw.split('\n')) {
    if (isMultiline) {
      if (line.startsWith('  ') || line.startsWith('\t')) {
        currentValue += ' ' + line.trim()
        continue
      } else {
        frontmatter[currentKey] = currentValue.trim()
        isMultiline = false
      }
    }

    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (kvMatch) {
      currentKey = kvMatch[1]
      const val = kvMatch[2].trim()

      if (val === '>' || val === '|') {
        isMultiline = true
        currentValue = ''
      } else if (val.startsWith('[') && val.endsWith(']')) {
        frontmatter[currentKey] = val
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      } else {
        frontmatter[currentKey] = val
      }
    }
  }

  if (isMultiline) {
    frontmatter[currentKey] = currentValue.trim()
  }

  return { frontmatter, body }
}

/** Convert kebab-case to Title Case */
function formatDisplayName(agentId: string): string {
  return agentId
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

// ── AgentRegistry ──

/**
 * In-memory registry of agent definitions parsed from YAML files.
 *
 * **YAML is the single source of truth.** The DB `specialists` table acts as a
 * read cache that's rebuilt on demand from YAML. UI-only customizations (icon,
 * color overrides) live in the DB but don't affect the registry.
 *
 * Lifecycle:
 *   1. `loadFromDisk()` at startup — parses all `.claude/agents/*.yml`
 *   2. `getAgent(id)` — runtime lookups by agentId
 *   3. `getSkillsForAgent(id)` — resolves skill names to Skill records from DB
 *   4. `refreshFromDisk()` — hot-reload on file change
 */
export class AgentRegistry {
  private agents = new Map<string, AgentDefinition>()
  private masterDir: string
  private watchHandles: string[] = []

  constructor() {
    this.masterDir = join(process.cwd(), '.claude', 'agents')
  }

  /**
   * Load all agent YAMLs from the master `.claude/agents/` directory.
   * Call once at startup or after disk changes.
   */
  loadFromDisk(): void {
    const startTime = Date.now()
    this.agents.clear()

    if (!existsSync(this.masterDir)) {
      log.warn('No agents directory found at:', this.masterDir)
      return
    }

    try {
      const files = readdirSync(this.masterDir)
      for (const filename of files) {
        if (!filename.endsWith('.yml') && !filename.endsWith('.yaml')) continue

        try {
          const filePath = join(this.masterDir, filename)
          const content = readFileSync(filePath, 'utf-8')
          const { frontmatter, body } = parseAgentYaml(content)

          const agentId = (frontmatter.name as string) ?? filename.replace(/\.ya?ml$/, '')
          const meta = AGENT_META[agentId]

          const definition: AgentDefinition = {
            agentId,
            displayName: meta?.displayName ?? formatDisplayName(agentId),
            description: (frontmatter.description as string) ?? '',
            model: (frontmatter.model as string) ?? 'sonnet',
            tools: Array.isArray(frontmatter.tools) ? (frontmatter.tools as string[]) : [],
            skillNames: Array.isArray(frontmatter.skills) ? (frontmatter.skills as string[]) : [],
            prompt: body,
            sourceFilename: filename,
            filePath,
            icon: meta?.icon ?? '🔧',
            color: meta?.color ?? '#6366F1',
            priority: meta?.priority ?? 100
          }

          this.agents.set(agentId, definition)
        } catch (err) {
          log.warn(`Failed to parse agent YAML ${filename}:`, err)
        }
      }
    } catch (err) {
      log.error('Failed to scan agents directory:', err)
    }

    log.info(`Loaded ${this.agents.size} agents from disk in ${Date.now() - startTime}ms`)
  }

  /** Get an agent definition by ID */
  getAgent(agentId: string): AgentDefinition | undefined {
    return this.agents.get(agentId)
  }

  /** Get all loaded agent definitions */
  getAllAgents(): AgentDefinition[] {
    return Array.from(this.agents.values())
  }

  /** Get all specialist agents (excludes generalist aliases) */
  getSpecialists(): AgentDefinition[] {
    return this.getAllAgents().filter(
      (a) => a.agentId !== 'generalist' && a.agentId !== 'generalist-agent'
    )
  }

  /** Get active specialists from the DB, enriched with YAML data */
  getActiveSpecialists(): AgentDefinition[] {
    const activeFromDb = specialistRepository.findActive()
    const activeIds = new Set(activeFromDb.map((s) => s.agentId))
    return this.getSpecialists().filter((a) => activeIds.has(a.agentId))
  }

  /**
   * Resolve skill names for an agent to actual Skill records from the DB.
   * This is the deterministic replacement for `matchSkill()` — no LLM needed.
   */
  getSkillsForAgent(agentId: string): Skill[] {
    const agent = this.agents.get(agentId)
    if (!agent || agent.skillNames.length === 0) return []

    const allSkills = skillRepository.findAll()
    const skillByDirName = new Map<string, Skill>()
    for (const sk of allSkills) {
      // Map by directory name: "electron-pro.md" → "electron-pro"
      skillByDirName.set(sk.filename.replace(/\.md$/, ''), sk)
      // Also map by lowercase name for fuzzy match
      skillByDirName.set(sk.name.toLowerCase().replace(/\s+/g, '-'), sk)
    }

    const resolved: Skill[] = []
    for (const skillName of agent.skillNames) {
      const skill = skillByDirName.get(skillName)
      if (skill) {
        resolved.push(skill)
      } else {
        log.debug(`Skill "${skillName}" referenced by ${agentId} not found in DB`)
      }
    }

    return resolved
  }

  /** Refresh the registry from disk (hot-reload) */
  refreshFromDisk(): void {
    log.info('Refreshing agent registry from disk...')
    this.loadFromDisk()
  }

  /**
   * Start watching YAML files for changes.
   * Uses fs.watchFile (polling) for reliability across platforms.
   */
  startWatching(): void {
    if (!existsSync(this.masterDir)) return

    try {
      const files = readdirSync(this.masterDir)
      for (const filename of files) {
        if (!filename.endsWith('.yml') && !filename.endsWith('.yaml')) continue

        const filePath = join(this.masterDir, filename)
        watchFile(filePath, { interval: 5000 }, () => {
          log.info(`Agent YAML changed: ${filename}, refreshing registry...`)
          this.refreshFromDisk()
        })
        this.watchHandles.push(filePath)
      }

      log.info(`Watching ${this.watchHandles.length} agent YAML files for changes`)
    } catch {
      log.warn('Failed to set up YAML file watching')
    }
  }

  /** Stop watching files */
  stopWatching(): void {
    for (const filePath of this.watchHandles) {
      unwatchFile(filePath)
    }
    this.watchHandles = []
  }

  /** Get the count of loaded agents */
  get size(): number {
    return this.agents.size
  }
}

/** Singleton instance — initialized at import time, loaded via `loadFromDisk()` call */
export const agentRegistry = new AgentRegistry()
