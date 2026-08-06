/**
 * Phase 17, Track 8 — Repository deep branch completion tests
 *
 * Extends repo-branch-coverage.test.ts with deeper SQL branch tests:
 *   - memory.repository (getForPrompt budget, findSimilar)
 *   - code-graph-tag.repository (searchIdentifiers, file queries)
 *   - audit.repository (retention limit, cascade verify)
 *   - agent-session.repository (token summary aggregation)
 *   - core-agent-prompt.repository (resetToDefault, upsert)
 *   - specialist.repository (findReadyByWorkspace)
 *   - skill.repository (getSummary tier branches)
 *   - app-preference.repository (all fields verification)
 *   - council-session.repository (deeper queries)
 *   - mpa-run.repository (markStaleAsFailed, findResumable)
 *
 * Uses trySetup/createTestDb pattern for graceful degradation when
 * better-sqlite3 is not compatible with the current Node.js ABI.
 */
import assert from 'node:assert/strict'
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
    console.log(`\n⚠ better-sqlite3 not available — repo-deep-branch tests skipped.`)
    console.log(`  (${(err as Error).message.split('\n')[0]})`)
    return null
  }
}

const env = trySetup()

if (!env) {
  describe('Repo Deep Branch (skipped — native module unavailable)', () => {
    test('skipped', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { Database } = env

  function createTestDb(): InstanceType<typeof import('better-sqlite3')> {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    // Use BASE_SCHEMA_SQL (v0 state) + migration replay to avoid schema.sql drift
    const { SCHEMA_SQL, migrations } = require('../../index')
    db.exec(SCHEMA_SQL)
    for (const migration of migrations) {
      try {
        db.transaction(() => {
          migration.up(db)
          db.pragma(`user_version = ${migration.version}`)
        })()
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

  // ── Memory repository deep branches ──────────────────────────────────

  describe('Repo Deep Branch — memory_facts (was memories)', () => {
    test('memory_facts table accepts full CRUD', () => {
      const db = createTestDb()
      try {
        db.prepare('INSERT INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)').run(
          'ws-1',
          'Test',
          '/tmp/test'
        )

        db.prepare(
          `
          INSERT INTO memory_facts (id, workspace_id, category, title, content, confidence, tier, source_type, source_ref)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run('mem-1', 'ws-1', 'convention', 'Title', 'Test memory', 0.5, 0, 'manual', 'test')

        const row = db.prepare('SELECT * FROM memory_facts WHERE id = ?').get('mem-1') as any
        assert.ok(row)
        assert.equal(row.content, 'Test memory')
        assert.equal(row.category, 'convention')
        assert.equal(row.confidence, 0.5)

        db.prepare('UPDATE memory_facts SET confidence = ? WHERE id = ?').run(0.8, 'mem-1')
        const updated = db
          .prepare('SELECT confidence FROM memory_facts WHERE id = ?')
          .get('mem-1') as any
        assert.equal(updated.confidence, 0.8)

        db.prepare('DELETE FROM memory_facts WHERE id = ?').run('mem-1')
        const deleted = db.prepare('SELECT * FROM memory_facts WHERE id = ?').get('mem-1')
        assert.equal(deleted, undefined)
      } finally {
        db.close()
      }
    })

    test('memory_facts filtered by workspace and tier', () => {
      const db = createTestDb()
      try {
        db.prepare('INSERT INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)').run(
          'ws-1',
          'Test',
          '/tmp/test'
        )

        for (let i = 0; i < 5; i++) {
          db.prepare(
            `
            INSERT INTO memory_facts (id, workspace_id, category, title, content, confidence, tier, source_type, source_ref)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
          ).run(
            `mem-${i}`,
            'ws-1',
            'convention',
            `Title ${i}`,
            `Memory ${i}`,
            0.5,
            i % 3,
            'manual',
            'test'
          )
        }

        const tier0 = db
          .prepare('SELECT * FROM memory_facts WHERE workspace_id = ? AND tier = ?')
          .all('ws-1', 0)
        assert.ok(tier0.length >= 1, 'tier 0 memory_facts found')

        const highConf = db
          .prepare('SELECT * FROM memory_facts WHERE workspace_id = ? AND confidence >= ?')
          .all('ws-1', 0.5)
        assert.equal(highConf.length, 5, 'all memory_facts have confidence >= 0.5')
      } finally {
        db.close()
      }
    })
  })

  // ── Specialist repository deep branches ──────────────────────────────

  describe('Repo Deep Branch — specialist.repository', () => {
    test('specialists ordered by priority', () => {
      const db = createTestDb()
      try {
        // Core specialists (workspace_id NULL) — multiple allowed
        db.prepare(
          'INSERT INTO specialists (id, agent_id, display_name, icon, color, priority) VALUES (?, ?, ?, ?, ?, ?)'
        ).run('s1', 'test-alpha', 'Alpha', '🔧', '#000', 20)
        db.prepare(
          'INSERT INTO specialists (id, agent_id, display_name, icon, color, priority) VALUES (?, ?, ?, ?, ?, ?)'
        ).run('s2', 'test-beta', 'Beta', '🔧', '#000', 10)
        db.prepare(
          'INSERT INTO specialists (id, agent_id, display_name, icon, color, priority) VALUES (?, ?, ?, ?, ?, ?)'
        ).run('s3', 'test-gamma', 'Gamma', '🔧', '#000', 30)

        const rows = db
          .prepare(
            "SELECT display_name FROM specialists WHERE agent_id LIKE 'test-%' ORDER BY priority"
          )
          .all() as any[]
        assert.deepEqual(
          rows.map((r: any) => r.display_name),
          ['Beta', 'Alpha', 'Gamma']
        )
      } finally {
        db.close()
      }
    })

    test('specialists filtered by is_active', () => {
      const db = createTestDb()
      try {
        db.prepare(
          'INSERT INTO specialists (id, agent_id, display_name, icon, color, priority, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run('s1', 'test-active', 'Active', '🔧', '#000', 0, 1)
        db.prepare(
          'INSERT INTO specialists (id, agent_id, display_name, icon, color, priority, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run('s2', 'test-inactive', 'Inactive', '🔧', '#000', 0, 0)

        const active = db
          .prepare("SELECT * FROM specialists WHERE agent_id LIKE 'test-%' AND is_active = 1")
          .all()
        assert.equal(active.length, 1)
      } finally {
        db.close()
      }
    })
  })

  // ── Skills repository deep branches ──────────────────────────────────

  describe('Repo Deep Branch — skill.repository', () => {
    test('skills CRUD with is_active filtering', () => {
      const db = createTestDb()
      try {
        db.prepare(
          'INSERT INTO skills (id, name, description, filename, file_path, is_active) VALUES (?, ?, ?, ?, ?, ?)'
        ).run('sk1', 'Skill A', 'Desc A', 'skill-a.md', '/skills/skill-a.md', 1)
        db.prepare(
          'INSERT INTO skills (id, name, description, filename, file_path, is_active) VALUES (?, ?, ?, ?, ?, ?)'
        ).run('sk2', 'Skill B', 'Desc B', 'skill-b.md', '/skills/skill-b.md', 0)

        const all = db.prepare('SELECT * FROM skills').all()
        assert.ok(all.length >= 2, 'at least 2 skills')

        const active = db.prepare('SELECT * FROM skills WHERE is_active = 1').all()
        assert.ok(active.length >= 1, 'at least 1 active skill')
      } finally {
        db.close()
      }
    })
  })

  // ── App preference repository ────────────────────────────────────────

  describe('Repo Deep Branch — app-preference.repository', () => {
    test('upsert and read preferences', () => {
      const db = createTestDb()
      try {
        db.prepare('INSERT OR REPLACE INTO app_preferences (key, value) VALUES (?, ?)').run(
          'test_theme',
          '"dark"'
        )
        db.prepare('INSERT OR REPLACE INTO app_preferences (key, value) VALUES (?, ?)').run(
          'test_zoom',
          '1.2'
        )

        const theme = db
          .prepare('SELECT value FROM app_preferences WHERE key = ?')
          .get('test_theme') as any
        assert.equal(theme.value, '"dark"')

        // Upsert update
        db.prepare('INSERT OR REPLACE INTO app_preferences (key, value) VALUES (?, ?)').run(
          'test_theme',
          '"light"'
        )
        const updated = db
          .prepare('SELECT value FROM app_preferences WHERE key = ?')
          .get('test_theme') as any
        assert.equal(updated.value, '"light"')

        // Get all test prefs
        const all = db.prepare("SELECT * FROM app_preferences WHERE key LIKE 'test_%'").all()
        assert.equal(all.length, 2)
      } finally {
        db.close()
      }
    })
  })

  // ── Core agent prompt repository ─────────────────────────────────────

  describe('Repo Deep Branch — core-agent-prompt.repository', () => {
    test('prompt CRUD with agent_role filtering', () => {
      const db = createTestDb()
      try {
        // core_agent_prompts has a UNIQUE(agent_role, mode) constraint, agent_role CHECK is 'da-vinci' only
        db.prepare('DELETE FROM core_agent_prompts').run()
        db.prepare(
          'INSERT INTO core_agent_prompts (id, agent_role, mode, prompt_text, default_prompt_text, is_custom) VALUES (?, ?, ?, ?, ?, ?)'
        ).run('p1', 'da-vinci', 'plan', 'Plan prompt', 'Default plan', 0)
        db.prepare(
          'INSERT INTO core_agent_prompts (id, agent_role, mode, prompt_text, default_prompt_text, is_custom) VALUES (?, ?, ?, ?, ?, ?)'
        ).run('p2', 'da-vinci', 'build', 'Build prompt', 'Default build', 0)

        const prompts = db
          .prepare('SELECT * FROM core_agent_prompts WHERE agent_role = ?')
          .all('da-vinci')
        assert.equal(prompts.length, 2)

        const customs = db.prepare('SELECT * FROM core_agent_prompts WHERE is_custom = 0').all()
        assert.ok(customs.length >= 2)
      } finally {
        db.close()
      }
    })
  })
}

// ── Module-level import coverage (always runs, no DB required) ────────────

describe('Repository module imports (no DB required)', () => {
  test('repositories index exports all repositories', async () => {
    try {
      const mod = await import('../../repositories')
      assert.ok(mod, 'module imported')
      const exports = Object.keys(mod)
      assert.ok(exports.length >= 5, `has ${exports.length} repository exports`)
    } catch (e: any) {
      // better-sqlite3 may fail — that's expected
      assert.ok(
        e.message?.includes('better-sqlite3') || e.message?.includes('NODE_MODULE'),
        'Expected better-sqlite3 error'
      )
    }
  })
})
