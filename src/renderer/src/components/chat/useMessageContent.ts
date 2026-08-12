import { useMemo } from 'react'
import type {
  GrillProposedTask,
  GrillQuestion,
  BuildSummary,
  StructuredPlan
} from '../../../../shared/types'
import { findFencedBlock } from '../../../../shared/fenced-block'

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
  hasGrillQuestionBlock: boolean
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
  /** Truthy when a block was found — kept for call sites that only need presence. */
  found: boolean
}

/**
 * Generic locate → JSON.parse → transform pattern.
 * Replaces the repeated block-parsing logic for plan, grill-summary,
 * grill-question, grill-evaluation, and build-summary blocks.
 *
 * Block location goes through findFencedBlock so a fenced code sample inside a
 * JSON string value can't truncate the block — which used to leave the card
 * unparseable and leak the JSON tail into the chat bubble.
 */
function extractStructuredBlock<T>(
  content: string,
  lang: string,
  transform: (parsed: unknown) => T | null,
  opts?: { skipForUser?: boolean; isUser?: boolean }
): ExtractedBlock<T> {
  const empty: ExtractedBlock<T> = {
    data: null,
    rawContent: null,
    before: null,
    after: null,
    found: false
  }

  if (opts?.skipForUser && opts.isUser) return empty

  const block = findFencedBlock(content, lang)
  if (!block) return empty

  let data: T | null = null
  try {
    data = transform(JSON.parse(block.content.trim()))
  } catch {
    /* noop — raw content or malformed JSON */
  }

  return {
    data,
    rawContent: block.content,
    before: content.substring(0, block.start),
    after: content.substring(block.end),
    found: true
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
): {
  isGrillActivation: boolean
  ideaToRefineMatch: RegExpMatchArray | null
  displayContent: string
} {
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
    const { isGrillActivation, ideaToRefineMatch, displayContent } = processGrillActivation(
      contentMd,
      isUser
    )

    const plan = extractStructuredBlock(contentMd, 'plan', toStructuredPlan)
    const grill = extractStructuredBlock(contentMd, 'grill-summary', toGrillSummary, {
      skipForUser: true,
      isUser
    })
    const grillQ = extractStructuredBlock(contentMd, 'grill-question', toGrillQuestions, {
      skipForUser: true,
      isUser
    })
    const grillE = extractStructuredBlock(contentMd, 'grill-evaluation', toGrillEval, {
      skipForUser: true,
      isUser
    })
    const buildS = extractStructuredBlock(contentMd, 'build-summary', toBuildSummary, {
      skipForUser: true,
      isUser
    })

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
      hasGrillQuestionBlock: grillQ.found,
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
