/**
 * Unit tests for repository mapRow functions — pure data transformation.
 *
 * Tests the safeParseJSON-based row mapping logic used in:
 *   - specialist.repository.ts (no JSON, pure field mapping)
 *   - audit.repository.ts (6 JSON TEXT columns)
 *   - mpa-run.repository.ts (1 JSON TEXT column + secondary mapPhaseRow)
 *   - plan.repository.ts (1 JSON TEXT column with smart fallback)
 *
 * Since mapRow functions are module-level non-exported, we replicate their
 * exact logic here using the shared safeParseJSON utility.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { safeParseJSON } from '../../db/json-utils'

// ─── Specialist mapRow (pure field mapping, no JSON) ───────────────────

interface SpecialistRow {
  id: string
  agent_id: string
  display_name: string
  description: string | null
  icon: string
  color: string
  prompt: string | null
  priority: number
  is_active: number
  source_yaml: string | null
  alias: string | null
  avatar_url: string | null
  is_core: number
  created_at: string
  updated_at: string
}

function mapSpecialistRow(row: SpecialistRow) {
  return {
    id: row.id,
    agentId: row.agent_id,
    displayName: row.display_name,
    description: row.description ?? '',
    icon: row.icon,
    color: row.color,
    prompt: row.prompt ?? '',
    priority: row.priority,
    isActive: row.is_active === 1,
    sourceYaml: row.source_yaml ?? null,
    alias: row.alias ?? null,
    avatarUrl: row.avatar_url ?? null,
    isCore: row.is_core === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

describe('specialist.repository — mapRow', () => {
  const baseRow: SpecialistRow = {
    id: 's1',
    agent_id: 'agent-1',
    display_name: 'Test Specialist',
    description: 'A test specialist',
    icon: 'brain',
    color: '#00f',
    prompt: 'You are a test specialist.',
    priority: 1,
    is_active: 1,
    source_yaml: 'some.yaml',
    alias: 'test-alias',
    avatar_url: 'https://img.com/avatar.png',
    is_core: 0,
    created_at: '2024-01-01',
    updated_at: '2024-01-02'
  }

  test('maps_all_fields_correctly', () => {
    const result = mapSpecialistRow(baseRow)
    assert.equal(result.id, 's1')
    assert.equal(result.agentId, 'agent-1')
    assert.equal(result.displayName, 'Test Specialist')
    assert.equal(result.description, 'A test specialist')
    assert.equal(result.isActive, true)
    assert.equal(result.isCore, false)
    assert.equal(result.alias, 'test-alias')
  })

  test('null_description_defaults_to_empty_string', () => {
    const result = mapSpecialistRow({ ...baseRow, description: null })
    assert.equal(result.description, '')
  })

  test('null_prompt_defaults_to_empty_string', () => {
    const result = mapSpecialistRow({ ...baseRow, prompt: null })
    assert.equal(result.prompt, '')
  })

  test('null_source_yaml_maps_to_null', () => {
    const result = mapSpecialistRow({ ...baseRow, source_yaml: null })
    assert.equal(result.sourceYaml, null)
  })

  test('is_active_0_maps_to_false', () => {
    const result = mapSpecialistRow({ ...baseRow, is_active: 0 })
    assert.equal(result.isActive, false)
  })

  test('is_core_1_maps_to_true', () => {
    const result = mapSpecialistRow({ ...baseRow, is_core: 1 })
    assert.equal(result.isCore, true)
  })
})

// ─── Audit repository — mapRunRow + mapResultRow ──────────────────────

function mapAuditRunRow(row: any) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    mode: row.mode,
    status: row.status,
    overallScore: row.overall_score,
    selectedTracks: safeParseJSON<string[]>(row.selected_tracks, []),
    detectedTechs: safeParseJSON<string[]>(row.detected_techs, []),
    selectedSkills: safeParseJSON<Record<string, unknown>>(row.selected_skills, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapAuditResultRow(row: any) {
  const coverageStats = safeParseJSON<any>(row.coverage_stats, undefined)
  return {
    id: row.id,
    auditRunId: row.audit_run_id,
    trackId: row.track_id,
    score: row.score,
    status: row.status,
    findings: safeParseJSON<any[]>(row.findings, []),
    summary: row.summary ?? '',
    skillsUsed: safeParseJSON<string[]>(row.skills_used, []),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    coverageStats,
    coverageSufficient: row.coverage_sufficient === null ? undefined : row.coverage_sufficient === 1
  }
}

describe('audit.repository — mapRunRow', () => {
  const baseRunRow = {
    id: 'ar-1',
    workspace_id: 'ws-1',
    mode: 'full',
    status: 'completed',
    overall_score: 72,
    selected_tracks: '["code","testing"]',
    detected_techs: '["typescript","react"]',
    selected_skills: '{"code": "skill-1"}',
    created_at: '2024-01-01',
    updated_at: '2024-01-02'
  }

  test('parses_selected_tracks_json', () => {
    const result = mapAuditRunRow(baseRunRow)
    assert.deepEqual(result.selectedTracks, ['code', 'testing'])
  })

  test('parses_detected_techs_json', () => {
    const result = mapAuditRunRow(baseRunRow)
    assert.deepEqual(result.detectedTechs, ['typescript', 'react'])
  })

  test('parses_selected_skills_json', () => {
    const result = mapAuditRunRow(baseRunRow)
    assert.deepEqual(result.selectedSkills, { code: 'skill-1' })
  })

  test('corrupted_json_falls_back_to_empty_array', () => {
    const result = mapAuditRunRow({ ...baseRunRow, selected_tracks: '{broken' })
    assert.deepEqual(result.selectedTracks, [])
  })

  test('null_json_falls_back_to_empty_array', () => {
    const result = mapAuditRunRow({ ...baseRunRow, detected_techs: null })
    assert.deepEqual(result.detectedTechs, [])
  })
})

describe('audit.repository — mapResultRow', () => {
  const baseResultRow = {
    id: 'res-1',
    audit_run_id: 'ar-1',
    track_id: 'code',
    score: 85,
    status: 'completed',
    findings: '[{"severity":"high","message":"Missing tests"}]',
    summary: 'Code quality is good',
    skills_used: '["code-review"]',
    started_at: '2024-01-01T10:00:00',
    completed_at: '2024-01-01T10:05:00',
    coverage_stats: '{"covered":80,"total":100}',
    coverage_sufficient: 1
  }

  test('parses_findings_json_array', () => {
    const result = mapAuditResultRow(baseResultRow)
    assert.equal(result.findings.length, 1)
    assert.equal(result.findings[0].severity, 'high')
  })

  test('parses_skills_used_json', () => {
    const result = mapAuditResultRow(baseResultRow)
    assert.deepEqual(result.skillsUsed, ['code-review'])
  })

  test('parses_coverage_stats_json', () => {
    const result = mapAuditResultRow(baseResultRow)
    assert.deepEqual(result.coverageStats, { covered: 80, total: 100 })
  })

  test('coverage_sufficient_1_maps_to_true', () => {
    const result = mapAuditResultRow(baseResultRow)
    assert.equal(result.coverageSufficient, true)
  })

  test('coverage_sufficient_null_maps_to_undefined', () => {
    const result = mapAuditResultRow({ ...baseResultRow, coverage_sufficient: null })
    assert.equal(result.coverageSufficient, undefined)
  })

  test('null_summary_defaults_to_empty_string', () => {
    const result = mapAuditResultRow({ ...baseResultRow, summary: null })
    assert.equal(result.summary, '')
  })

  test('corrupted_findings_json_falls_back_to_empty_array', () => {
    const result = mapAuditResultRow({ ...baseResultRow, findings: 'not-json' })
    assert.deepEqual(result.findings, [])
  })
})

// ─── MPA Run repository — mapRunRow + mapPhaseRow ─────────────────────

function mapMpaRunRow(row: any) {
  const configJson = safeParseJSON<Record<string, unknown>>(row.config_json, {})
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    grillSessionId: row.grill_session_id,
    title: row.title,
    goal: row.goal,
    goalType: row.goal_type,
    status: row.status,
    currentPhase: row.current_phase,
    configJson,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    totalTokens: row.total_tokens,
    campaignId: row.campaign_id ?? null,
    orderIndex: row.order_index ?? null,
    blueprintId: row.blueprint_id ?? null,
    blueprintPhaseId: row.blueprint_phase_id ?? null
  }
}

function mapMpaPhaseRow(row: any) {
  return {
    id: row.id,
    runId: row.run_id,
    phaseType: row.phase_type,
    iteration: row.iteration,
    status: row.status,
    agentRole: row.agent_role,
    goalCondition: row.goal_condition,
    inputArtifactId: row.input_artifact_id,
    outputArtifactId: row.output_artifact_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    tokensUsed: row.tokens_used,
    streamContent: row.stream_content
  }
}

describe('mpa-run.repository — mapRunRow', () => {
  const baseRow = {
    id: 'mpa-1',
    workspace_id: 'ws-1',
    conversation_id: 'conv-1',
    grill_session_id: null,
    title: 'Test Run',
    goal: 'Build feature',
    goal_type: 'build',
    status: 'completed',
    current_phase: 'verify',
    config_json: '{"maxIterations":3}',
    created_at: '2024-01-01',
    completed_at: '2024-01-02',
    total_tokens: 5000,
    campaign_id: null,
    order_index: null,
    blueprint_id: null,
    blueprint_phase_id: null
  }

  test('parses_config_json', () => {
    const result = mapMpaRunRow(baseRow)
    assert.deepEqual(result.configJson, { maxIterations: 3 })
  })

  test('corrupted_config_json_falls_back_to_empty_object', () => {
    const result = mapMpaRunRow({ ...baseRow, config_json: 'broken{' })
    assert.deepEqual(result.configJson, {})
  })

  test('null_campaign_id_maps_to_null', () => {
    const result = mapMpaRunRow(baseRow)
    assert.equal(result.campaignId, null)
  })

  test('maps_all_scalar_fields', () => {
    const result = mapMpaRunRow(baseRow)
    assert.equal(result.id, 'mpa-1')
    assert.equal(result.title, 'Test Run')
    assert.equal(result.goal, 'Build feature')
    assert.equal(result.totalTokens, 5000)
  })
})

describe('mpa-run.repository — mapPhaseRow', () => {
  test('maps_all_phase_fields', () => {
    const result = mapMpaPhaseRow({
      id: 'p-1',
      run_id: 'mpa-1',
      phase_type: 'plan',
      iteration: 1,
      status: 'completed',
      agent_role: 'mpa-planner',
      goal_condition: 'Create implementation plan',
      input_artifact_id: null,
      output_artifact_id: 'art-1',
      started_at: '2024-01-01T10:00:00',
      completed_at: '2024-01-01T10:05:00',
      tokens_used: 1500,
      stream_content: 'Plan content...'
    })
    assert.equal(result.id, 'p-1')
    assert.equal(result.runId, 'mpa-1')
    assert.equal(result.phaseType, 'plan')
    assert.equal(result.goalCondition, 'Create implementation plan')
    assert.equal(result.tokensUsed, 1500)
  })

  test('null_optional_fields_preserved', () => {
    const result = mapMpaPhaseRow({
      id: 'p-1',
      run_id: 'mpa-1',
      phase_type: 'build',
      iteration: 1,
      status: 'running',
      agent_role: 'mpa-builder',
      goal_condition: null,
      input_artifact_id: null,
      output_artifact_id: null,
      started_at: null,
      completed_at: null,
      tokens_used: 0,
      stream_content: ''
    })
    assert.equal(result.goalCondition, null)
    assert.equal(result.inputArtifactId, null)
    assert.equal(result.startedAt, null)
  })
})

// ─── Plan repository — mapRow with smart fallback ─────────────────────

function mapPlanRow(row: any) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    source: row.source,
    sourceId: row.source_id,
    title: row.title,
    summary: row.summary ?? '',
    planType: row.plan_type ?? null,
    structuredPlan: safeParseJSON(row.structured_plan_json, {
      title: row.title,
      summary: row.summary ?? ''
    }),
    sourcePlanJson: row.source_plan_json,
    requirementDocument: row.requirement_document,
    status: row.status,
    linkedConversationId: row.linked_conversation_id,
    linkedMpaRunId: row.linked_mpa_run_id,
    linkedCouncilSessionId: row.linked_council_session_id,
    fileCount: row.file_count ?? 0,
    phaseCount: row.phase_count ?? 0,
    riskCount: row.risk_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

describe('plan.repository — mapRow', () => {
  const basePlanRow = {
    id: 'plan-1',
    workspace_id: 'ws-1',
    source: 'conversation',
    source_id: 'conv-1',
    title: 'Test Plan',
    summary: 'A test plan',
    plan_type: 'implementation',
    structured_plan_json: '{"title":"Test Plan","phases":[]}',
    source_plan_json: null,
    requirement_document: null,
    status: 'active',
    linked_conversation_id: 'conv-1',
    linked_mpa_run_id: null,
    linked_council_session_id: null,
    file_count: 5,
    phase_count: 3,
    risk_count: 2,
    created_at: '2024-01-01',
    updated_at: '2024-01-02'
  }

  test('parses_structured_plan_json', () => {
    const result = mapPlanRow(basePlanRow)
    assert.deepEqual(result.structuredPlan, { title: 'Test Plan', phases: [] })
  })

  test('corrupted_json_falls_back_to_title_and_summary', () => {
    const result = mapPlanRow({ ...basePlanRow, structured_plan_json: '{broken' })
    assert.deepEqual(result.structuredPlan, { title: 'Test Plan', summary: 'A test plan' })
  })

  test('null_summary_defaults_to_empty_string', () => {
    const result = mapPlanRow({ ...basePlanRow, summary: null })
    assert.equal(result.summary, '')
  })

  test('null_plan_type_maps_to_null', () => {
    const result = mapPlanRow({ ...basePlanRow, plan_type: null })
    assert.equal(result.planType, null)
  })

  test('null_counts_default_to_zero', () => {
    const result = mapPlanRow({
      ...basePlanRow,
      file_count: null,
      phase_count: null,
      risk_count: null
    })
    assert.equal(result.fileCount, 0)
    assert.equal(result.phaseCount, 0)
    assert.equal(result.riskCount, 0)
  })

  test('maps_linked_fields', () => {
    const result = mapPlanRow(basePlanRow)
    assert.equal(result.linkedConversationId, 'conv-1')
    assert.equal(result.linkedMpaRunId, null)
    assert.equal(result.linkedCouncilSessionId, null)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
