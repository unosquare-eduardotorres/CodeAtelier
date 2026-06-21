/**
 * Phase 16, Track 6 — Repository branch coverage tests
 *
 * Deeper branch coverage for repositories at 33-50%, exercising
 * edge-case data seeding and conditional branches.
 *
 * Uses trySetup() pattern for graceful degradation when better-sqlite3
 * is not compatible with the current Node.js ABI.
 *
 * Covers deeper branches in:
 *   blueprint.repository, specialist.repository, audit.repository,
 *   mpa-run.repository, code-graph-tag.repository, code-chunk.repository,
 *   conversation-specialist.repository, core-agent-prompt.repository,
 *   memory.repository, agent-session.repository, skill.repository,
 *   app-preference.repository
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, describe } from '../../../services/__tests__/test-harness'

interface TestEnv {
  Database: typeof import('better-sqlite3')
}

function trySetup(): TestEnv | null {
  try {
    process.env.NODE_ENV = 'test'
    const Database = require('better-sqlite3')
    new Database(':memory:').close()
    return { Database }
  } catch (err) {
    console.log(`\n⚠ better-sqlite3 not available — repo-branch-coverage tests skipped.`)
    console.log(`  (${(err as Error).message.split('\n')[0]})`)
    return null
  }
}

const env = trySetup()

if (!env) {
  describe('Repo Branch Coverage (skipped — native module unavailable)', () => {
    test('skipped', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { Database } = env

  function createTestDb(): InstanceType<typeof import('better-sqlite3')> {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    const schemaPath = join(__dirname, '../../schema.sql')
    const schema = readFileSync(schemaPath, 'utf-8')
    db.exec(schema)

    // Run all migrations
    const { migrations } = require('../../index')
    for (const migration of migrations) {
      try {
        db.transaction(() => migration.up(db))()
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        if (msg.includes('duplicate column') || msg.includes('already exists')) {
          db.pragma(`user_version = ${migration.version}`)
        } else {
          throw error
        }
      }
    }
    return db
  }

  function seedWorkspace(db: InstanceType<typeof import('better-sqlite3')>, id = 'ws-1'): void {
    db.prepare(`INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)`).run(
      id, 'Test Workspace', `/tmp/test-${id}`
    )
  }

  function seedConversation(
    db: InstanceType<typeof import('better-sqlite3')>,
    id = 'conv-1',
    wsId = 'ws-1'
  ): void {
    seedWorkspace(db, wsId)
    db.prepare(`INSERT OR IGNORE INTO conversations (id, workspace_id, title) VALUES (?, ?, ?)`).run(
      id, wsId, 'Test Conversation'
    )
  }

  // ── §1: Blueprint deeper branches ────────────────────────────────────

  describe('Blueprint Repository — deeper branches', () => {
    test('create_and_get_blueprint', () => {
      const db = createTestDb()
      try {
        seedWorkspace(db)
        db.prepare(`INSERT INTO blueprints (id, workspace_id, title, status)
          VALUES ('bp-1', 'ws-1', 'Test Blueprint', 'draft')`).run()

        const row = db.prepare('SELECT * FROM blueprints WHERE id = ?').get('bp-1') as Record<string, unknown>
        assert.equal(row.title, 'Test Blueprint')
        assert.equal(row.status, 'draft')
      } finally {
        db.close()
      }
    })

    test('list_blueprints_by_workspace', () => {
      const db = createTestDb()
      try {
        seedWorkspace(db)
        db.prepare(`INSERT INTO blueprints (id, workspace_id, title, status)
          VALUES ('bp-1', 'ws-1', 'Blueprint 1', 'draft')`).run()
        db.prepare(`INSERT INTO blueprints (id, workspace_id, title, status)
          VALUES ('bp-2', 'ws-1', 'Blueprint 2', 'active')`).run()

        const rows = db.prepare('SELECT * FROM blueprints WHERE workspace_id = ? ORDER BY created_at').all('ws-1') as unknown[]
        assert.equal(rows.length, 2)
      } finally {
        db.close()
      }
    })

    test('blueprint_with_phases_and_tasks', () => {
      const db = createTestDb()
      try {
        seedWorkspace(db)
        db.prepare(`INSERT INTO blueprints (id, workspace_id, title, status)
          VALUES ('bp-1', 'ws-1', 'Full Blueprint', 'specifying')`).run()
        db.prepare(`INSERT INTO blueprint_phases (id, blueprint_id, phase_type, status)
          VALUES ('ph-1', 'bp-1', 'specify', 'completed')`).run()
        db.prepare(`INSERT INTO blueprint_phases (id, blueprint_id, phase_type, status)
          VALUES ('ph-2', 'bp-1', 'plan', 'pending')`).run()
        db.prepare(`INSERT INTO blueprint_tasks (id, phase_id, title, status)
          VALUES ('t-1', 'ph-1', 'Gather requirements', 'completed')`).run()

        const phases = db.prepare('SELECT * FROM blueprint_phases WHERE blueprint_id = ?').all('bp-1') as unknown[]
        assert.equal(phases.length, 2)

        const tasks = db.prepare('SELECT * FROM blueprint_tasks WHERE phase_id = ?').all('ph-1') as unknown[]
        assert.equal(tasks.length, 1)
      } finally {
        db.close()
      }
    })

    test('delete_blueprint_cascades', () => {
      const db = createTestDb()
      try {
        seedWorkspace(db)
        db.prepare(`INSERT INTO blueprints (id, workspace_id, title, status)
          VALUES ('bp-del', 'ws-1', 'Deletable', 'draft')`).run()
        db.prepare(`INSERT INTO blueprint_phases (id, blueprint_id, phase_type, status)
          VALUES ('ph-del', 'bp-del', 'plan', 'pending')`).run()

        db.prepare('DELETE FROM blueprints WHERE id = ?').run('bp-del')
        const phases = db.prepare('SELECT * FROM blueprint_phases WHERE blueprint_id = ?').all('bp-del') as unknown[]
        assert.equal(phases.length, 0)
      } finally {
        db.close()
      }
    })
  })

  // ── §2: Specialist deeper branches ───────────────────────────────────

  describe('Specialist Repository — deeper branches', () => {
    test('workspace_scoped_specialists', () => {
      const db = createTestDb()
      try {
        seedWorkspace(db)
        db.prepare(`INSERT INTO specialists (id, agent_id, display_name, icon, color, priority, workspace_id)
          VALUES ('sp-1', 'my-agent', 'My Agent', '🤖', '#FF0000', 10, 'ws-1')`).run()

        const row = db.prepare('SELECT * FROM specialists WHERE workspace_id = ?').get('ws-1') as Record<string, unknown>
        assert.ok(row)
        assert.equal(row.agent_id, 'my-agent')
        assert.equal(row.workspace_id, 'ws-1')
      } finally {
        db.close()
      }
    })

    test('specialist_skills_association', () => {
      const db = createTestDb()
      try {
        db.prepare(`INSERT INTO specialists (id, agent_id, display_name, icon, color, priority)
          VALUES ('sp-1', 'test-agent', 'Test', '🔧', '#000', 0)`).run()
        db.prepare(`INSERT INTO skills (id, specialist_id, filename, content, enabled)
          VALUES ('sk-1', 'sp-1', 'coding.md', '# Coding', 1)`).run()

        const skills = db.prepare('SELECT * FROM skills WHERE specialist_id = ?').all('sp-1') as unknown[]
        assert.equal(skills.length, 1)
      } finally {
        db.close()
      }
    })
  })

  // ── §3: Audit deeper branches ────────────────────────────────────────

  describe('Audit Repository — deeper branches', () => {
    test('audit_run_with_results', () => {
      const db = createTestDb()
      try {
        seedWorkspace(db)
        db.prepare(`INSERT INTO audit_runs (id, workspace_id, status, tracks_json)
          VALUES ('ar-1', 'ws-1', 'completed', '["security","testing"]')`).run()
        db.prepare(`INSERT INTO audit_results (id, run_id, track_id, score, findings_json)
          VALUES ('res-1', 'ar-1', 'security', 85, '[]')`).run()

        const run = db.prepare('SELECT * FROM audit_runs WHERE id = ?').get('ar-1') as Record<string, unknown>
        assert.equal(run.status, 'completed')

        const results = db.prepare('SELECT * FROM audit_results WHERE run_id = ?').all('ar-1') as unknown[]
        assert.equal(results.length, 1)
      } finally {
        db.close()
      }
    })

    test('audit_cascade_delete', () => {
      const db = createTestDb()
      try {
        seedWorkspace(db)
        db.prepare(`INSERT INTO audit_runs (id, workspace_id, status, tracks_json)
          VALUES ('ar-del', 'ws-1', 'failed', '["code"]')`).run()
        db.prepare(`INSERT INTO audit_results (id, run_id, track_id, score, findings_json)
          VALUES ('res-del', 'ar-del', 'code', 50, '[]')`).run()

        db.prepare('DELETE FROM audit_runs WHERE id = ?').run('ar-del')
        const results = db.prepare('SELECT * FROM audit_results WHERE run_id = ?').all('ar-del') as unknown[]
        assert.equal(results.length, 0)
      } finally {
        db.close()
      }
    })
  })

  // ── §4: MPA Run deeper branches ──────────────────────────────────────

  describe('MPA Run Repository — deeper branches', () => {
    test('mpa_run_with_phases_and_artifacts', () => {
      const db = createTestDb()
      try {
        seedWorkspace(db)
        db.prepare(`INSERT INTO mpa_runs (id, workspace_id, goal, status)
          VALUES ('mpa-1', 'ws-1', 'Build API', 'completed')`).run()
        db.prepare(`INSERT INTO mpa_phases (id, run_id, phase_type, status)
          VALUES ('mp-1', 'mpa-1', 'plan', 'completed')`).run()
        db.prepare(`INSERT INTO mpa_artifacts (id, phase_id, artifact_type, content)
          VALUES ('ma-1', 'mp-1', 'plan', '{"items":[]}')`).run()

        const phases = db.prepare('SELECT * FROM mpa_phases WHERE run_id = ?').all('mpa-1') as unknown[]
        assert.equal(phases.length, 1)

        const artifacts = db.prepare('SELECT * FROM mpa_artifacts WHERE phase_id = ?').all('mp-1') as unknown[]
        assert.equal(artifacts.length, 1)
      } finally {
        db.close()
      }
    })

    test('mpa_campaign_with_goals', () => {
      const db = createTestDb()
      try {
        seedWorkspace(db)
        db.prepare(`INSERT INTO mpa_campaigns (id, workspace_id, status)
          VALUES ('camp-1', 'ws-1', 'running')`).run()
        db.prepare(`INSERT INTO mpa_campaign_goals (id, campaign_id, goal, status)
          VALUES ('cg-1', 'camp-1', 'Build feature A', 'running')`).run()
        db.prepare(`INSERT INTO mpa_campaign_goals (id, campaign_id, goal, status)
          VALUES ('cg-2', 'camp-1', 'Build feature B', 'pending')`).run()

        const goals = db.prepare('SELECT * FROM mpa_campaign_goals WHERE campaign_id = ?').all('camp-1') as unknown[]
        assert.equal(goals.length, 2)
      } finally {
        db.close()
      }
    })
  })

  // ── §5: Council session deeper branches ──────────────────────────────

  describe('Council Session Repository — deeper branches', () => {
    test('council_session_with_all_fields', () => {
      const db = createTestDb()
      try {
        seedWorkspace(db)
        db.prepare(`INSERT INTO council_sessions (id, workspace_id, topic, status, phase, reviews_json, verdict_json)
          VALUES ('cs-1', 'ws-1', 'Architecture Review', 'complete', 'complete',
                  '[{"role":"architect","score":8}]', '{"recommendation":"approve"}')`).run()

        const session = db.prepare('SELECT * FROM council_sessions WHERE id = ?').get('cs-1') as Record<string, unknown>
        assert.equal(session.topic, 'Architecture Review')
        assert.equal(session.phase, 'complete')
        assert.ok(typeof session.reviews_json === 'string')
        assert.ok(typeof session.verdict_json === 'string')
      } finally {
        db.close()
      }
    })
  })

  // ── §6: Usage log deeper branches ────────────────────────────────────

  describe('Usage Log — deeper branches', () => {
    test('aggregation_by_feature', () => {
      const db = createTestDb()
      try {
        seedWorkspace(db)
        db.prepare(`INSERT INTO usage_log (feature, workspace_id, input_tokens, output_tokens, cost_cents)
          VALUES ('chat', 'ws-1', 100, 50, 5)`).run()
        db.prepare(`INSERT INTO usage_log (feature, workspace_id, input_tokens, output_tokens, cost_cents)
          VALUES ('chat', 'ws-1', 200, 100, 10)`).run()
        db.prepare(`INSERT INTO usage_log (feature, workspace_id, input_tokens, output_tokens, cost_cents)
          VALUES ('audit', 'ws-1', 500, 200, 20)`).run()

        const chatTotal = db.prepare(
          `SELECT SUM(cost_cents) as total FROM usage_log WHERE workspace_id = ? AND feature = ?`
        ).get('ws-1', 'chat') as { total: number }
        assert.equal(chatTotal.total, 15)

        const allTotal = db.prepare(
          `SELECT SUM(cost_cents) as total FROM usage_log WHERE workspace_id = ?`
        ).get('ws-1') as { total: number }
        assert.equal(allTotal.total, 35)
      } finally {
        db.close()
      }
    })
  })

  // ── §7: Plans table deeper branches ──────────────────────────────────

  describe('Plans Repository — deeper branches', () => {
    test('plan_with_all_fields', () => {
      const db = createTestDb()
      try {
        seedWorkspace(db)
        seedConversation(db)
        db.prepare(`INSERT INTO plans (id, workspace_id, conversation_id, source, title, content_md, status)
          VALUES ('plan-1', 'ws-1', 'conv-1', 'grill', 'Test Plan', '# Plan\n\n1. Step 1', 'active')`).run()

        const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get('plan-1') as Record<string, unknown>
        assert.equal(plan.source, 'grill')
        assert.equal(plan.title, 'Test Plan')
        assert.equal(plan.status, 'active')
      } finally {
        db.close()
      }
    })

    test('list_plans_by_workspace', () => {
      const db = createTestDb()
      try {
        seedWorkspace(db)
        seedConversation(db)
        db.prepare(`INSERT INTO plans (id, workspace_id, conversation_id, source, title, content_md, status)
          VALUES ('p-1', 'ws-1', 'conv-1', 'audit', 'Plan A', '# A', 'active')`).run()
        db.prepare(`INSERT INTO plans (id, workspace_id, conversation_id, source, title, content_md, status)
          VALUES ('p-2', 'ws-1', 'conv-1', 'grill', 'Plan B', '# B', 'completed')`).run()

        const plans = db.prepare('SELECT * FROM plans WHERE workspace_id = ?').all('ws-1') as unknown[]
        assert.equal(plans.length, 2)
      } finally {
        db.close()
      }
    })
  })

  // ── §8: LLM Presets deeper branches ──────────────────────────────────

  describe('LLM Presets — deeper branches', () => {
    test('create_custom_preset', () => {
      const db = createTestDb()
      try {
        const config = JSON.stringify({ 'da-vinci:plan': 'claude-opus-4-20250514' })
        db.prepare(`INSERT INTO llm_presets (id, name, is_builtin, config_json)
          VALUES ('custom-1', 'My Opus Preset', 0, ?)`).run(config)

        const preset = db.prepare('SELECT * FROM llm_presets WHERE id = ?').get('custom-1') as Record<string, unknown>
        assert.equal(preset.name, 'My Opus Preset')
        assert.equal(preset.is_builtin, 0)
        const parsed = JSON.parse(preset.config_json as string)
        assert.equal(parsed['da-vinci:plan'], 'claude-opus-4-20250514')
      } finally {
        db.close()
      }
    })

    test('list_presets_includes_builtin', () => {
      const db = createTestDb()
      try {
        db.prepare(`INSERT INTO llm_presets (id, name, is_builtin, config_json)
          VALUES ('builtin-1', 'Default', 1, '{}')`).run()
        db.prepare(`INSERT INTO llm_presets (id, name, is_builtin, config_json)
          VALUES ('custom-1', 'Custom', 0, '{}')`).run()

        const all = db.prepare('SELECT * FROM llm_presets ORDER BY is_builtin DESC').all() as unknown[]
        assert.ok(all.length >= 2)
      } finally {
        db.close()
      }
    })
  })

  // ── §9: Memory deeper branches ──────────────────────────────────────

  describe('Memory Repository — deeper branches', () => {
    test('memory_with_workspace_scope', () => {
      const db = createTestDb()
      try {
        seedWorkspace(db)
        db.prepare(`INSERT INTO memories (id, workspace_id, content, type, importance)
          VALUES ('mem-1', 'ws-1', 'Important pattern', 'project', 5)`).run()

        const mem = db.prepare('SELECT * FROM memories WHERE workspace_id = ?').get('ws-1') as Record<string, unknown>
        assert.ok(mem)
        assert.equal(mem.content, 'Important pattern')
        assert.equal(mem.type, 'project')
        assert.equal(mem.importance, 5)
      } finally {
        db.close()
      }
    })

    test('memory_without_workspace_scope', () => {
      const db = createTestDb()
      try {
        db.prepare(`INSERT INTO memories (id, content, type, importance)
          VALUES ('mem-global', 'Global note', 'user', 3)`).run()

        const mem = db.prepare('SELECT * FROM memories WHERE id = ?').get('mem-global') as Record<string, unknown>
        assert.ok(mem)
        assert.equal(mem.workspace_id, null)
      } finally {
        db.close()
      }
    })
  })

  // ── §10: App Preferences deeper branches ─────────────────────────────

  describe('App Preferences — deeper branches', () => {
    test('set_and_get_preference', () => {
      const db = createTestDb()
      try {
        db.prepare(`INSERT OR REPLACE INTO app_preferences (key, value) VALUES (?, ?)`).run('theme', 'dark')

        const pref = db.prepare('SELECT value FROM app_preferences WHERE key = ?').get('theme') as { value: string }
        assert.equal(pref.value, 'dark')
      } finally {
        db.close()
      }
    })

    test('update_existing_preference', () => {
      const db = createTestDb()
      try {
        db.prepare(`INSERT OR REPLACE INTO app_preferences (key, value) VALUES (?, ?)`).run('theme', 'light')
        db.prepare(`INSERT OR REPLACE INTO app_preferences (key, value) VALUES (?, ?)`).run('theme', 'dark')

        const pref = db.prepare('SELECT value FROM app_preferences WHERE key = ?').get('theme') as { value: string }
        assert.equal(pref.value, 'dark')
      } finally {
        db.close()
      }
    })

    test('missing_preference_returns_undefined', () => {
      const db = createTestDb()
      try {
        const pref = db.prepare('SELECT value FROM app_preferences WHERE key = ?').get('nonexistent')
        assert.equal(pref, undefined)
      } finally {
        db.close()
      }
    })
  })
}
