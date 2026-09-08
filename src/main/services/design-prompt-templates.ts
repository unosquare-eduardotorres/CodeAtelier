/**
 * Design prompt assembly — the Impeccable knowledge layer, budgeted.
 *
 * A design run reuses the audit machinery end to end: same session service,
 * same ` ```audit-finding ` / ` ```audit-score ` output contract, same parser
 * (`parseAuditResponse`). The ONLY thing that differs is the system prompt, and
 * this module builds it.
 *
 * ── Why sections are stripped, not merely truncated ──────────────────────────
 * Impeccable's playbooks are written for Impeccable's own runtime. Roughly half
 * of `critique.md` and a third of `audit.md` instruct the agent to run the
 * `scripts/impeccable` launcher, generate a markdown report in Impeccable's
 * format, persist a snapshot, and ask the user follow-up questions.
 *
 * All four of those actively conflict with how we run a design pass: read-only,
 * single-shot, no file writes, and findings emitted as structured blocks that
 * our parser consumes. Feeding those sections to the agent does not merely
 * waste budget — it invites it to write files and to emit Impeccable's report
 * format instead of ours. So the orchestration sections are removed by heading,
 * and only then is what remains truncated to fit.
 *
 * What survives is the part we actually want: the evaluation criteria
 * (`audit.md`'s five diagnostic dimensions) and the reference expertise
 * (`critique.md`'s cognitive-load, Nielsen-heuristics and persona material).
 *
 * ── Budget (measured against the real payload, engine 0.1.3) ─────────────────
 * Playbooks range from 3.5 KB (`bolder`) to 42.7 KB (`critique`); `SKILL.md` is
 * 11.7 KB. Only `audit` and `critique` ever execute, and `critique` is the
 * worst case by a wide margin, so the cap is enforced unconditionally rather
 * than trusted to be unnecessary.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DesignCommandId } from '../../shared/types'
import { readCommandMarkdown, readSkillMarkdown } from './impeccable-provision.service'

// ── Budgets ──────────────────────────────────────────────────────────────────

/** Hard ceiling on the whole Impeccable layer (shared framing + playbook). */
export const MAX_IMPECCABLE_LAYER_CHARS = 8_000

/** Slice of the ceiling reserved for the shared SKILL.md framing. */
export const MAX_SHARED_FRAMING_CHARS = 2_500

/** Per-file cap when injecting the workspace's own design context. */
export const MAX_CONTEXT_FILE_CHARS = 4_000

/**
 * Headings whose sections are dropped before budgeting.
 *
 * Matched case-insensitively against the heading TEXT (not the `#` markers), so
 * the same list works whether a playbook uses `##` or `###` as its top level.
 * A matched heading takes its entire subtree with it.
 *
 * Every entry is here because it would make the agent do something we do not
 * want, not because it is merely long.
 */
const DROPPED_SECTION_PATTERNS: readonly RegExp[] = [
  /^setup$/i, // runs the impeccable launcher; we drive our own session
  /^commands?$/i, // the command table; we select commands ourselves
  /^assessment orchestration$/i, // spawns Impeccable sub-agents
  // Assessment B tells the agent to exec `.claude/skills/impeccable/scripts/…`
  // (a path that does not exist in the user's workspace — our copy lives under
  // userData) and to drive a live browser. We run the detector ourselves and
  // inject its output via `detectorSummary`, so this section is both impossible
  // to follow and redundant. Dropping it also frees the budget for the
  // reference sections Assessment A explicitly links to.
  /^assessment b\b/i,
  /^generate .*report$/i, // Impeccable's report format vs our finding blocks
  /^deliver the report$/i,
  /^persist the snapshot$/i, // writes files; design runs are read-only
  /^ask the user$/i, // single-shot; there is nobody to answer mid-run
  /^recommended actions$/i // remediation is the blueprint's job, not the audit's
]

// ── Markdown sectioning ──────────────────────────────────────────────────────

interface MarkdownSection {
  /** Heading depth (number of `#`). 0 for the preamble before any heading. */
  depth: number
  /** Heading text with the `#` markers stripped. Empty for the preamble. */
  title: string
  /** Full text of the section including its heading line. */
  text: string
}

/**
 * Split markdown into top-level-ordered sections, honouring fenced code blocks.
 *
 * A `#` inside a ``` fence is content, not a heading — missing that would split
 * a playbook in the middle of a code sample.
 */
function splitSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split('\n')
  const sections: MarkdownSection[] = []
  let current: MarkdownSection = { depth: 0, title: '', text: '' }
  let buffer: string[] = []
  let inFence = false

  const flush = (): void => {
    current.text = buffer.join('\n')
    if (current.text.trim().length > 0 || current.title) sections.push(current)
    buffer = []
  }

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence

    const heading = inFence ? null : /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      current = { depth: heading[1].length, title: heading[2].trim(), text: '' }
    }
    buffer.push(line)
  }
  flush()

  return sections
}

/**
 * Remove sections whose heading matches `patterns`, along with everything
 * nested beneath them.
 *
 * Exported for tests: the subtree behaviour is the subtle part — dropping
 * `## Generate Report` must also drop the `### Audit Health Score` beneath it,
 * or the agent still sees Impeccable's scoring rubric.
 */
export function stripSections(
  markdown: string,
  patterns: readonly RegExp[] = DROPPED_SECTION_PATTERNS
): string {
  const sections = splitSections(markdown)
  const kept: string[] = []
  let dropDepth: number | null = null

  for (const section of sections) {
    // Leaving a dropped subtree: a heading at the same or shallower depth ends it.
    if (dropDepth !== null && section.depth > 0 && section.depth <= dropDepth) {
      dropDepth = null
    }
    if (dropDepth !== null) continue

    if (section.depth > 0 && patterns.some((p) => p.test(section.title))) {
      dropDepth = section.depth
      continue
    }
    kept.push(section.text)
  }

  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Truncate to `maxChars` on a section boundary, never mid-sentence.
 *
 * Appends an explicit note when content is dropped: an agent that knows its
 * guidance was trimmed behaves better than one silently handed a fragment.
 */
export function truncateToSections(markdown: string, maxChars: number): string {
  if (markdown.length <= maxChars) return markdown

  const note = '\n\n_(Guidance truncated to fit the prompt budget.)_'
  const budget = Math.max(0, maxChars - note.length)
  const sections = splitSections(markdown)

  const kept: string[] = []
  let used = 0
  for (const section of sections) {
    const cost = section.text.length + 1
    if (used + cost > budget) break
    kept.push(section.text)
    used += cost
  }

  // A single section larger than the whole budget still has to yield something.
  if (kept.length === 0) return markdown.slice(0, budget).trimEnd() + note

  return kept.join('\n').trim() + note
}

/**
 * Assemble the Impeccable layer from raw markdown.
 *
 * Pure — takes the markdown rather than reading it — so the budget invariant
 * can be tested without a provisioned skill payload on disk.
 */
export function assembleImpeccableLayer(
  commandId: string,
  skillMarkdown: string | null,
  commandMarkdown: string | null
): string {
  const parts: string[] = []

  if (skillMarkdown) {
    // Drop YAML frontmatter — it is metadata for Impeccable's own loader.
    const withoutFrontmatter = skillMarkdown.replace(/^---\n[\s\S]*?\n---\n/, '')
    const framing = truncateToSections(stripSections(withoutFrontmatter), MAX_SHARED_FRAMING_CHARS)
    if (framing.trim()) {
      parts.push(`### Design philosophy\n\n${framing.trim()}`)
    }
  }

  if (commandMarkdown) {
    const used = parts.join('\n\n').length
    const remaining = Math.max(0, MAX_IMPECCABLE_LAYER_CHARS - used - 200)
    const playbook = truncateToSections(stripSections(commandMarkdown), remaining)
    if (playbook.trim()) {
      parts.push(`### \`${commandId}\` playbook\n\n${playbook.trim()}`)
    }
  }

  if (parts.length === 0) return ''

  const layer = parts.join('\n\n')
  // Belt and braces: the per-part budgets should already guarantee this, but the
  // cap is a promise to the caller, so it is enforced at the boundary too.
  return layer.length > MAX_IMPECCABLE_LAYER_CHARS
    ? truncateToSections(layer, MAX_IMPECCABLE_LAYER_CHARS)
    : layer
}

/**
 * Read and assemble the Impeccable layer for one command.
 *
 * Returns `''` when the skill payload is not provisioned — a design run without
 * the layer is degraded but perfectly valid, so this never throws.
 */
export function buildImpeccableLayer(commandId: DesignCommandId): string {
  try {
    return assembleImpeccableLayer(
      commandId,
      readSkillMarkdown()?.content ?? null,
      readCommandMarkdown(commandId)?.content ?? null
    )
  } catch {
    return ''
  }
}

// ── Workspace design context ─────────────────────────────────────────────────

/**
 * Where Impeccable looks for its context files, in order. Replicated so we read
 * the same files the user's own `impeccable` runs would.
 */
const CONTEXT_SEARCH_DIRS: readonly string[] = ['.', '.agents/context', 'docs']

export interface DesignContextFiles {
  productMd?: string
  designMd?: string
}

/**
 * Read PRODUCT.md / DESIGN.md if the workspace has them, first match wins.
 *
 * Deliberately minimal: P5.1 owns the richer `DESIGN_CONTEXT_STATUS` (presence,
 * monorepo fallback, staleness). This is only the content the prompt needs, so
 * the two must not be conflated when P5 lands.
 */
export function readDesignContextFiles(workspacePath: string): DesignContextFiles {
  const readFirst = (filename: string): string | undefined => {
    for (const dir of CONTEXT_SEARCH_DIRS) {
      try {
        const content = readFileSync(join(workspacePath, dir, filename), 'utf-8').trim()
        if (content) {
          return content.length > MAX_CONTEXT_FILE_CHARS
            ? `${content.slice(0, MAX_CONTEXT_FILE_CHARS)}\n\n_(truncated)_`
            : content
        }
      } catch {
        // Missing or unreadable at this location — try the next one.
      }
    }
    return undefined
  }

  return { productMd: readFirst('PRODUCT.md'), designMd: readFirst('DESIGN.md') }
}

// ── Per-command evaluation criteria ──────────────────────────────────────────

/**
 * Scoring dimensions per executable command, taken from the playbooks'
 * own structure (`audit.md`'s five-part Diagnostic Scan; `critique.md`'s
 * heuristics / persona / specificity assessments).
 *
 * These drive the prompt's scoring criteria the same way `AUDIT_TRACKS`
 * `scoringFocus` does for Workspace Health.
 */
export const DESIGN_SCORING_FOCUS: Readonly<Record<string, readonly string[]>> = {
  audit: [
    'Accessibility — WCAG contrast, focus states, semantics, keyboard paths, labels',
    'Performance — render cost, image weight, animation expense, bundle impact',
    'Theming — token usage, hardcoded values, dark/light parity, consistency',
    'Responsive design — breakpoints, overflow, touch targets, small-viewport behaviour',
    'Implementation integrity — dead styles, unreachable states, stubbed or faked UI'
  ],
  critique: [
    'Visual hierarchy — what the eye reaches first, and whether that is correct',
    'Information architecture — grouping, labelling, and navigational clarity',
    'Cognitive load — extraneous load, working-memory demands, decision cost',
    'Design specificity — whether this looks generic or AI-made versus intentional',
    'Emotional resonance — tone, personality, and whether it earns trust'
  ]
}

/** Fallback criteria for a command with no curated dimension list. */
const GENERIC_SCORING_FOCUS: readonly string[] = [
  'Craft and consistency of the interface',
  'Clarity of hierarchy and structure',
  'Fitness for the stated goal'
]

export function getDesignScoringFocus(commandId: DesignCommandId): readonly string[] {
  return DESIGN_SCORING_FOCUS[commandId] ?? GENERIC_SCORING_FOCUS
}

// ── Prompt renderer ──────────────────────────────────────────────────────────

/** Round context for multi-round design sessions. Mirrors the audit shape. */
export interface DesignRoundContext {
  roundNumber: number
  fileBatch: string[]
  previousFindingsSummary: string
  remainingFileCount: number
}

export interface DesignPromptParams {
  commandId: DesignCommandId
  commandName: string
  commandDescription: string
  workspaceName: string
  detectedTechs: string[]
  /** The user's free-text goal. May be empty. */
  brief: string
  scopeMode: 'project' | 'paths'
  scopePaths: string[]
  /** Non-executing cards the user picked — routing intent for the findings. */
  refineCommands: string[]
  /** Pre-assembled Impeccable layer. Empty when unprovisioned. */
  impeccableLayer: string
  productMd?: string
  designMd?: string
  /** Deterministic detector output, fed back from round 2 onward. */
  detectorSummary?: string
  roundContext?: DesignRoundContext
}

/**
 * Render the system prompt for one design command.
 *
 * The output contract is byte-identical to the audit template's on purpose:
 * `parseAuditResponse` is reused unchanged, so any drift here would silently
 * produce zero findings rather than a parse error.
 */
export function renderDesignPrompt(params: DesignPromptParams): string {
  const stackSummary =
    params.detectedTechs.length > 0
      ? params.detectedTechs.join(', ')
      : 'Not detected — inspect project files to determine the stack'

  const scopeSummary =
    params.scopeMode === 'project' || params.scopePaths.length === 0
      ? 'The whole project.'
      : params.scopePaths.map((p) => `- \`${p}\``).join('\n')

  const scoringFocus = getDesignScoringFocus(params.commandId)
    .map((f, i) => `${i + 1}. ${f}`)
    .join('\n')

  const sections: string[] = []

  sections.push(
    `You are an award-winning design director performing a read-only **${params.commandName}** pass over a real codebase.\n\n` +
      `Respond ONLY in English. Inspect ONLY files within the workspace directory. ` +
      `Do NOT modify, create, or delete any file — this is an evaluation pass, not an implementation pass.`
  )

  sections.push(`## Focus\n${params.commandDescription}`)

  sections.push(`## Workspace\n- **Name**: ${params.workspaceName}\n- **Stack**: ${stackSummary}`)

  if (params.brief.trim()) {
    sections.push(
      `## What the user wants\n${params.brief.trim()}\n\n` +
        `Weight your findings toward this goal. It is the single most important input you have.`
    )
  }

  sections.push(`## Scope\n${scopeSummary}`)

  if (params.refineCommands.length > 0) {
    sections.push(
      `## Intended follow-up work\n` +
        `The user also selected these Impeccable refinement directions: ` +
        `${params.refineCommands.map((c) => `\`${c}\``).join(', ')}.\n` +
        `They are NOT part of this pass, but findings that feed them are especially valuable.`
    )
  }

  if (params.productMd || params.designMd) {
    const ctx: string[] = []
    if (params.productMd) ctx.push(`#### PRODUCT.md\n${params.productMd}`)
    if (params.designMd) ctx.push(`#### DESIGN.md\n${params.designMd}`)
    sections.push(
      `## Project design context\n` +
        `Authoritative. Judge the interface against THIS, not against generic taste.\n\n` +
        ctx.join('\n\n')
    )
  } else {
    sections.push(
      `## Project design context\n` +
        `No PRODUCT.md or DESIGN.md was found. Infer intent from the code and say so ` +
        `in your summary — do not invent a design system that does not exist.`
    )
  }

  if (params.impeccableLayer.trim()) {
    sections.push(`## Impeccable guidance\n\n${params.impeccableLayer.trim()}`)
  }

  if (params.detectorSummary?.trim()) {
    sections.push(
      `## Deterministic detector results\n` +
        `A static detector already scanned this scope and found the issues below. ` +
        `Do NOT re-report them — they are already recorded. Use them as evidence of ` +
        `where quality is slipping, and look for the deeper problems they hint at.\n\n` +
        params.detectorSummary.trim()
    )
  }

  sections.push(
    `## Scoring Criteria\nEvaluate EVERY criterion below. Each must produce at least one audit-finding block:\n${scoringFocus}`
  )

  sections.push(
    `## Instructions\n` +
      `Narrate before each tool call. Read the actual files — never judge from filenames. ` +
      `Be concrete: cite file paths and line numbers. Limit to 10–15 findings.`
  )

  sections.push(
    `## Finding Output (MANDATORY)\n` +
      'Emit findings as ```audit-finding JSON blocks in your response text (NOT tool calls):\n' +
      `{"severity": "high|medium|low|info|critical", "title": "...", "description": "...", "filePath": "...", "recommendation": "..."}\n\n` +
      `Passing criteria → "info" severity. Zero findings = unacceptable. Emit AS YOU GO.`
  )

  sections.push(
    `## Final Score (MANDATORY)\n` +
      'End with exactly one ```audit-score block: {"score": N, "summary": "..."}\n' +
      `Guide: 0-20 critical, 21-40 significant, 41-60 moderate, 61-80 good, 81-100 excellent.\n` +
      `Read files before scoring. Always emit audit-score, even if out of tool calls.`
  )

  sections.push(`## Tool Budget\n~15-20 calls. 8-12 investigating, emit findings as you go.`)

  let prompt = sections.join('\n\n')

  if (params.roundContext) {
    const rc = params.roundContext
    prompt +=
      `\n\n## Round ${rc.roundNumber} — Scoped Inspection\n\n` +
      `Focus on these ${rc.fileBatch.length} files:\n` +
      rc.fileBatch.map((f) => `- \`${f}\``).join('\n') +
      `\n\nPrevious rounds found ${rc.previousFindingsSummary}.\n` +
      `Do NOT repeat those findings. Focus on NEW issues in the files listed above.\n` +
      `${rc.remainingFileCount} files remain after this round.`
  }

  return prompt
}

/**
 * Condense detector findings into the round-2+ feedback block.
 *
 * Capped hard: the detector can legitimately return dozens of hits and this
 * text is re-sent on every subsequent round.
 */
export function summarizeDetectorFindings(
  findings: readonly { title: string; filePath?: string }[],
  limit = 15
): string {
  if (findings.length === 0) return ''
  const shown = findings.slice(0, limit)
  const lines = shown.map((f) => `- ${f.title}${f.filePath ? ` (${f.filePath})` : ''}`)
  if (findings.length > shown.length) {
    lines.push(`- …and ${findings.length - shown.length} more.`)
  }
  return lines.join('\n')
}
