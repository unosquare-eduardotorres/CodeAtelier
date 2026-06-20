/**
 * HealthConfigure — full-screen audit configuration step.
 *
 * Replaces the cramped sidebar-checkbox + AuditModelModal flow with:
 *   - Selectable auditor cards (icon, name, description, scoring focus)
 *   - An honest Light vs Deep comparison (both use code-graph + semantic search;
 *     Deep = a more thorough multi-round pass plus selectable focus skills)
 *   - Deep-only per-track skill chips (curated catalog)
 *   - Provider toggle (Cloud / Local)
 */

import { useState, useCallback } from 'react'
import {
  Database,
  Code,
  TestTube,
  Building2,
  Shield,
  FileText,
  Palette,
  Check,
  Cloud,
  Monitor,
  Play,
  Zap,
  Microscope,
  ChevronLeft
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type {
  AuditMode,
  AuditTrackId,
  AuditSelectedSkills,
  LLMProvider
} from '../../../../../shared/types'
import { AUDIT_TRACKS, AUDIT_TRACK_SKILLS } from '../../../../../shared/constants'

const ICON_MAP: Record<string, LucideIcon> = {
  Database,
  Code,
  TestTube,
  Building2,
  Shield,
  FileText,
  Palette
}

const ALL_TRACK_IDS = Object.keys(AUDIT_TRACKS) as AuditTrackId[]

interface HealthConfigureProps {
  initialMode?: AuditMode
  initialTracks?: AuditTrackId[]
  initialProvider?: LLMProvider
  onRun: (config: {
    mode: AuditMode
    tracks: AuditTrackId[]
    provider: LLMProvider
    selectedSkills: AuditSelectedSkills
  }) => void
  onBack: () => void
}

export default function HealthConfigure({
  initialMode = 'light',
  initialTracks,
  initialProvider = 'claude',
  onRun,
  onBack
}: HealthConfigureProps): React.JSX.Element {
  const [mode, setMode] = useState<AuditMode>(initialMode)
  const [provider, setProvider] = useState<LLMProvider>(initialProvider)
  const [selectedTracks, setSelectedTracks] = useState<Set<AuditTrackId>>(
    new Set(initialTracks ?? ALL_TRACK_IDS)
  )
  const [selectedSkills, setSelectedSkills] = useState<AuditSelectedSkills>({})

  const toggleTrack = useCallback((trackId: AuditTrackId) => {
    setSelectedTracks((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }, [])

  const toggleSkill = useCallback((trackId: AuditTrackId, skillId: string) => {
    setSelectedSkills((prev) => {
      const current = prev[trackId] ?? []
      const next = current.includes(skillId)
        ? current.filter((id) => id !== skillId)
        : [...current, skillId]
      return { ...prev, [trackId]: next }
    })
  }, [])

  const handleRun = useCallback(() => {
    const tracks = ALL_TRACK_IDS.filter((id) => selectedTracks.has(id))
    if (tracks.length === 0) return
    // Only persist skills for tracks that are actually selected + Deep mode.
    const skills: AuditSelectedSkills =
      mode === 'deep'
        ? Object.fromEntries(
            tracks
              .map((id) => [id, selectedSkills[id] ?? []] as const)
              .filter(([, ids]) => ids.length > 0)
          )
        : {}
    onRun({ mode, tracks, provider, selectedSkills: skills })
  }, [mode, provider, selectedTracks, selectedSkills, onRun])

  const estimatePer = mode === 'light' ? 30 : 150
  const totalSeconds = estimatePer * selectedTracks.size
  const estimateText =
    totalSeconds < 60 ? `~${totalSeconds}s` : `~${(totalSeconds / 60).toFixed(1)} min`

  return (
    <div data-testid="health-configure" className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle bg-surface-raised">
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
            title="Back to history"
          >
            <ChevronLeft size={16} />
          </button>
          <h2 className="text-sm font-bold text-text-primary">Configure Audit</h2>
        </div>
        <button
          data-testid="health-run-btn"
          onClick={handleRun}
          disabled={selectedTracks.size === 0}
          className="flex items-center gap-2 px-4 py-1.5 text-sm font-semibold rounded-lg bg-success/15 text-success hover:bg-success/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Play size={14} />
          Run Audit · {selectedTracks.size} · {estimateText}
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-6 space-y-8">
          {/* ── Depth ── */}
          <section>
            <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-3">
              Depth
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <DepthCard
                active={mode === 'light'}
                icon={Zap}
                title="Light"
                accent="text-warning"
                bullets={[
                  'Code-graph + semantic search',
                  'Fast, single-pass review',
                  'Best for daily health snapshots'
                ]}
                estimate="~30s per auditor"
                onClick={() => setMode('light')}
              />
              <DepthCard
                active={mode === 'deep'}
                icon={Microscope}
                title="Deep"
                accent="text-info"
                bullets={[
                  'Everything in Light, plus…',
                  'Thorough multi-round inspection',
                  'Selectable per-auditor focus skills'
                ]}
                estimate="~2–5 min per auditor"
                onClick={() => setMode('deep')}
              />
            </div>
          </section>

          {/* ── Provider ── */}
          <section>
            <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-3">
              Provider
            </h3>
            <div className="grid grid-cols-2 gap-3 max-w-md">
              <ProviderButton
                active={provider === 'claude'}
                icon={Cloud}
                label="Claude"
                onClick={() => setProvider('claude')}
              />
              <ProviderButton
                active={provider === 'local-llm'}
                icon={Monitor}
                label="Local LLM"
                onClick={() => setProvider('local-llm')}
              />
            </div>
          </section>

          {/* ── Auditors ── */}
          <section>
            <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-3">
              Auditors
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {ALL_TRACK_IDS.map((trackId) => {
                const track = AUDIT_TRACKS[trackId]
                const Icon = ICON_MAP[track.icon] ?? Code
                const isSelected = selectedTracks.has(trackId)
                const trackSkills = AUDIT_TRACK_SKILLS[trackId] ?? []
                const chosen = selectedSkills[trackId] ?? []

                return (
                  <div
                    key={trackId}
                    className={`rounded-xl border p-4 transition-all ${
                      isSelected
                        ? 'border-primary/50 bg-primary-muted/20'
                        : 'border-border-subtle bg-surface-raised'
                    }`}
                  >
                    <button
                      onClick={() => toggleTrack(trackId)}
                      className="w-full flex items-start gap-3 text-left"
                    >
                      <div
                        className={`mt-0.5 w-5 h-5 rounded flex items-center justify-center flex-shrink-0 border ${
                          isSelected
                            ? 'bg-primary border-primary text-white'
                            : 'border-border-default'
                        }`}
                      >
                        {isSelected && <Check size={13} />}
                      </div>
                      <Icon size={18} className="text-primary-text flex-shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-semibold text-text-primary">
                          {track.name}
                        </span>
                        <p className="text-[11px] text-text-secondary mt-0.5 leading-snug">
                          {track.description}
                        </p>
                      </div>
                    </button>

                    {/* Deep-only skill chips for selected tracks */}
                    {mode === 'deep' && isSelected && trackSkills.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-border-subtle">
                        <span className="text-[10px] text-text-muted">Focus skills (optional)</span>
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {trackSkills.map((skill) => {
                            const on = chosen.includes(skill.id)
                            return (
                              <button
                                key={skill.id}
                                onClick={() => toggleSkill(trackId, skill.id)}
                                title={skill.description}
                                className={`px-2 py-0.5 text-[10px] rounded-full border transition-colors ${
                                  on
                                    ? 'bg-info/15 border-info/40 text-info'
                                    : 'border-border-subtle text-text-muted hover:text-text-secondary hover:border-border-default'
                                }`}
                              >
                                {skill.name}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ──

function DepthCard({
  active,
  icon: Icon,
  title,
  accent,
  bullets,
  estimate,
  onClick
}: {
  active: boolean
  icon: LucideIcon
  title: string
  accent: string
  bullets: string[]
  estimate: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col gap-2 p-4 rounded-xl border-2 text-left transition-all ${
        active
          ? 'border-primary bg-primary-muted/30'
          : 'border-border-subtle hover:border-primary/30 hover:bg-surface-overlay'
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon size={18} className={accent} />
        <span className="text-sm font-semibold text-text-primary">{title}</span>
        <span className="text-[10px] text-text-muted ml-auto">{estimate}</span>
      </div>
      <ul className="space-y-1">
        {bullets.map((b, i) => (
          <li key={i} className="text-[11px] text-text-secondary flex items-start gap-1.5">
            <span className="text-text-muted mt-0.5">•</span>
            {b}
          </li>
        ))}
      </ul>
    </button>
  )
}

function ProviderButton({
  active,
  icon: Icon,
  label,
  onClick
}: {
  active: boolean
  icon: LucideIcon
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex items-center justify-center gap-2 p-3 rounded-xl border-2 transition-all ${
        active
          ? 'border-primary bg-primary-muted/40'
          : 'border-border-subtle hover:border-primary/30 hover:bg-surface-overlay'
      }`}
    >
      <Icon size={18} className={active ? 'text-primary-text' : 'text-text-muted'} />
      <span
        className={`text-sm font-medium ${active ? 'text-primary-text' : 'text-text-secondary'}`}
      >
        {label}
      </span>
    </button>
  )
}
