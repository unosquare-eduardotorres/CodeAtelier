/**
 * SpecifyDeliverable — renders the specification output.
 *
 * Shows word count, section outline, and full spec markdown.
 */

import { type JSX } from 'react'
import { FileText, CheckCircle2 } from 'lucide-react'
import type { BlueprintPhase } from '../../../../../../shared/blueprint-types'
import { PHASE_ICONS } from '../phase-icons'
import { DeliverableHeader, MetricTile, DiscoveriesSection, CappedMarkdownBlock } from './shared'
import { findArtifact, extractDiscoveries } from './artifact-helpers'

// ── Helpers ──

function extractHeadings(md: string): string[] {
  return md
    .split('\n')
    .filter((line) => /^#{1,3}\s/.test(line))
    .map((line) => line.replace(/^#+\s*/, '').trim())
}

function countWords(md: string): number {
  return md.split(/\s+/).filter(Boolean).length
}

// ── Component ──

export function SpecifyDeliverable({
  phase,
  duration
}: {
  phase: BlueprintPhase
  duration: number | null
}): JSX.Element {
  const config = PHASE_ICONS.specify
  const spec = findArtifact(phase.artifactsJson, 'spec', 'specification')

  const contentMd = spec?.contentMd ?? ''
  const wordCount = contentMd ? countWords(contentMd) : 0
  const headings = contentMd ? extractHeadings(contentMd) : []

  // Extract discoveries from separate artifacts
  const discoveries = extractDiscoveries(phase.artifactsJson)

  // Extract completion metrics from the phase-completion contentJson
  const completionArt = phase.artifactsJson?.find(
    (a) => (a.contentJson as Record<string, unknown> | undefined)?.phase === 'specify'
  )
  const completion = (completionArt?.contentJson ?? spec?.contentJson) as
    Record<string, unknown> | undefined
  const userStoryCount = completion?.userStoryCount as number | undefined
  const requirementCount = completion?.requirementCount as number | undefined
  const checklistScore = completion?.checklistScore as string | undefined
  const needsClarification = completion?.needsClarification as boolean | undefined

  if (!spec?.contentMd) {
    return (
      <div>
        <DeliverableHeader
          config={config}
          summary="No specification artifact found"
          duration={duration}
        />
        <p className="text-xs text-text-muted italic">
          The specification artifact was not produced by this phase.
        </p>
      </div>
    )
  }

  const formattedWordCount =
    wordCount >= 1000 ? `${(wordCount / 1000).toFixed(1)}k` : String(wordCount)

  return (
    <div>
      <DeliverableHeader
        config={config}
        summary={`Specification drafted (${formattedWordCount} words)`}
        duration={duration}
      />

      {/* Metrics row */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <MetricTile label="Word Count" value={formattedWordCount} icon={FileText} />
        <MetricTile label="Sections" value={headings.length} />
        {userStoryCount != null && <MetricTile label="User Stories" value={userStoryCount} />}
        {requirementCount != null && <MetricTile label="Requirements" value={requirementCount} />}
        {checklistScore && (
          <MetricTile label="Checklist" value={checklistScore} variant="success" />
        )}
        {needsClarification != null && (
          <MetricTile
            label="Needs Clarification"
            value={needsClarification ? 'Yes' : 'No'}
            variant={needsClarification ? 'warning' : 'success'}
          />
        )}
        <MetricTile
          label="Status"
          value={phase.status === 'complete' ? 'Complete ✓' : phase.status}
          variant={phase.status === 'complete' ? 'success' : 'default'}
        />
      </div>

      {/* Section outline */}
      {headings.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
            Section Outline
          </h3>
          <div className="space-y-1">
            {headings.map((heading, i) => (
              <div key={i} className="flex items-center gap-2 text-sm text-text-secondary">
                <CheckCircle2 size={12} className="text-success/50 flex-shrink-0" />
                {heading}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Full specification */}
      <CappedMarkdownBlock
        content={spec.contentMd}
        label="Full Specification"
        maxH="max-h-[600px]"
      />

      {/* Discoveries */}
      <DiscoveriesSection discoveries={discoveries} />
    </div>
  )
}
