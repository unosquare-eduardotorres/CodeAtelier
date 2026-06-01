/**
 * CouncilVerdictCard — displays the chairman's synthesized verdict.
 *
 * Shows:
 *   - Score gauge (reuses ScoreGauge)
 *   - Sections: Agrees / Clashes / Blind Spots / Recommendation / One Thing
 *   - Expandable revision recommendations with consensus labels
 *   - Individual advisor score chips
 */

import { useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertTriangle,
  Eye,
  Lightbulb,
  Target
} from 'lucide-react'
import ScoreGauge from '../ScoreGauge'
import AdvisorIcon from './AdvisorIcon'
import type { CouncilVerdict, CouncilAdvisorRole } from '../../../../../shared/types'
import { COUNCIL_ADVISORS } from '../../../../../shared/constants'

interface CouncilVerdictCardProps {
  verdict: CouncilVerdict
}

/**
 * VerdictText — converts the chairman's dense prose strings into readable
 * structure. The source isn't markdown, so we detect inline enumerations:
 *   1. Numbered lists: 2+ inline `(n)` markers → optional intro + ordered list.
 *   2. Bullet lists: `• ` separators → unordered list.
 *   3. Fallback: split on newlines/blank lines → one paragraph per chunk.
 */
function VerdictText({ text }: { text: string }): React.JSX.Element | null {
  if (!text) return null

  // 1. Numbered lists — inline `(1) … (2) …` enumerations.
  const markers = text.match(/\(\d+\)/g)
  if (markers && markers.length >= 2) {
    const firstIdx = text.indexOf(markers[0])
    const intro = text.slice(0, firstIdx).trim()
    const items = text
      .slice(firstIdx)
      .split(/(?=\(\d+\)\s)/)
      .map((s) => s.trim())
      .filter(Boolean)
    return (
      <div className="space-y-2">
        {intro && <p className="text-sm text-text-body leading-relaxed">{intro}</p>}
        <ol className="space-y-1.5">
          {items.map((item, i) => {
            const m = item.match(/^\((\d+)\)\s*([\s\S]*)$/)
            return (
              <li key={i} className="flex gap-2 text-sm text-text-body leading-relaxed">
                <span className="font-semibold text-text-primary tabular-nums flex-shrink-0">
                  {m?.[1] ?? i + 1}.
                </span>
                <span>{m?.[2] ?? item}</span>
              </li>
            )
          })}
        </ol>
      </div>
    )
  }

  // 2. Bullet lists — `• ` separated clauses.
  if (text.includes('• ')) {
    const parts = text
      .split('• ')
      .map((s) => s.trim())
      .filter(Boolean)
    const [intro, ...bullets] = parts
    // If the text starts with `• `, there is no intro chunk.
    const hasIntro = !text.trimStart().startsWith('• ')
    const items = hasIntro ? bullets : parts
    const lead = hasIntro ? intro : ''
    return (
      <div className="space-y-2">
        {lead && <p className="text-sm text-text-body leading-relaxed">{lead}</p>}
        <ul className="space-y-1.5">
          {items.map((item, i) => (
            <li key={i} className="flex gap-2 text-sm text-text-body leading-relaxed">
              <span className="text-text-secondary flex-shrink-0">•</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  // 3. Paragraph fallback — respect real line breaks the LLM emits.
  const paragraphs = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return (
    <div className="space-y-2">
      {paragraphs.map((p, i) => (
        <p key={i} className="text-sm text-text-body leading-relaxed">
          {p}
        </p>
      ))}
    </div>
  )
}

function SectionBlock({
  icon: Icon,
  title,
  content,
  accentColor
}: {
  icon: React.ElementType
  title: string
  content: string
  accentColor: string
}): React.JSX.Element {
  return (
    <div className={`rounded-lg border border-border-subtle p-3 border-l-2 ${accentColor}`}>
      <div className="flex items-center gap-2 mb-2">
        <Icon size={14} className="text-text-secondary" />
        <span className="text-sm font-semibold text-text-primary">{title}</span>
      </div>
      <VerdictText text={content} />
    </div>
  )
}

export default function CouncilVerdictCard({
  verdict
}: CouncilVerdictCardProps): React.JSX.Element {
  const [revisionsExpanded, setRevisionsExpanded] = useState(true)

  const priorityColors: Record<string, string> = {
    high: 'bg-error/10 text-error border-error/20',
    medium: 'bg-warning/10 text-warning border-warning/20',
    low: 'bg-info/10 text-info border-info/20'
  }

  return (
    <div className="space-y-4">
      {/* Score + Recommendation hero */}
      <div className="flex items-start gap-6 p-4 rounded-lg bg-surface-float border border-border-subtle">
        <ScoreGauge score={verdict.overallScore} size={100} />
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-bold text-text-primary mb-1">Council Verdict</h3>
          <VerdictText text={verdict.sections.recommendation} />
          {verdict.sections.oneThingFirst && (
            <div className="mt-3 flex items-start gap-2 p-2 rounded bg-primary/10 border border-primary/20">
              <Target size={14} className="text-primary mt-0.5 flex-shrink-0" />
              <div>
                <span className="text-xs font-semibold text-primary">Do This First</span>
                <VerdictText text={verdict.sections.oneThingFirst} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Individual advisor scores */}
      {verdict.individualScores && Object.keys(verdict.individualScores).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {(Object.entries(verdict.individualScores) as [CouncilAdvisorRole, number][]).map(
            ([role, score]) => {
              const advisor = COUNCIL_ADVISORS[role]
              if (!advisor) return null
              return (
                <div
                  key={role}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-float border border-border-subtle"
                >
                  <AdvisorIcon advisor={advisor} size={14} className="text-text-secondary" />
                  <span className="text-xs text-text-secondary">{advisor.name}</span>
                  <span className="text-xs font-bold text-text-primary">{score}</span>
                </div>
              )
            }
          )}
        </div>
      )}

      {/* Analysis sections */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <SectionBlock
          icon={CheckCircle2}
          title="Agreement"
          content={verdict.sections.agrees}
          accentColor="border-l-success"
        />
        <SectionBlock
          icon={AlertTriangle}
          title="Disagreements"
          content={verdict.sections.clashes}
          accentColor="border-l-warning"
        />
        <SectionBlock
          icon={Eye}
          title="Blind Spots"
          content={verdict.sections.blindSpots}
          accentColor="border-l-danger"
        />
        <SectionBlock
          icon={Lightbulb}
          title="Recommendation"
          content={verdict.sections.recommendation}
          accentColor="border-l-primary"
        />
      </div>

      {/* Revision recommendations */}
      {verdict.revisions.length > 0 && (
        <div className="rounded-lg border border-border-subtle overflow-hidden">
          <button
            onClick={() => setRevisionsExpanded(!revisionsExpanded)}
            className="flex items-center justify-between w-full px-4 py-2.5 bg-surface-float hover:bg-surface-float/80 transition-colors"
          >
            <span className="text-sm font-semibold text-text-primary">
              Recommended Revisions ({verdict.revisions.length})
            </span>
            {revisionsExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>

          {revisionsExpanded && (
            <div className="divide-y divide-border-subtle">
              {verdict.revisions.map((rev, i) => (
                <div key={i} className="px-4 py-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase border ${priorityColors[rev.priority] ?? ''}`}
                    >
                      {rev.priority}
                    </span>
                    <span className="text-xs text-text-secondary">{rev.consensus}</span>
                  </div>
                  <p className="text-sm text-text-body">{rev.description}</p>
                  {rev.evidence && (
                    <p className="text-xs text-text-secondary mt-1 italic">{rev.evidence}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
