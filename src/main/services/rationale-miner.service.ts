/**
 * Rationale mining — turns intent left in code comments into memory facts.
 *
 * `// WHY:` / `// HACK:` / `// GOTCHA:` comments and ADR/RFC citations record
 * *why* code looks the way it does. That's contested, decaying knowledge, so it
 * belongs in the Brain (where dedup, tiering, confirmation and contradiction
 * already exist) rather than in the code graph, which stores verifiable structure.
 *
 * A `// HACK:` that survives six months and gets re-confirmed becomes tier-2
 * knowledge for free; nothing here has to model that.
 *
 * Off by default — enable per workspace via the `captureRationales` setting.
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import type { MemoryFactCategory } from '../../shared/types'

export type RationaleMarker = 'WHY' | 'NOTE' | 'HACK' | 'GOTCHA' | 'ADR' | 'RFC'

export interface RationaleCandidate {
  marker: RationaleMarker
  line: number
  title: string
  content: string
  category: MemoryFactCategory
}

/** Per-file cap — a file with more than this is documentation, not rationale. */
export const MAX_RATIONALES_PER_FILE = 5
/** Per-indexing-run cap, mirroring the bootstrap capture caps. */
export const MAX_RATIONALES_PER_RUN = 50
/** Files larger than this are skipped — minified bundles, fixtures, generated code. */
const MAX_FILE_BYTES = 512 * 1024

/**
 * Comment markers, matched case-sensitively: lowercase "note:" appears in prose
 * constantly, the uppercase convention almost never does by accident.
 * Leading comment syntax covers //, #, --, /*, *, <!--, ;.
 */
const MARKER_RE = /(?:\/\/+|#+|--|\/\*+|\*|<!--|;+)\s*(WHY|NOTE|HACK|GOTCHA)\s*:\s*(.+)$/
/** ADR-12, RFC 7231, docs/adr/0004-foo.md */
const ADR_RE = /\b(ADR|RFC)[-\s]?(\d{1,5})\b/
const ADR_PATH_RE = /docs\/(?:adr|rfc)\/[\w./-]+/i

const CATEGORY_BY_MARKER: Record<RationaleMarker, MemoryFactCategory> = {
  WHY: 'decision',
  ADR: 'decision',
  RFC: 'decision',
  HACK: 'gotcha',
  GOTCHA: 'gotcha',
  NOTE: 'reference'
}

/** Strip trailing block-comment and HTML-comment terminators from a title. */
function cleanText(text: string): string {
  return text
    .replace(/\*\/\s*$/, '')
    .replace(/-->\s*$/, '')
    .trim()
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * Extract rationale candidates from a source file.
 * Pure — no I/O, no DB. The whole detection contract lives here.
 */
export function extractRationales(
  source: string,
  relPath: string,
  maxPerFile: number = MAX_RATIONALES_PER_FILE
): RationaleCandidate[] {
  const lines = source.split('\n')
  const found: RationaleCandidate[] = []
  const seenTitles = new Set<string>()

  for (let i = 0; i < lines.length && found.length < maxPerFile; i++) {
    const line = lines[i]

    let marker: RationaleMarker | null = null
    let text = ''

    const markerMatch = MARKER_RE.exec(line)
    if (markerMatch) {
      marker = markerMatch[1] as RationaleMarker
      text = cleanText(markerMatch[2])
    } else {
      // ADR/RFC citations only count inside comments — a bare `RFC 7231` in a
      // string literal or a URL is a value, not a decision record.
      const isComment = /^\s*(?:\/\/|#|--|\*|\/\*|<!--|;)/.test(line)
      if (isComment) {
        const adrMatch = ADR_RE.exec(line) ?? ADR_PATH_RE.exec(line)
        if (adrMatch) {
          marker = (adrMatch[1]?.toUpperCase() as RationaleMarker) ?? 'ADR'
          if (marker !== 'ADR' && marker !== 'RFC') marker = 'ADR'
          text = cleanText(line.replace(/^\s*(?:\/\/+|#+|--|\/\*+|\*|<!--|;+)\s*/, ''))
        }
      }
    }

    if (!marker || text.length < 8) continue

    // The line after the comment is what the rationale is *about* — without it
    // "HACK: works around the race" has no anchor.
    const next = lines[i + 1]?.trim() ?? ''
    const context = next.length > 0 && next.length < 200 ? next : ''

    const title = truncate(`${marker}: ${text}`, 100)
    const dedupKey = title.toLowerCase()
    if (seenTitles.has(dedupKey)) continue
    seenTitles.add(dedupKey)

    found.push({
      marker,
      line: i + 1,
      title,
      content: truncate(
        `${text}\n\nSource: ${relPath}:${i + 1}` + (context ? `\nApplies to: \`${context}\`` : ''),
        1200
      ),
      category: CATEGORY_BY_MARKER[marker]
    })
  }

  return found
}

class RationaleMinerService {
  /**
   * Mine the given files and write candidates to the Brain.
   * No-ops unless the workspace has `captureRationales` enabled.
   */
  async mineFiles(
    workspaceId: string,
    workspacePath: string,
    relPaths: string[]
  ): Promise<{ scanned: number; written: number }> {
    if (relPaths.length === 0) return { scanned: 0, written: 0 }

    // Imported lazily: the standalone code-graph MCP server loads
    // code-graph.service, and must never pull the memory engine (and its
    // embedding provider) into its process.
    const { workspaceRepository } = await import('../db/repositories')
    const settings = workspaceRepository.getSettings(workspaceId) as Record<string, unknown>
    // Default OFF — opt-in, so mining can't flood the Brain unprompted.
    if (settings.memoryCaptureRationales !== true) return { scanned: 0, written: 0 }

    const { memoryEngineService } = await import('./memory-engine.service')

    let scanned = 0
    let written = 0

    for (const relPath of relPaths) {
      if (written >= MAX_RATIONALES_PER_RUN) break
      const absPath = join(workspacePath, relPath)
      let source: string
      try {
        if (statSync(absPath).size > MAX_FILE_BYTES) continue
        source = readFileSync(absPath, 'utf-8')
      } catch {
        continue // deleted or unreadable since indexing
      }
      scanned++

      for (const candidate of extractRationales(source, relPath)) {
        if (written >= MAX_RATIONALES_PER_RUN) break
        try {
          const fact = await memoryEngineService.writeFact({
            workspaceId,
            category: candidate.category,
            title: candidate.title,
            content: candidate.content,
            tags: ['rationale', candidate.marker.toLowerCase()],
            scopePaths: [relPath],
            sourceType: 'tool',
            sourceRef: `rationale:${relPath}`,
            workspacePath
          })
          if (fact) written++
        } catch (error) {
          log.warn(
            `[RationaleMiner] writeFact failed for ${relPath}:${candidate.line}: ` +
              `${(error as Error).message}`
          )
        }
      }
    }

    if (written > 0) {
      log.info(`[RationaleMiner] ${written} rationale fact(s) from ${scanned} file(s)`)
    }
    return { scanned, written }
  }
}

export const rationaleMinerService = new RationaleMinerService()
