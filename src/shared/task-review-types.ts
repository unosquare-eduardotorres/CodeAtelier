/**
 * Per-task review layers: peer review (Layer 3) and lead review (Layer 3.5).
 *
 * Both emit findings in the SAME schema as a task fix packet — file, location,
 * exact change, how it will be verified. That is not tidiness: a finding a
 * builder cannot mechanically act on is a finding that produces a second
 * failing attempt, and "improve the error handling here" is exactly that.
 */

/**
 * The peer reviewer's rubric. It is closed on purpose.
 *
 * A cheap model asked to "review this diff" reliably returns style opinions,
 * and style opinions from a weak model cost a build round-trip to satisfy and
 * teach the user to ignore the layer. Findings outside these four categories
 * are dropped by the parser rather than passed along.
 */
export type PeerRubricCategory =
  /** An acceptance criterion the diff does not satisfy. */
  | 'ac-coverage'
  /** The diff ignores something the work packet specified. */
  | 'packet-compliance'
  /** TODO / debug logging / commented-out code left behind. */
  | 'stub-residue'
  /** Files changed that the packet's write-set does not cover. */
  | 'write-set'

export const PEER_RUBRIC_CATEGORIES: readonly PeerRubricCategory[] = [
  'ac-coverage',
  'packet-compliance',
  'stub-residue',
  'write-set'
] as const

/**
 * The lead reviewer's rubric extends the peer's with the two failure modes the
 * gates structurally cannot see: code that passes the tests while diverging
 * from the spec, and code written to satisfy the test rather than the intent.
 */
export type LeadRubricCategory =
  | PeerRubricCategory
  /** Passes its tests but diverges from the spec, plan or ACs. */
  | 'spec-drift'
  /** Satisfies the letter of a test while missing what it was checking. */
  | 'test-gaming'
  | 'correctness'

export const LEAD_RUBRIC_CATEGORIES: readonly LeadRubricCategory[] = [
  ...PEER_RUBRIC_CATEGORIES,
  'spec-drift',
  'test-gaming',
  'correctness'
] as const

export interface ReviewFinding {
  category: LeadRubricCategory
  /** Repo-relative path the change applies to. */
  file: string
  /** Line or symbol name. Optional — some findings are file-level. */
  location?: string
  /** What is wrong, in one sentence. */
  issue: string
  /** The exact change to make. Mechanical: a builder must be able to act on it. */
  requiredChange: string
  /** How the fix will be checked. */
  howVerified?: string
}

export type LeadReviewVerdict = 'approved' | 'changes-required'

export interface PeerReviewResult {
  findings: ReviewFinding[]
  /** Findings the parser dropped, with the reason. Surfaced, never silent. */
  rejected: { raw: unknown; reason: string }[]
}

export interface LeadReviewResult {
  verdict: LeadReviewVerdict
  findings: ReviewFinding[]
  rejected: { raw: unknown; reason: string }[]
}

/** Review layer caps. Every loop in this stack is bounded by construction. */
export const PEER_REVIEW_MAX_ROUNDS = 1
export const LEAD_REVIEW_MAX_CYCLES = 2
/** A review that returns more findings than this is not a review, it is a rewrite. */
export const MAX_REVIEW_FINDINGS = 20
