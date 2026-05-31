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
    // Parse attachments
    let parsedAttachments: string[] = []
    try {
      const parsed = JSON.parse(attachmentsJson || '[]')
      parsedAttachments = Array.isArray(parsed) ? parsed : []
    } catch {
      /* noop */
    }
    const imageAtts = parsedAttachments.filter((p) => /\.(png|jpg|jpeg|gif|webp)$/i.test(p))
    const fileAtts = parsedAttachments.filter((p) => !/\.(png|jpg|jpeg|gif|webp)$/i.test(p))

    // Grill activation detection
    const grillActivation = isUser && contentMd.startsWith('[GRILL MODE ACTIVATED]')
    const ideaMatch = grillActivation ? contentMd.match(/## Idea to Refine\n\*\*(.+?)\*\*/) : null

    // Clean display content for grill messages
    let dispContent = contentMd
    if (grillActivation) {
      dispContent = contentMd.replace(/^\[GRILL MODE ACTIVATED\]\s*/, '')
      if (ideaMatch) {
        dispContent = dispContent.replace(/## Idea to Refine\n\*\*.+?\*\*\n*/, '')
      }
      dispContent = dispContent.trim()
    }

    // Detect plan blocks
    const pMatch = !isUser ? contentMd.match(/`{3,4}plan\n([\s\S]*?)`{3,4}/) : null
    const pContent = pMatch ? pMatch[1] : null
    const bPlan = pMatch ? contentMd.substring(0, pMatch.index!) : null
    const aPlan = pMatch ? contentMd.substring(pMatch.index! + pMatch[0].length) : null

    // Try to parse planContent as structured plan for direct execution path
    let sPlan: StructuredPlan | null = null
    if (pContent) {
      try {
        const parsed = JSON.parse(pContent)
        if (parsed && typeof parsed === 'object' && typeof parsed.title === 'string') {
          sPlan = parsed as StructuredPlan
        }
      } catch {
        /* noop — raw markdown plan, will use fallback generalist path */
      }
    }

    // Detect grill-summary blocks
    const gMatch = !isUser ? contentMd.match(/```grill-summary\n([\s\S]*?)```/) : null
    let gSummary: string | null = null
    let gProposedTasks: GrillProposedTask[] = []
    if (gMatch) {
      try {
        const parsed = JSON.parse(gMatch[1].trim())
        gSummary = parsed.summary || null
        gProposedTasks = Array.isArray(parsed.proposedTasks) ? parsed.proposedTasks : []
      } catch {
        /* noop */
      }
    }
    const bGrill = gMatch ? contentMd.substring(0, gMatch.index!) : null
    const aGrill = gMatch ? contentMd.substring(gMatch.index! + gMatch[0].length) : null

    // Detect grill-question blocks
    const gqMatch = !isUser ? contentMd.match(/```grill-question\n([\s\S]*?)```/) : null
    let gQuestions: GrillQuestion[] = []
    if (gqMatch) {
      try {
        const parsed = JSON.parse(gqMatch[1].trim())
        if (parsed.questions && Array.isArray(parsed.questions)) {
          gQuestions = parsed.questions
        }
      } catch {
        /* noop */
      }
    }
    const bGrillQ = gqMatch ? contentMd.substring(0, gqMatch.index!) : null
    const aGrillQ = gqMatch ? contentMd.substring(gqMatch.index! + gqMatch[0].length) : null

    // Detect grill-evaluation blocks
    const geMatch = !isUser ? contentMd.match(/```grill-evaluation\n([\s\S]*?)```/) : null
    let geData: {
      score: number
      scoreLabel: string
      feedback: string
      questions: GrillQuestion[]
    } | null = null
    if (geMatch) {
      try {
        const parsed = JSON.parse(geMatch[1].trim())
        if (typeof parsed.score === 'number' && Array.isArray(parsed.questions)) {
          geData = {
            score: parsed.score,
            scoreLabel: parsed.scoreLabel ?? '',
            feedback: parsed.feedback ?? '',
            questions: parsed.questions
          }
        }
      } catch {
        /* noop */
      }
    }
    const bGrillEval = geMatch ? contentMd.substring(0, geMatch.index!) : null
    const aGrillEval = geMatch ? contentMd.substring(geMatch.index! + geMatch[0].length) : null

    // Detect build-summary blocks
    const bsMatch = !isUser ? contentMd.match(/```build-summary\n([\s\S]*?)```/) : null
    let bsData: BuildSummary | null = null
    if (bsMatch) {
      try {
        bsData = JSON.parse(bsMatch[1].trim()) as BuildSummary
      } catch {
        /* noop */
      }
    }
    const bBuildSummary = bsMatch ? contentMd.substring(0, bsMatch.index!) : null
    const aBuildSummary = bsMatch ? contentMd.substring(bsMatch.index! + bsMatch[0].length) : null

    return {
      imageAttachments: imageAtts,
      fileAttachments: fileAtts,
      isGrillActivation: grillActivation,
      ideaToRefineMatch: ideaMatch,
      displayContent: dispContent,
      planContent: pContent,
      structuredPlan: sPlan,
      beforePlan: bPlan,
      afterPlan: aPlan,
      grillSummary: gSummary,
      grillProposedTasks: gProposedTasks,
      beforeGrill: bGrill,
      afterGrill: aGrill,
      grillQuestionMatch: gqMatch,
      grillQuestions: gQuestions,
      beforeGrillQuestion: bGrillQ,
      afterGrillQuestion: aGrillQ,
      grillEvalData: geData,
      beforeGrillEval: bGrillEval,
      afterGrillEval: aGrillEval,
      buildSummaryData: bsData,
      beforeBuildSummary: bBuildSummary,
      afterBuildSummary: aBuildSummary
    }
  }, [contentMd, attachmentsJson, isUser])
}
