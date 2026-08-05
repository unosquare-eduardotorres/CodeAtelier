/**
 * Planner — turns a workspace into the complete list of work items, up front.
 *
 * This is the change that makes progress honest. The old pipeline interleaved
 * discovery and extraction, so the total was unknowable until a phase finished
 * and the bar could only move in phase-sized jumps. Planning first costs a few
 * hundred `statSync` calls and zero LLM calls, and in exchange every later
 * number the UI shows is real.
 *
 * Planning deliberately does NOT read file contents. The doc-state hash gate is
 * applied by the executor, which marks unchanged files `skipped` in
 * milliseconds — so they still appear in the per-file list as "unchanged"
 * rather than silently vanishing from the total.
 */

import { statSync } from 'node:fs'
import { relative, basename } from 'node:path'
import log from 'electron-log'
import type { BootstrapMode, BootstrapScope } from '../../../shared/types'
import type { PlannedItem } from '../../db/repositories/memory-bootstrap.repository'
import { codeGraphService } from '../code-graph.service'
import { collectInstructionRefs } from '../instruction-sources.service'
import {
  DOC_PRIORITY_DOCS_DIR,
  DOC_PRIORITY_INSTRUCTION,
  DOC_PRIORITY_SCATTERED,
  DOC_PRIORITY_TOP,
  DOC_DIRS,
  HIGH_VALUE_DOC_RE,
  MAX_ARCHITECTURE_FILES,
  MIN_DOC_CHARS,
  MIN_INSTRUCTION_CHARS,
  PHASE_BASE_PRIORITY,
  SKIP_DOC_NAMES
} from './constants'
import { discoverDocs, getChangedFilesSinceCommit } from './discovery'

const planLog = log.scope('memory-bootstrap:planner')

export interface PlanContext {
  workspaceId: string
  workspacePath: string
  mode: BootstrapMode
  scope: BootstrapScope
  hasIndex: boolean
  lastCommit: string | null
  headSha: string | null
}

export interface PlanResult {
  items: PlannedItem[]
  /** Files discovered but dropped before enqueuing, with the reason. */
  prefiltered: { tooSmall: number; generated: number; duplicate: number }
}

/** Rank a document so the highest-signal files drain first. */
function docPriority(workspacePath: string, absPath: string): number {
  const name = basename(absPath)
  if (HIGH_VALUE_DOC_RE.test(name)) return DOC_PRIORITY_TOP

  const rel = relative(workspacePath, absPath)
  const firstSegment = rel.split(/[\\/]/)[0]?.toLowerCase() ?? ''
  if (DOC_DIRS.includes(firstSegment)) return DOC_PRIORITY_DOCS_DIR

  return DOC_PRIORITY_SCATTERED
}

/**
 * Build the full item queue for a run.
 *
 * Phases map to items as follows:
 *   stack      → one `manifests` item
 *   docs       → one `doc` item per surviving file
 *   architecture → one `arch-file` item per PageRank-central file
 *   history    → `hotspots`, `cochange`, `commits`
 *   structure  → one `cycles` item        (Feed Brain only)
 *   agent-exploration → one `agent` item  (Deep Scan only)
 *
 * `preflight` and `finalize` are not items: they bracket the drain rather than
 * being drained.
 */
export async function planRun(ctx: PlanContext): Promise<PlanResult> {
  const items: PlannedItem[] = []
  const prefiltered = { tooSmall: 0, generated: 0, duplicate: 0 }

  // ── Stack ──────────────────────────────────────────────────────────────
  items.push({
    phase: 'stack',
    kind: 'manifests',
    sourceRef: 'project-manifests',
    priority: PHASE_BASE_PRIORITY.stack
  })

  // ── Instructions (agent rule files) ─────────────────────────────────
  // Enqueued before the general doc sweep so they can claim the paths they
  // share with it (root CLAUDE.md / AGENTS.md) at instruction priority.
  const instructionPaths = new Set<string>()
  for (const ref of collectInstructionRefs(ctx.workspacePath)) {
    // User-scope files live outside the workspace and are not project knowledge.
    if (ref.scope === 'user') continue
    instructionPaths.add(ref.path)

    let size = 0
    try {
      size = statSync(ref.path).size
    } catch {
      continue
    }
    if (size < MIN_INSTRUCTION_CHARS) {
      prefiltered.tooSmall++
      continue
    }

    items.push({
      phase: 'docs',
      kind: 'doc',
      sourceRef: relative(ctx.workspacePath, ref.path),
      priority: PHASE_BASE_PRIORITY.docs + DOC_PRIORITY_INSTRUCTION
    })
  }

  // ── Docs ───────────────────────────────────────────────────────────────
  const docFiles = discoverDocs(ctx.workspacePath)
  const seenFingerprints = new Set<string>()

  for (const absPath of docFiles) {
    if (instructionPaths.has(absPath)) continue
    const name = basename(absPath)

    if (SKIP_DOC_NAMES.some((re) => re.test(name))) {
      prefiltered.generated++
      continue
    }

    let size = 0
    try {
      size = statSync(absPath).size
    } catch {
      continue
    }

    if (size < MIN_DOC_CHARS) {
      prefiltered.tooSmall++
      continue
    }

    // Vendored/duplicated copies of the same doc (same name, same byte count)
    // produce identical facts and cost a full extraction each.
    const fingerprint = `${name}:${size}`
    if (seenFingerprints.has(fingerprint)) {
      prefiltered.duplicate++
      continue
    }
    seenFingerprints.add(fingerprint)

    items.push({
      phase: 'docs',
      kind: 'doc',
      sourceRef: relative(ctx.workspacePath, absPath),
      priority: PHASE_BASE_PRIORITY.docs + docPriority(ctx.workspacePath, absPath)
    })
  }

  // ── Architecture ───────────────────────────────────────────────────────
  if (ctx.hasIndex) {
    try {
      let topFiles = await codeGraphService.getTopRankedFiles(
        ctx.workspaceId,
        [],
        MAX_ARCHITECTURE_FILES
      )

      // On an incremental run, only re-read central files that actually moved.
      if (
        ctx.mode === 'incremental' &&
        ctx.lastCommit &&
        ctx.headSha &&
        ctx.lastCommit !== ctx.headSha
      ) {
        const changed = getChangedFilesSinceCommit(ctx.workspacePath, ctx.lastCommit)
        if (changed.size > 0) topFiles = topFiles.filter((f) => changed.has(f))
      }

      topFiles.forEach((relFile, idx) => {
        items.push({
          phase: 'architecture',
          kind: 'arch-file',
          sourceRef: relFile,
          // PageRank order is already meaningful — preserve it.
          priority: PHASE_BASE_PRIORITY.architecture + idx
        })
      })
    } catch (err) {
      planLog.warn('[planRun] Failed to rank architecture files:', err)
    }
  }

  // ── History ────────────────────────────────────────────────────────────
  if (ctx.hasIndex) {
    items.push({
      phase: 'history',
      kind: 'hotspots',
      sourceRef: 'git:hotspots',
      priority: PHASE_BASE_PRIORITY.history
    })
  }
  items.push({
    phase: 'history',
    kind: 'cochange',
    sourceRef: 'git:co-change',
    priority: PHASE_BASE_PRIORITY.history + 1
  })
  items.push({
    phase: 'history',
    kind: 'commits',
    sourceRef: 'git:recent-commits',
    priority: PHASE_BASE_PRIORITY.history + 2
  })

  // ── Structure / Agent exploration ──────────────────────────────────────
  if (ctx.mode === 'deep-scan') {
    items.push({
      phase: 'agent-exploration',
      kind: 'agent',
      sourceRef: 'agent:deep-scan',
      priority: PHASE_BASE_PRIORITY['agent-exploration']
    })
  } else {
    items.push({
      phase: 'structure',
      kind: 'cycles',
      sourceRef: 'graph:circular-deps',
      priority: PHASE_BASE_PRIORITY.structure
    })
  }

  planLog.info(
    `[planRun] Planned ${items.length} items ` +
      `(docs=${items.filter((i) => i.kind === 'doc').length}, ` +
      `instructions=${instructionPaths.size}, ` +
      `arch=${items.filter((i) => i.kind === 'arch-file').length}) — ` +
      `prefiltered ${prefiltered.tooSmall} tiny, ${prefiltered.generated} generated, ` +
      `${prefiltered.duplicate} duplicate`
  )

  return { items, prefiltered }
}

/**
 * Whether the doc-state hash gate applies to a given phase for this scope.
 *
 * This replaces the old blunt `force` flag, which deleted every stored hash in
 * the workspace. Scopes selectively ignore the gate instead of destroying it,
 * so a "re-ingest docs" never costs you the architecture phase's memory of
 * what it already read.
 */
export function shouldHonourHashGate(scope: BootstrapScope, phase: string): boolean {
  if (scope === 'full') return false
  if (scope === 'docs') return phase !== 'docs'
  if (scope === 'deep-scan') return phase !== 'architecture'
  return true // 'changed'
}
