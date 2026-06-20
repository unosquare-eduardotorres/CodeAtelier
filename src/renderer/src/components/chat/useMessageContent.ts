import { useMemo } from 'react'
import type {
  GrillProposedTask,
  GrillQuestion,
  BuildSummary,
  StructuredPlan
} from '../../../../shared/types'

export interface MessageContentData {
  imageAttachments: string[]
  fileAttachments: string[]
  isGrillActivation: boolean
  ideaToRefineMatch: RegExpMatchArray | null
  displayContent: string
  planContent: string | null
  structuredPlan: StructuredPlan | null
  beforePlan: string | null
  afterPlan: string | null
  grillSummary: string | null
  grillProposedTasks: GrillProposedTask[]
  beforeGrill: string | null
  afterGrill: string | null
  grillQuestionMatch: RegExpMatchArray | null
  grillQuestions: GrillQuestion[]
  beforeGrillQuestion: string | null
  afterGrillQuestion: string | null
  grillEvalData: {
    score: number
    scoreLabel: string
    feedback: string
    questions: GrillQuestion[]
  } | null
  beforeGrillEval: string | null
  afterGrillEval: string | null
  buildSummaryData: BuildSummary | null
  beforeBuildSummary: string | null
  afterBuildSummary: string | null
}

// ─── Pure Helpers ─────────────────────────────────────────

interface ExtractedBlock<T> {
  data: T | null
  rawContent: string | null
  before: string | null
  after: string | null
  match: RegExpMatchArray | null
}

/**
 * Generic regex-match → JSON.parse → transform pattern.
 * Replaces the repeated block-parsing logic for plan, grill-summary,
 * grill-question, grill-evaluation, and build-summary blocks.
 */
function extractStructuredBlock<T>(
  content: string,
  pattern: RegExp,
  transform: (parsed: unknown) => T | null,
  opts?: { skipForUser?: boolean; isUser?: boolean }
): ExtractedBlock<T> {
  const empty: ExtractedBlock<T> = { data: null, rawContent: null, before: null, after: null, match: null }

  if (opts?.skipForUser && opts.isUser) return empty

  const match = content.match(pattern)
  if (!match) return empty

  const rawContent = match[1]
  let data: T | null = null
  try {
    data = transform(JSON.parse(rawContent.trim()))
  } catch {
    /* noop — raw content or malformed JSON */
  }

  return {
    data,
    rawContent,
    before: content.substring(0, match.index!),
    after: content.substring(match.index! + match[0].length),
    match
  }
}

/** Parse attachment JSON into image and file lists. */
function parseAttachments(json: string | undefined): {
  imageAttachments: string[]
  fileAttachments: string[]
} {
  let paths: string[] = []
  try {
    const parsed = JSON.parse(json || '[]')
    paths = Array.isArray(parsed) ? parsed : []
  } catch {
    /* noop */
  }
  const imagePattern = /\.(png|jpg|jpeg|gif|webp)$/i
  return {
    imageAttachments: paths.filter((p) => imagePattern.test(p)),
    fileAttachments: paths.filter((p) => !imagePattern.test(p))
  }
}

/** Detect grill activation markers and clean display content. */
function processGrillActivation(
  content: string,
  isUser: boolean
): { isGrillActivation: boolean; ideaToRefineMatch: RegExpMatchArray | null; displayContent: string } {
  const isGrillActivation = isUser && content.startsWith('[GRILL MODE ACTIVATED]')
  const ideaToRefineMatch = isGrillActivation
    ? content.match(/## Idea to Refine\n\*\*(.+?)\*\*/)
    : null

  let displayContent = content
  if (isGrillActivation) {
    displayContent = content.replace(/^\[GRILL MODE ACTIVATED\]\s*/, '')
    if (ideaToRefineMatch) {
      displayContent = displayContent.replace(/## Idea to Refine\n\*\*.+?\*\*\n*/, '')
    }
    displayContent = displayContent.trim()
  }

  return { isGrillActivation, ideaToRefineMatch, displayContent }
}

// ─── Block Transforms ─────────────────────────────────────

interface GrillSummaryBlock {
  summary: string | null
  proposedTasks: GrillProposedTask[]
}

function toStructuredPlan(parsed: unknown): StructuredPlan | null {
  const p = parsed as Record<string, unknown>
  return p && typeof p === 'object' && typeof p.title === 'string'
    ? (parsed as StructuredPlan)
    : null
}

function toGrillSummary(parsed: unknown): GrillSummaryBlock {
  const p = parsed as Record<string, unknown>
  return {
    summary: (p.summary as string) || null,
    proposedTasks: Array.isArray(p.proposedTasks) ? (p.proposedTasks as GrillProposedTask[]) : []
  }
}

function toGrillQuestions(parsed: unknown): GrillQuestion[] | null {
  const p = parsed as Record<string, unknown>
  return p.questions && Array.isArray(p.questions) ? (p.questions as GrillQuestion[]) : null
}

interface GrillEvalBlock {
  score: number
  scoreLabel: string
  feedback: string
  questions: GrillQuestion[]
}

function toGrillEval(parsed: unknown): GrillEvalBlock | null {
  const p = parsed as Record<string, unknown>
  if (typeof p.score === 'number' && Array.isArray(p.questions)) {
    return {
      score: p.score,
      scoreLabel: (p.scoreLabel as string) ?? '',
      feedback: (p.feedback as string) ?? '',
      questions: p.questions as GrillQuestion[]
    }
  }
  return null
}

function toBuildSummary(parsed: unknown): BuildSummary {
  return parsed as BuildSummary
}

// ─── Hook ─────────────────────────────────────────────────

/**
 * Parses message content to detect and extract structured blocks
 * (plans, grill sessions, handoffs, build summaries, etc.)
 *
 * Extracted from MessageBubbleInner to reduce component complexity.
 */
export function useMessageContent(
  contentMd: string,
  attachmentsJson: string | undefined,
  isUser: boolean
): MessageContentData {
  return useMemo(() => {
    const { imageAttachments, fileAttachments } = parseAttachments(attachmentsJson)
    const { isGrillActivation, ideaToRefineMatch, displayContent } =
      processGrillActivation(contentMd, isUser)

    const plan = extractStructuredBlock(contentMd, /`{3,4}plan\n([\s\S]*?)`{3,4}/, toStructuredPlan)
    const grill = extractStructuredBlock(contentMd, /```grill-summary\n([\s\S]*?)```/, toGrillSummary, { skipForUser: true, isUser })
    const grillQ = extractStructuredBlock(contentMd, /```grill-question\n([\s\S]*?)```/, toGrillQuestions, { skipForUser: true, isUser })
    const grillE = extractStructuredBlock(contentMd, /```grill-evaluation\n([\s\S]*?)```/, toGrillEval, { skipForUser: true, isUser })
    const buildS = extractStructuredBlock(contentMd, /```build-summary\n([\s\S]*?)```/, toBuildSummary, { skipForUser: true, isUser })

    return {
      imageAttachments,
      fileAttachments,
      isGrillActivation,
      ideaToRefineMatch,
      displayContent,
      planContent: plan.rawContent,
      structuredPlan: plan.data,
      beforePlan: plan.before,
      afterPlan: plan.after,
      grillSummary: grill.data?.summary ?? null,
      grillProposedTasks: grill.data?.proposedTasks ?? [],
      beforeGrill: grill.before,
      afterGrill: grill.after,
      grillQuestionMatch: grillQ.match,
      grillQuestions: grillQ.data ?? [],
      beforeGrillQuestion: grillQ.before,
      afterGrillQuestion: grillQ.after,
      grillEvalData: grillE.data,
      beforeGrillEval: grillE.before,
      afterGrillEval: grillE.after,
      buildSummaryData: buildS.data,
      beforeBuildSummary: buildS.before,
      afterBuildSummary: buildS.after
    }
  }, [contentMd, attachmentsJson, isUser])
}
