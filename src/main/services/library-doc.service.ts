/**
 * Library Documentation Service — three-tier lookup with caching.
 *
 * Tier 1: Local cache (node_modules README) → instant, offline, covers installed deps
 * Tier 2: Context7 API (user's API key) → rich corpus (57K libs), for uninstalled deps
 * Tier 3: npm registry (registry.npmjs.org) → last resort, README only, no auth needed
 *
 * Docs are cached in the library_docs SQLite table with FTS5 for full-text search.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import { libraryDocRepository } from '../db/repositories/library-doc.repository'

const libDocLog = log.scope('library-docs')

// ── Types ──

export interface IndexResult {
  indexed: number
  skipped: number
  errors: string[]
}

export interface ResolvedLibrary {
  packageName: string
  version: string
  source: string
  sectionCount: number
}

export interface QueryResult {
  packageName: string
  version: string
  source: string
  sections: { title: string; content: string }[]
}

// ── Service ──

export class LibraryDocService {
  private readonly DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

  // ── Indexing (called on workspace open) ──

  /**
   * Index README docs from node_modules for all dependencies in package.json.
   * Skips packages already cached within TTL.
   */
  indexWorkspaceDependencies(workspaceId: string, workspacePath: string): IndexResult {
    const result: IndexResult = { indexed: 0, skipped: 0, errors: [] }

    // 1. Read package.json
    const pkgJsonPath = join(workspacePath, 'package.json')
    if (!existsSync(pkgJsonPath)) {
      libDocLog.info('[indexWorkspaceDeps] No package.json found — skipping')
      return result
    }

    let pkgJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
    } catch (err) {
      result.errors.push(`Failed to parse package.json: ${err}`)
      return result
    }

    // 2. Collect all dependency names
    const deps = new Set<string>([
      ...Object.keys(pkgJson.dependencies ?? {}),
      ...Object.keys(pkgJson.devDependencies ?? {})
    ])

    // 3. For each dep, check cache freshness and index if stale
    for (const depName of deps) {
      try {
        if (libraryDocRepository.isCached(workspaceId, depName, this.DEFAULT_TTL_MS)) {
          result.skipped++
          continue
        }

        const readmePath = this.findReadme(workspacePath, depName)
        if (!readmePath) {
          result.skipped++
          continue
        }

        const readmeContent = readFileSync(readmePath, 'utf-8')
        if (!readmeContent.trim()) {
          result.skipped++
          continue
        }

        // Read version from the package's package.json
        const depPkgPath = join(workspacePath, 'node_modules', depName, 'package.json')
        let version = ''
        try {
          const depPkg = JSON.parse(readFileSync(depPkgPath, 'utf-8'))
          version = depPkg.version ?? ''
        } catch {
          /* non-fatal */
        }

        const sections = this.chunkMarkdownBySections(readmeContent)
        libraryDocRepository.upsertSections(workspaceId, depName, version, 'node_modules', sections)
        result.indexed++
      } catch (err) {
        result.errors.push(`${depName}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return result
  }

  // ── Query (called by MCP tools) ──

  /**
   * Resolve a library by name — check local cache first, then Context7, then npm.
   * Returns matching packages with their source and section counts.
   */
  async resolveLibrary(
    workspaceId: string,
    workspacePath: string,
    libraryName: string,
    context7ApiKey?: string,
    query?: string
  ): Promise<ResolvedLibrary[]> {
    // Tier 1: Search local cache
    try {
      const cached = libraryDocRepository
        .listPackages(workspaceId)
        .filter((p) => p.packageName.includes(libraryName))
      if (cached.length > 0) {
        return cached.map((p) => ({
          packageName: p.packageName,
          version: p.version,
          source: p.source,
          sectionCount: p.sectionCount
        }))
      }
    } catch (err) {
      libDocLog.warn('[resolveLibrary] Cache lookup failed, trying other tiers:', err)
    }

    // Tier 2: Try Context7 API (if key configured)
    if (context7ApiKey) {
      try {
        const c7Results = await this.searchContext7(libraryName, context7ApiKey, query)
        if (c7Results.length > 0) return c7Results
      } catch (err) {
        libDocLog.warn('[resolveLibrary] Context7 search failed:', err)
      }
    }

    // Tier 3: Try indexing from node_modules on-demand
    const readmePath = this.findReadme(workspacePath, libraryName)
    if (readmePath) {
      try {
        const readmeContent = readFileSync(readmePath, 'utf-8')
        const sections = this.chunkMarkdownBySections(readmeContent)
        const depPkgPath = join(workspacePath, 'node_modules', libraryName, 'package.json')
        let version = ''
        try {
          version = JSON.parse(readFileSync(depPkgPath, 'utf-8')).version ?? ''
        } catch {
          /* non-fatal */
        }
        libraryDocRepository.upsertSections(
          workspaceId,
          libraryName,
          version,
          'node_modules',
          sections
        )
        return [
          {
            packageName: libraryName,
            version,
            source: 'node_modules',
            sectionCount: sections.length
          }
        ]
      } catch {
        /* fall through to npm */
      }
    }

    // Tier 3b: Check npm registry
    try {
      const npmReadme = await this.fetchNpmReadme(libraryName)
      if (npmReadme) {
        const sections = this.chunkMarkdownBySections(npmReadme.readme)
        try {
          libraryDocRepository.upsertSections(
            workspaceId,
            libraryName,
            npmReadme.version,
            'npm_registry',
            sections
          )
        } catch {
          /* DB may not be available — return results without caching */
        }
        return [
          {
            packageName: libraryName,
            version: npmReadme.version,
            source: 'npm_registry',
            sectionCount: sections.length
          }
        ]
      }
    } catch (err) {
      libDocLog.warn('[resolveLibrary] npm registry failed:', err)
    }

    return []
  }

  /**
   * Query documentation for a specific package.
   * Returns relevant sections via FTS5 search with three-tier fallback.
   */
  async queryDocs(
    workspaceId: string,
    _workspacePath: string,
    packageName: string,
    query: string,
    context7ApiKey?: string,
    maxSections = 5
  ): Promise<QueryResult> {
    // Tier 1: FTS5 search local cache
    try {
      const cached = libraryDocRepository.searchDocs(workspaceId, query, {
        packageName,
        maxResults: maxSections
      })
      if (cached.length > 0) {
        return {
          packageName,
          version: cached[0].version,
          source: cached[0].source,
          sections: cached.map((d) => ({ title: d.sectionTitle, content: d.sectionContent }))
        }
      }
    } catch (err) {
      libDocLog.warn('[queryDocs] Cache search failed, trying other tiers:', err)
    }

    // Tier 2: Fetch from Context7 → cache → return
    if (context7ApiKey) {
      try {
        const docs = await this.fetchContext7Docs(packageName, query, context7ApiKey)
        if (docs && docs.snippets.length > 0) {
          try {
            libraryDocRepository.upsertSections(
              workspaceId,
              packageName,
              '',
              'context7',
              docs.snippets
            )
          } catch {
            /* DB may not be available — return results without caching */
          }
          return {
            packageName,
            version: '',
            source: 'context7',
            sections: docs.snippets.slice(0, maxSections)
          }
        }
      } catch (err) {
        libDocLog.warn('[queryDocs] Context7 fetch failed:', err)
      }
    }

    // Tier 3: Fetch README from npm → cache → search
    try {
      const npmResult = await this.fetchNpmReadme(packageName)
      if (npmResult) {
        const sections = this.chunkMarkdownBySections(npmResult.readme)
        try {
          libraryDocRepository.upsertSections(
            workspaceId,
            packageName,
            npmResult.version,
            'npm_registry',
            sections
          )
          // FTS5 search the just-cached docs for relevance
          const searched = libraryDocRepository.searchDocs(workspaceId, query, {
            packageName,
            maxResults: maxSections
          })
          if (searched.length > 0) {
            return {
              packageName,
              version: npmResult.version,
              source: 'npm_registry',
              sections: searched.map((d) => ({ title: d.sectionTitle, content: d.sectionContent }))
            }
          }
        } catch {
          /* DB may not be available — return raw sections */
        }
        // If FTS5 found nothing or DB unavailable, return the first N sections
        return {
          packageName,
          version: npmResult.version,
          source: 'npm_registry',
          sections: sections.slice(0, maxSections)
        }
      }
    } catch (err) {
      libDocLog.warn('[queryDocs] npm fallback failed:', err)
    }

    return { packageName, version: '', source: 'none', sections: [] }
  }

  // ── Private helpers ──

  /** Find the README file in node_modules for a package (case-insensitive). */
  private findReadme(workspacePath: string, packageName: string): string | null {
    const basePath = join(workspacePath, 'node_modules', packageName)
    const candidates = ['README.md', 'readme.md', 'Readme.md', 'README.MD', 'README', 'readme']
    for (const candidate of candidates) {
      const fullPath = join(basePath, candidate)
      if (existsSync(fullPath)) return fullPath
    }
    return null
  }

  /**
   * Split markdown content by ## headings.
   * Sections > 3000 chars are split further at paragraph boundaries.
   */
  chunkMarkdownBySections(markdown: string): { title: string; content: string }[] {
    const sections: { title: string; content: string }[] = []
    const lines = markdown.split('\n')
    let currentTitle = 'README'
    let currentContent: string[] = []

    const flush = (): void => {
      const text = currentContent.join('\n').trim()
      if (text) {
        // Split oversized sections
        if (text.length > 3000) {
          const chunks = this.splitLargeSection(currentTitle, text)
          sections.push(...chunks)
        } else {
          sections.push({ title: currentTitle, content: text })
        }
      }
    }

    for (const line of lines) {
      const headingMatch = line.match(/^#{1,3}\s+(.+)/)
      if (headingMatch) {
        flush()
        currentTitle = headingMatch[1].trim()
        currentContent = []
      } else {
        currentContent.push(line)
      }
    }
    flush()

    // If no headings found, treat entire content as one section
    if (sections.length === 0 && markdown.trim()) {
      sections.push({ title: 'README', content: markdown.trim().slice(0, 3000) })
    }

    return sections
  }

  /** Split a large section into chunks at paragraph boundaries. */
  private splitLargeSection(title: string, text: string): { title: string; content: string }[] {
    const chunks: { title: string; content: string }[] = []
    const paragraphs = text.split(/\n\n+/)
    let current = ''
    let partIndex = 1

    for (const para of paragraphs) {
      if (current.length + para.length > 3000 && current.length > 0) {
        chunks.push({
          title: `${title} (part ${partIndex})`,
          content: current.trim()
        })
        current = ''
        partIndex++
      }
      current += para + '\n\n'
    }

    if (current.trim()) {
      chunks.push({
        title: partIndex > 1 ? `${title} (part ${partIndex})` : title,
        content: current.trim()
      })
    }

    return chunks
  }

  /** Search Context7 API for a library by name. */
  private async searchContext7(
    libraryName: string,
    apiKey: string,
    query?: string
  ): Promise<ResolvedLibrary[]> {
    const url = new URL('https://context7.com/api/v1/search')
    url.searchParams.set('query', query ? `${libraryName} ${query}` : libraryName)

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(10_000)
    })

    if (!response.ok) {
      throw new Error(`Context7 search failed: ${response.status} ${response.statusText}`)
    }

    const data = (await response.json()) as {
      results?: { id: string; title: string; version?: string; snippetCount?: number }[]
    }

    return (data.results ?? []).map((r) => ({
      packageName: r.id || r.title,
      version: r.version ?? '',
      source: 'context7',
      sectionCount: r.snippetCount ?? 0
    }))
  }

  /** Fetch documentation snippets from Context7 for a specific library. */
  private async fetchContext7Docs(
    libraryId: string,
    query: string,
    apiKey: string
  ): Promise<{ snippets: { title: string; content: string }[] } | null> {
    const url = new URL('https://context7.com/api/v1/context')
    url.searchParams.set('libraryId', libraryId)
    url.searchParams.set('query', query)

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(15_000)
    })

    if (!response.ok) {
      throw new Error(`Context7 fetch failed: ${response.status} ${response.statusText}`)
    }

    const data = (await response.json()) as {
      context?: { title?: string; content?: string }[]
    }

    if (!data.context || data.context.length === 0) return null

    return {
      snippets: data.context.map((c) => ({
        title: c.title ?? '',
        content: c.content ?? ''
      }))
    }
  }

  /** Fetch README content from npm registry. */
  private async fetchNpmReadme(
    packageName: string
  ): Promise<{ readme: string; version: string } | null> {
    const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000)
    })

    if (!response.ok) return null

    const data = (await response.json()) as {
      readme?: string
      'dist-tags'?: { latest?: string }
    }

    if (!data.readme || data.readme === 'ERROR: No README data found!') return null

    return {
      readme: data.readme,
      version: data['dist-tags']?.latest ?? ''
    }
  }
}

export const libraryDocService = new LibraryDocService()
