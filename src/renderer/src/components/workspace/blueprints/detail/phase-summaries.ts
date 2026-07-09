/**
 * phase-summaries.ts — PURE helpers to derive one-line summaries + stats from
 * blueprint phase artifacts. Unit-testable, no React dependency.
 *
 * Each phase function receives the phase data and returns a { summary, stats }
 * object. Graceful fallback when artifact data is missing or malformed.
 */

import type {
  BlueprintPhase,
  BlueprintTask,
  BlueprintArtifact
} from '../../../../../../shared/blueprint-types'

// ── Duration formatter ──

export function formatDuration(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt || !completedAt) return null
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime()
  if (ms < 0) return null
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) {
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return s > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${m}m`
  }
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

export function formatDurationMs(ms: number): string {
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) {
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return s > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${m}m`
  }
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

// ── Per-phase summary helpers ──

export interface PhaseSummary {
  summary: string
  duration: string | null
}

function fallbackSummary(phase: BlueprintPhase): PhaseSummary {
  const duration = formatDuration(phase.startedAt, phase.completedAt)
  if (phase.status === 'complete') {
    return { summary: duration ? `Completed in ${duration}` : 'Completed', duration }
  }
  if (phase.status === 'failed') return { summary: 'Failed', duration }
  if (phase.status === 'active') return { summary: 'In progress…', duration: null }
  if (phase.status === 'skipped') return { summary: 'Skipped', duration: null }
  return { summary: '—', duration: null }
}

/** Find a specific artifact by type, optional-chaining safe */
function findArtifact(phase: BlueprintPhase, type: string): BlueprintArtifact | undefined {
  return phase.artifactsJson?.find((a) => a.type === type)
}

// ── Specify ──

export function getSpecifySummary(phase: BlueprintPhase): PhaseSummary {
  const duration = formatDuration(phase.startedAt, phase.completedAt)
  const spec = findArtifact(phase, 'spec') ?? findArtifact(phase, 'specification')
  if (spec?.contentMd) {
    const wordCount = spec.contentMd.split(/\s+/).filter(Boolean).length
    const kw = wordCount >= 1000 ? `${(wordCount / 1000).toFixed(1)}k` : String(wordCount)
    return { summary: `Spec drafted (${kw} words)`, duration }
  }
  return fallbackSummary(phase)
}

// ── Clarify ──

export function getClarifySummary(phase: BlueprintPhase): PhaseSummary {
  const duration = formatDuration(phase.startedAt, phase.completedAt)
  const qa = findArtifact(phase, 'clarify-qa')
  if (qa?.contentJson) {
    const json = qa.contentJson as Record<string, unknown>
    const questions = (json.questions as unknown[])?.length ?? 0
    const rounds = (json.rounds as number) ?? (json.round as number) ?? 1
    if (questions > 0) {
      return { summary: `${questions} question${questions > 1 ? 's' : ''} · ${rounds} round${rounds > 1 ? 's' : ''}`, duration }
    }
  }
  // Try counting questions from all clarify-type artifacts
  const allQAs = phase.artifactsJson?.filter((a) => a.type === 'clarify-qa' || a.type === 'clarify-questions') ?? []
  if (allQAs.length > 0) {
    let totalQ = 0
    for (const a of allQAs) {
      const json = a.contentJson as Record<string, unknown> | undefined
      totalQ += (json?.questions as unknown[])?.length ?? 0
    }
    if (totalQ > 0) {
      return { summary: `${totalQ} questions · ${allQAs.length} round${allQAs.length > 1 ? 's' : ''}`, duration }
    }
  }
  if (phase.status === 'skipped') return { summary: 'Skipped', duration: null }
  return fallbackSummary(phase)
}

// ── Plan ──

export function getPlanSummary(phase: BlueprintPhase): PhaseSummary {
  const duration = formatDuration(phase.startedAt, phase.completedAt)
  const plan = findArtifact(phase, 'plan') ?? findArtifact(phase, 'blueprint-plan')
  if (plan?.contentJson) {
    const json = plan.contentJson as Record<string, unknown>
    const items = (json.items ?? json.phases ?? json.steps ?? []) as unknown[]
    const totalFiles = items.reduce((sum: number, item: unknown) => {
      const files = ((item as Record<string, unknown>).files as string[]) ?? []
      return sum + files.length
    }, 0)
    const parts = [`${items.length} items`]
    if (totalFiles > 0) parts.push(`${totalFiles} files`)
    return { summary: parts.join(' · '), duration }
  }
  return fallbackSummary(phase)
}

// ── Tasks ──

export function getTasksSummary(phase: BlueprintPhase, tasks: BlueprintTask[]): PhaseSummary {
  const duration = formatDuration(phase.startedAt, phase.completedAt)
  const tasksArt = findArtifact(phase, 'tasks') ?? findArtifact(phase, 'blueprint-tasks')
  if (tasksArt?.contentJson) {
    const json = tasksArt.contentJson as Record<string, unknown>
    const waves = (json.waves as unknown[]) ?? []
    const flatTasks = waves.length > 0
      ? waves.flatMap((w) => ((w as Record<string, unknown>).tasks as unknown[]) ?? [])
      : ((json.tasks ?? json.items ?? []) as unknown[])
    const waveCount = waves.length || 1
    return { summary: `${flatTasks.length} tasks in ${waveCount} wave${waveCount > 1 ? 's' : ''}`, duration }
  }
  // Fallback: use actual tasks from DB
  if (tasks.length > 0) {
    const waveSet = new Set(tasks.map((t) => t.wave))
    return { summary: `${tasks.length} tasks in ${waveSet.size} wave${waveSet.size > 1 ? 's' : ''}`, duration }
  }
  return fallbackSummary(phase)
}

// ── Review ──

export function getReviewSummary(phase: BlueprintPhase): PhaseSummary {
  const duration = formatDuration(phase.startedAt, phase.completedAt)
  const review = findArtifact(phase, 'review') ?? findArtifact(phase, 'blueprint-review')
  if (review?.contentJson) {
    const json = review.contentJson as Record<string, unknown>
    const recommendation = json.recommendation as string | undefined
    if (recommendation) {
      const label = recommendation === 'approve' ? 'Approved' : recommendation.charAt(0).toUpperCase() + recommendation.slice(1)
      return { summary: label, duration }
    }
  }
  if (phase.status === 'complete') return { summary: 'Approved', duration }
  return fallbackSummary(phase)
}

// ── Build ──

export interface BuildStats {
  tasksCompleted: number
  totalTasks: number
  filesCreated: string[]
  filesModified: string[]
}

export function getBuildSummary(phase: BlueprintPhase, tasks: BlueprintTask[]): PhaseSummary & { stats?: BuildStats } {
  const duration = formatDuration(phase.startedAt, phase.completedAt)
  const build = findArtifact(phase, 'build') ?? findArtifact(phase, 'build-metrics')
  if (build?.contentJson) {
    const json = build.contentJson as Record<string, unknown>
    const completed = (json.tasksCompleted as number) ?? 0
    const total = (json.totalTasks as number) ?? tasks.length
    const created = (json.filesCreated as string[]) ?? []
    const modified = (json.filesModified as string[]) ?? []
    const parts: string[] = []
    if (total > 0) parts.push(`${completed}/${total}`)
    if (created.length > 0) parts.push(`${created.length} created`)
    if (modified.length > 0) parts.push(`${modified.length} mod`)
    const stats: BuildStats = { tasksCompleted: completed, totalTasks: total, filesCreated: created, filesModified: modified }
    return { summary: parts.join(' · ') || fallbackSummary(phase).summary, duration, stats }
  }
  // Fallback: derive from task list
  if (tasks.length > 0) {
    const done = tasks.filter((t) => t.status === 'complete').length
    return { summary: `${done}/${tasks.length} tasks`, duration }
  }
  return fallbackSummary(phase)
}

// ── Verify ──

export interface VerifyStats {
  overallStatus: 'passed' | 'gaps_found' | 'human_needed' | string
  remediationCount: number
  remediationTasks: Array<{ taskId: string; description: string; status?: string }>
}

export function getVerifySummary(phase: BlueprintPhase): PhaseSummary & { stats?: VerifyStats } {
  const duration = formatDuration(phase.startedAt, phase.completedAt)
  const verify = findArtifact(phase, 'verify') ?? findArtifact(phase, 'verification')
  if (verify?.contentJson) {
    const json = verify.contentJson as Record<string, unknown>
    const overallStatus = (json.overallStatus as string) ?? 'unknown'
    const tasks = (json.tasks as Array<Record<string, unknown>>) ?? []
    const remediations = tasks.filter((t) => String(t.taskId ?? '').startsWith('R'))
    const parts: string[] = []
    if (overallStatus === 'passed') parts.push('Passed')
    else if (overallStatus === 'gaps_found') parts.push('Gaps found')
    else if (overallStatus === 'human_needed') parts.push('Human review needed')
    else parts.push(overallStatus)
    if (remediations.length > 0) parts.push(`${remediations.length} remediation${remediations.length > 1 ? 's' : ''}`)
    const stats: VerifyStats = {
      overallStatus,
      remediationCount: remediations.length,
      remediationTasks: remediations.map((t) => ({
        taskId: String(t.taskId ?? ''),
        description: String(t.description ?? ''),
        status: t.status as string | undefined
      }))
    }
    return { summary: parts.join(' · '), duration, stats }
  }
  return fallbackSummary(phase)
}

// ── Dispatcher ──

export function getPhaseSummary(phase: BlueprintPhase, tasks: BlueprintTask[]): PhaseSummary {
  switch (phase.phase) {
    case 'specify': return getSpecifySummary(phase)
    case 'clarify': return getClarifySummary(phase)
    case 'plan': return getPlanSummary(phase)
    case 'tasks': return getTasksSummary(phase, tasks)
    case 'review': return getReviewSummary(phase)
    case 'build': return getBuildSummary(phase, tasks)
    case 'verify': return getVerifySummary(phase)
    default: return fallbackSummary(phase)
  }
}

// ── Aggregate stats for OutcomeSummary ──

export interface BlueprintOutcomeStats {
  totalTasks: number
  completedTasks: number
  totalWaves: number
  filesCreated: number
  filesModified: number
  remediationCount: number
  verifyStatus: string | null
  totalDuration: string | null
}

export function getOutcomeStats(
  phases: BlueprintPhase[],
  tasks: BlueprintTask[]
): BlueprintOutcomeStats {
  // Task metrics
  const completedTasks = tasks.filter((t) => t.status === 'complete').length
  const waveSet = new Set(tasks.map((t) => t.wave))

  // Build artifact metrics
  const buildPhase = phases.find((p) => p.phase === 'build')
  const buildResult = buildPhase ? getBuildSummary(buildPhase, tasks) : null
  const filesCreated = buildResult?.stats?.filesCreated.length ?? 0
  const filesModified = buildResult?.stats?.filesModified.length ?? 0

  // Verify metrics
  const verifyPhase = phases.find((p) => p.phase === 'verify')
  const verifyResult = verifyPhase ? getVerifySummary(verifyPhase) : null

  // Total duration from first phase start to last phase complete
  const startTimes = phases.map((p) => p.startedAt).filter(Boolean) as string[]
  const endTimes = phases.map((p) => p.completedAt).filter(Boolean) as string[]
  let totalDuration: string | null = null
  if (startTimes.length > 0 && endTimes.length > 0) {
    const earliest = Math.min(...startTimes.map((s) => new Date(s).getTime()))
    const latest = Math.max(...endTimes.map((s) => new Date(s).getTime()))
    totalDuration = formatDurationMs(latest - earliest)
  }

  return {
    totalTasks: tasks.length,
    completedTasks,
    totalWaves: waveSet.size,
    filesCreated,
    filesModified,
    remediationCount: verifyResult?.stats?.remediationCount ?? 0,
    verifyStatus: verifyResult?.stats?.overallStatus ?? null,
    totalDuration
  }
}
