/**
 * ClarifyDeliverable — renders clarification Q&A output.
 *
 * Shows questions asked, user answers, and round count.
 * Falls back to markdown when no structured Q&A data is available.
 */

import { type JSX } from 'react'
import { MessageCircleQuestion, User } from 'lucide-react'
import type { BlueprintPhase } from '../../../../../../shared/blueprint-types'
import { parseClarifyFindings } from '../../../../../../shared/blueprint-clarify-parsers'
import { PHASE_ICONS } from '../phase-icons'
import { DeliverableHeader, MetricTile, CappedMarkdownBlock } from './shared'
import { findAllArtifacts } from './artifact-helpers'

// ── Types ──

interface QAPair {
  question: string
  answer: string
}

interface QARound {
  round: number
  pairs: QAPair[]
}

interface ClarifyFinding {
  id: string
  category: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  status: 'resolved' | 'outstanding'
  title: string
  description: string
  recommendation: string
  /** Citation the agent gave for auto-resolving instead of asking. */
  resolvedBy?: string
}

// ── Helpers ──

function extractFindings(phase: BlueprintPhase): ClarifyFinding[] {
  // 1. Try contentJson (structured artifact path)
  for (const art of phase.artifactsJson ?? []) {
    const json = art.contentJson as Record<string, unknown> | undefined
    const findings = json?.findings as Array<Record<string, unknown>> | undefined
    if (findings?.length) {
      return findings.map((f) => ({
        id: String(f.id ?? ''),
        category: String(f.category ?? ''),
        severity: (f.severity as ClarifyFinding['severity']) ?? 'medium',
        status: (f.status as ClarifyFinding['status']) ?? 'outstanding',
        title: String(f.title ?? ''),
        description: String(f.description ?? ''),
        recommendation: String(f.recommendation ?? ''),
        resolvedBy: f.resolvedBy ? String(f.resolvedBy) : undefined
      }))
    }
  }

  // 2. Fallback: parse blueprint-clarify-findings blocks from contentMd
  for (const art of phase.artifactsJson ?? []) {
    if (art.contentMd) {
      const parsed = parseClarifyFindings(art.contentMd)
      if (parsed?.findings.length) {
        return parsed.findings.map((f) => ({
          id: f.id,
          category: f.category,
          severity: f.severity,
          status: f.status === 'deferred' ? 'outstanding' : f.status,
          title: f.title,
          description: f.description,
          recommendation: f.recommendation,
          resolvedBy: f.resolvedBy
        }))
      }
    }
  }
  return []
}

function extractRounds(phase: BlueprintPhase): QARound[] {
  const artifacts = findAllArtifacts(phase.artifactsJson, 'clarify-qa', 'clarify-questions')
  const rounds: QARound[] = []

  for (let i = 0; i < artifacts.length; i++) {
    const art = artifacts[i]
    const json = art.contentJson as Record<string, unknown> | undefined
    if (!json) continue

    const questions = (json.questions as Array<Record<string, unknown>>) ?? []
    const pairs: QAPair[] = questions.map((q) => ({
      question: String(q.question ?? q.text ?? ''),
      answer: String(q.answer ?? q.response ?? '')
    }))

    if (pairs.length > 0) {
      rounds.push({ round: i + 1, pairs })
    }
  }

  return rounds
}

// ── FindingsSection ──

function FindingsSection({ findings }: { findings: ClarifyFinding[] }): JSX.Element {
  const severityColor: Record<string, string> = {
    critical: 'text-danger bg-danger/10 border-danger/20',
    high: 'text-warning bg-warning/10 border-warning/20',
    medium: 'text-info bg-info/10 border-info/20',
    low: 'text-text-muted bg-surface-inset border-border-subtle'
  }
  const statusIcon: Record<string, string> = { resolved: '✓', outstanding: '!' }

  return (
    <div className="space-y-3">
      {findings.map((f) => (
        <div key={f.id} className="rounded-xl border border-border-subtle bg-surface-overlay p-4">
          <div className="flex items-center gap-2 mb-2">
            <span
              className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full border ${severityColor[f.severity] ?? severityColor.medium}`}
            >
              {f.severity.charAt(0).toUpperCase() + f.severity.slice(1)}
            </span>
            <span
              className={`text-[10px] font-medium ${f.status === 'resolved' ? 'text-success' : 'text-warning'}`}
            >
              {statusIcon[f.status] ?? ''} {f.status.charAt(0).toUpperCase() + f.status.slice(1)}
            </span>
          </div>
          <h4 className="text-sm font-medium text-text-primary mb-1">{f.title}</h4>
          <p className="text-sm text-text-secondary mb-2">{f.description}</p>
          {f.recommendation && (
            <p className="text-xs text-text-muted italic border-l-2 border-accent/30 pl-3">
              {f.recommendation}
            </p>
          )}
          {f.resolvedBy && (
            <p className="text-xs text-success/80 mt-2">
              <span className="text-text-muted">Resolved by: </span>
              <span className="font-mono">{f.resolvedBy}</span>
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Component ──

export function ClarifyDeliverable({
  phase,
  duration
}: {
  phase: BlueprintPhase
  duration: number | null
}): JSX.Element {
  const config = PHASE_ICONS.clarify

  const rounds = extractRounds(phase)
  const findings = extractFindings(phase)
  const totalQuestions = rounds.reduce((sum, r) => sum + r.pairs.length, 0)

  // Extract completion metrics from the phase-completion artifact
  const completionArt = phase.artifactsJson?.find(
    (a) => (a.contentJson as Record<string, unknown> | undefined)?.phase === 'clarify'
  )
  const completionJson = completionArt?.contentJson as Record<string, unknown> | undefined
  const questionsAsked = (completionJson?.questionsAsked as number) ?? null
  const questionsAnswered = (completionJson?.questionsAnswered as number) ?? null
  const coverageSummary = completionJson?.coverageSummary as Record<string, number> | undefined

  // Findings view (no Q&A rounds, but has structured findings)
  if (rounds.length === 0 && findings.length > 0) {
    const resolved = findings.filter((f) => f.status === 'resolved').length
    return (
      <div>
        <DeliverableHeader config={config} summary="Clarification completed" duration={duration} />
        <div className="grid grid-cols-3 gap-3 mb-6">
          <MetricTile label="Findings" value={findings.length} />
          <MetricTile label="Resolved" value={resolved} variant="success" />
          <MetricTile
            label="Outstanding"
            value={findings.length - resolved}
            variant={findings.length - resolved > 0 ? 'warning' : 'success'}
          />
          {questionsAsked != null && <MetricTile label="Questions Asked" value={questionsAsked} />}
          {questionsAnswered != null && (
            <MetricTile label="Answered" value={questionsAnswered} variant="success" />
          )}
          {coverageSummary && (
            <>
              {coverageSummary.resolved != null && (
                <MetricTile
                  label="Cov. Resolved"
                  value={coverageSummary.resolved}
                  variant="success"
                />
              )}
              {coverageSummary.deferred != null && (
                <MetricTile
                  label="Cov. Deferred"
                  value={coverageSummary.deferred}
                  variant="warning"
                />
              )}
              {coverageSummary.outstanding != null && (
                <MetricTile
                  label="Cov. Outstanding"
                  value={coverageSummary.outstanding}
                  variant={coverageSummary.outstanding > 0 ? 'danger' : 'success'}
                />
              )}
            </>
          )}
        </div>
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
          Findings Analysis
        </h3>
        <FindingsSection findings={findings} />
      </div>
    )
  }

  // Fallback: check for contentMd
  const mdArtifact = phase.artifactsJson?.find((a) => a.contentMd)

  if (rounds.length === 0 && mdArtifact?.contentMd) {
    return (
      <div>
        <DeliverableHeader config={config} summary="Clarification completed" duration={duration} />
        <CappedMarkdownBlock
          content={mdArtifact.contentMd}
          label="Clarification Details"
          className=""
        />
      </div>
    )
  }

  if (rounds.length === 0) {
    return (
      <div>
        <DeliverableHeader
          config={config}
          summary="No clarification data found"
          duration={duration}
        />
        <p className="text-xs text-text-muted italic">
          No Q&A artifacts were produced by this phase.
        </p>
      </div>
    )
  }

  return (
    <div>
      <DeliverableHeader
        config={config}
        summary={`${totalQuestions} question${totalQuestions > 1 ? 's' : ''} resolved in ${rounds.length} round${rounds.length > 1 ? 's' : ''}`}
        duration={duration}
      />

      {/* Metrics */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <MetricTile label="Questions" value={totalQuestions} />
        <MetricTile label="Rounds" value={rounds.length} />
        <MetricTile
          label="Status"
          value={phase.status === 'complete' ? 'Resolved ✓' : phase.status}
          variant={phase.status === 'complete' ? 'success' : 'default'}
        />
      </div>

      {/* Rounds */}
      <div className="space-y-6">
        {rounds.map((round) => (
          <div key={round.round}>
            {rounds.length > 1 && (
              <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
                Round {round.round}
              </h3>
            )}
            <div className="space-y-3">
              {round.pairs.map((pair, i) => (
                <div
                  key={i}
                  className="rounded-xl border border-border-subtle bg-surface-overlay p-4 space-y-2.5"
                >
                  <div className="flex items-start gap-2">
                    <MessageCircleQuestion size={14} className="text-accent mt-0.5 flex-shrink-0" />
                    <span className="text-sm font-medium text-text-primary">{pair.question}</span>
                  </div>
                  {pair.answer && (
                    <div className="flex items-start gap-2 border-l-2 border-accent/30 pl-3 ml-1">
                      <User size={12} className="text-text-muted mt-0.5 flex-shrink-0" />
                      <span className="text-sm text-text-secondary">{pair.answer}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
