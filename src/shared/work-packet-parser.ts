/**
 * Extract a work packet from one entry of the TASKS phase artifact.
 *
 * Tolerant by design. The TASKS phase is authored by a model, and a packet that
 * is half-filled is still worth having: `allowedFiles` alone makes the write-set
 * gate real, `testFiles` alone makes the test-integrity gate real. Rejecting the
 * whole packet because one optional field came back malformed would silently
 * disable gates that had everything they needed.
 *
 * The one field with a hard contract is `acceptanceCriteria[].howVerified`: a
 * criterion with no stated check is an opinion, and both the lead reviewer and
 * the builder would be left guessing what "done" means.
 */

import { isSafeGateCommand } from './gate-command-types'
import type { AcceptanceCriterion, BlueprintWorkPacket, ContextExcerpt } from './blueprint-types'

const MAX_EXCERPTS = 12
const MAX_EXCERPT_CHARS = 8000
const MAX_LIST_ITEMS = 60
const MAX_CONVENTIONS = 8

function stringList(value: unknown, cap = MAX_LIST_ITEMS): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, cap)
  return out.length > 0 ? out : undefined
}

function parseAcceptanceCriteria(value: unknown): AcceptanceCriterion[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: AcceptanceCriterion[] = []
  for (const raw of value.slice(0, MAX_LIST_ITEMS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const obj = raw as Record<string, unknown>
    const text = typeof obj.text === 'string' ? obj.text.trim() : ''
    const howVerified =
      typeof obj.howVerified === 'string'
        ? obj.howVerified.trim()
        : typeof obj.how_verified === 'string'
          ? obj.how_verified.trim()
          : ''
    // HOW_VERIFIED is required by contract — an unverifiable criterion cannot
    // settle a disagreement between the builder and the reviewer.
    if (!text || !howVerified) continue
    out.push({ text, howVerified })
  }
  return out.length > 0 ? out : undefined
}

function parseExcerpts(value: unknown): ContextExcerpt[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: ContextExcerpt[] = []
  for (const raw of value.slice(0, MAX_EXCERPTS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const obj = raw as Record<string, unknown>
    const path = typeof obj.path === 'string' ? obj.path.trim() : ''
    const excerpt = typeof obj.excerpt === 'string' ? obj.excerpt : ''
    if (!path || !excerpt.trim()) continue
    out.push({
      path,
      excerpt: excerpt.slice(0, MAX_EXCERPT_CHARS),
      ...(typeof obj.note === 'string' && obj.note.trim() ? { note: obj.note.trim() } : {})
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Build a packet from a raw task object. Returns null when the task carries
 * nothing packet-shaped, so callers can tell "no packet" (gates degrade to
 * `unverifiable` / `no_packet`) from "an empty packet".
 */
export function extractWorkPacket(rawTask: unknown): BlueprintWorkPacket | null {
  if (!rawTask || typeof rawTask !== 'object' || Array.isArray(rawTask)) return null
  const obj = rawTask as Record<string, unknown>

  // Accept both a nested `packet` object and the fields inline on the task —
  // models produce both shapes, and the nested one is not worth a re-prompt.
  const source =
    obj.packet && typeof obj.packet === 'object' && !Array.isArray(obj.packet)
      ? (obj.packet as Record<string, unknown>)
      : obj

  const packet: BlueprintWorkPacket = {}

  const excerpts = parseExcerpts(source.contextExcerpts)
  if (excerpts) packet.contextExcerpts = excerpts

  const interfaces = stringList(source.interfaces)
  if (interfaces) packet.interfaces = interfaces

  const acs = parseAcceptanceCriteria(source.acceptanceCriteria)
  if (acs) packet.acceptanceCriteria = acs

  // `files` is the pre-packet field name for the write-set; treat it as the
  // fallback so blueprints authored before packets still gate on something.
  const allowed = stringList(source.allowedFiles) ?? stringList(obj.files)
  if (allowed) packet.allowedFiles = allowed

  const forbidden = stringList(source.forbiddenFiles)
  if (forbidden) packet.forbiddenFiles = forbidden

  const testFiles = stringList(source.testFiles)
  if (testFiles) packet.testFiles = testFiles

  const conventions = stringList(source.conventions, MAX_CONVENTIONS)
  if (conventions) packet.conventions = conventions

  // `testCommand` is executed by the gate runner with the user's shell. An
  // LLM-authored string with shell metacharacters is a code-execution path, so
  // unsafe values are dropped HERE, at the boundary — downstream code can then
  // treat a present `testCommand` as pre-vetted. The gate service re-checks as
  // defence-in-depth for packets that bypassed this parser.
  const testCommand =
    typeof source.testCommand === 'string' && isSafeGateCommand(source.testCommand)
      ? source.testCommand.trim()
      : undefined
  if (testCommand) packet.testCommand = testCommand

  return Object.keys(packet).length > 0 ? packet : null
}
