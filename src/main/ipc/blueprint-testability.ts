/**
 * Testability Ledger export — the logic behind `blueprint:exportTestability`,
 * lifted out of the IPC handler so it can be exercised without Electron.
 *
 * The handler itself cannot be tested end to end: the E2E fixture attaches over
 * raw CDP to the RENDERER only (`_electron.launch()` is incompatible with
 * Electron 41+), so there is no main-process handle with which to stub
 * `dialog.showSaveDialog`. Rather than add a test-only branch to production IPC,
 * the decisions worth covering — cancel vs. confirm, a missing REVIEW preflight
 * artifact, filename derivation — live here behind injected IO.
 *
 * The same `buildTestabilityInput` feeds `blueprint:testabilityEntries`, which
 * is what makes the follow-up dialog show exactly the rows the Markdown export
 * contains rather than a shorter, renderer-visible subset.
 */

import { resolveVerificationDepth, type BlueprintTask } from '../../shared/blueprint-types'
import {
  buildTestabilityReportMarkdown,
  collectTestabilityEntries,
  testabilityEntryKey,
  type TestabilityEntry,
  type TestabilityReportInput
} from '../../shared/testability-report'

export { testabilityEntryKey }
import type { PreflightCheck } from '../../shared/preflight-types'
import type { UnverifiedItem } from '../../shared/gate-types'

/** The subset of a blueprint row the ledger actually reads. */
export interface TestabilitySubject {
  title: string
  status: string
  shortName?: string | null
  settingsJson?: Record<string, unknown> | null
  unverifiedJson?: UnverifiedItem[] | null
}

export interface TestabilitySources {
  blueprint: TestabilitySubject
  tasks: readonly BlueprintTask[]
  /**
   * Reads the REVIEW-phase `preflight` artifact. Allowed to throw: a blueprint
   * that never reached REVIEW has no artifact, and the task/gate evidence is
   * independently useful, so failure here degrades the report instead of
   * sinking it.
   */
  readPreflight: () => readonly PreflightCheck[] | undefined
  /** Injectable for deterministic tests. */
  generatedAt?: string
  /** Called when `readPreflight` throws, so the caller can log it. */
  onPreflightError?: (err: unknown) => void
}

/** Join the sources into the shape both the Markdown and the entry list take. */
export function buildTestabilityInput(sources: TestabilitySources): TestabilityReportInput {
  let preflight: readonly PreflightCheck[] | undefined
  try {
    const checks = sources.readPreflight()
    if (Array.isArray(checks)) preflight = checks
  } catch (err) {
    sources.onPreflightError?.(err)
  }

  return {
    blueprint: {
      title: sources.blueprint.title,
      status: sources.blueprint.status,
      verificationDepth: resolveVerificationDepth(sources.blueprint.settingsJson ?? undefined),
      unverifiedJson: sources.blueprint.unverifiedJson
    },
    tasks: sources.tasks,
    preflight,
    generatedAt: sources.generatedAt
  }
}

/** The entry list, identical to the rows the Markdown renderer walks. */
export function collectTestability(sources: TestabilitySources): TestabilityEntry[] {
  return collectTestabilityEntries(buildTestabilityInput(sources))
}

/** Blueprint settings key holding entryKey → created idea id. */
export const TESTABILITY_IDEA_IDS_KEY = 'testabilityIdeaIds'

/**
 * Read the entryKey → ideaId map off `blueprints.settingsJson`. Anything that is
 * not a string-to-string pair is dropped rather than trusted — the map is only
 * used to grey out already-converted rows, so a corrupt entry must degrade to
 * "offer it again", never to a crash.
 */
export function readTestabilityIdeaRefs(
  settingsJson: Record<string, unknown> | null | undefined
): Record<string, string> {
  const raw = settingsJson?.[TESTABILITY_IDEA_IDS_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value) out[key] = value
  }
  return out
}

/** `testability-<slug>-<yyyy-mm-dd>.md`, slug derived from shortName or title. */
export function deriveTestabilityFilename(
  blueprint: Pick<TestabilitySubject, 'title' | 'shortName'>,
  now: Date
): string {
  const slug = (blueprint.shortName || blueprint.title || 'blueprint')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `testability-${slug || 'blueprint'}-${now.toISOString().slice(0, 10)}.md`
}

/**
 * Which selected rows should actually become ideas.
 *
 * Pure, and kept out of the IPC handler, because the dedupe is the whole point:
 * clicking “Create follow-up ideas” twice must not produce two ideas for the
 * same gap. The check runs against the ledger recomputed in main, never against
 * renderer-supplied bodies.
 */
export function selectTestabilityIdeas(
  entries: readonly TestabilityEntry[],
  selectedKeys: ReadonlySet<string>,
  alreadyLinked: Readonly<Record<string, string>>
): Array<{ entryKey: string; entry: TestabilityEntry }> {
  const out: Array<{ entryKey: string; entry: TestabilityEntry }> = []
  for (const entry of entries) {
    const entryKey = testabilityEntryKey(entry)
    if (!selectedKeys.has(entryKey) || alreadyLinked[entryKey]) continue
    out.push({ entryKey, entry })
  }
  return out
}

/**
 * Turn one ledger row into an idea draft. Ideas (not bugs) on purpose: unproven
 * scope is not a defect report, and ideas already feed the grill → blueprint
 * pipeline, so each row becomes schedulable work rather than a note.
 */
export function testabilityIdeaDraft(
  entry: TestabilityEntry,
  blueprintTitle: string
): { title: string; description: string } {
  const lines = [
    `Carried over from the Testability Ledger of blueprint “${blueprintTitle}”.`,
    '',
    `**What is unproven:** ${entry.title}`,
    `**Why:** ${entry.detail}`
  ]
  if (entry.suggestedAction) lines.push(`**Suggested next step:** ${entry.suggestedAction}`)
  lines.push('', `_Ledger reference: ${entry.ref} (${entry.reason})_`)

  return {
    title: `[${entry.ref}] ${entry.title}`.slice(0, 200),
    description: lines.join('\n')
  }
}

export interface SaveDialogResult {
  canceled: boolean
  filePath?: string
}

export interface TestabilityExportIo {
  showSaveDialog: (defaultPath: string) => Promise<SaveDialogResult>
  writeFile: (filePath: string, contents: string) => Promise<void>
  now?: () => Date
}

/**
 * Render the ledger and offer to save it. Cancelling writes nothing —
 * `{ exported: false }` is the honest answer, not a silent success.
 */
export async function exportTestabilityLedger(
  sources: TestabilitySources,
  io: TestabilityExportIo
): Promise<{ exported: boolean; filePath?: string }> {
  const markdown = buildTestabilityReportMarkdown(buildTestabilityInput(sources))
  const defaultPath = deriveTestabilityFilename(sources.blueprint, io.now?.() ?? new Date())

  const { canceled, filePath } = await io.showSaveDialog(defaultPath)
  if (canceled || !filePath) return { exported: false }

  await io.writeFile(filePath, markdown)
  return { exported: true, filePath }
}
