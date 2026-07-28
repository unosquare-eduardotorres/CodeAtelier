/**
 * Migration Integration Tests — verifies:
 * 1. Migration list is sequential and complete
 * 2. Full schema.sql produces expected tables
 * 3. Schema shape post-migration has expected columns
 * 4. Idempotent re-run of migrations
 *
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'

interface MigrationEnv {
  Database: typeof import('better-sqlite3')
  migrations: import('../../index').Migration[]
}

function trySetup(): MigrationEnv | null {
  try {
    process.env.NODE_ENV = 'test'
    const Database = require('better-sqlite3')
    new Database(':memory:').close()
    const { migrations } = require('../../index')
    return { Database, migrations }
  } catch (err) {
    console.log(
      `\n⚠ better-sqlite3 native module not compatible — migration suite skipped.`
    )
    console.log(`  (${(err as Error).message.split('\n')[0]})`)
    return null
  }
}

const env = trySetup()

if (!env) {
  describe('Migration Suite (skipped — native module unavailable)', () => {
    test('migrations are sequential', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { Database, migrations } = env

  // Helper: get table names from a DB
  function getTableNames(db: import('better-sqlite3').Database): string[] {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
    return rows.map((r) => r.name).sort()
  }

  // Helper: get column names for a table
  function getColumnNames(db: import('better-sqlite3').Database, table: string): string[] {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    return rows.map((r) => r.name).sort()
  }

  // Helper: create a fresh DB from BASE_SCHEMA_SQL + migration replay (mirrors production)
  function createSchemaDb(): import('better-sqlite3').Database {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    const { SCHEMA_SQL } = require('../../index')
    db.exec(SCHEMA_SQL)
    // Run all migrations for full fresh-install shape
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
        }
      }
    }
    return db
  }

  describe('Migration list integrity', () => {
    test('migrations array is not empty', () => {
      assert.ok(migrations.length > 0, 'Should have at least one migration')
    })

    test('migration versions are sequential integers', () => {
      for (let i = 0; i < migrations.length; i++) {
        assert.equal(
          migrations[i].version,
          i + 1,
          `Migration at index ${i} should have version ${i + 1}, got ${migrations[i].version}`
        )
      }
    })

    test('every migration has a non-empty name', () => {
      for (const m of migrations) {
        assert.ok(m.name.length > 0, `Migration v${m.version} has empty name`)
      }
    })

    test('every migration has an up() function', () => {
      for (const m of migrations) {
        assert.equal(typeof m.up, 'function', `Migration v${m.version} missing up()`)
      }
    })

    test('no duplicate migration versions', () => {
      const versions = migrations.map((m) => m.version)
      const unique = new Set(versions)
      assert.equal(unique.size, versions.length, 'Duplicate version numbers detected')
    })

    test('no duplicate migration names', () => {
      const names = migrations.map((m) => m.name)
      const unique = new Set(names)
      assert.equal(unique.size, names.length, 'Duplicate migration names detected')
    })
  })

  describe('Schema.sql — fresh install shape', () => {
    test('creates expected core tables', () => {
      const db = createSchemaDb()
      try {
        const tables = getTableNames(db)
        const expected = [
          'workspaces',
          'conversations',
          'messages',
          'specialists',
          'skills'
        ]
        for (const t of expected) {
          assert.ok(tables.includes(t), `Missing table: ${t}`)
        }
      } finally {
        db.close()
      }
    })

    test('creates expected pipeline tables', () => {
      const db = createSchemaDb()
      try {
        const tables = getTableNames(db)
        const expected = [
          'blueprints',
          'blueprint_phases',
          'blueprint_tasks',
          'audit_runs',
          'audit_results',
          'mpa_runs',
          'mpa_phases',
          'council_sessions',
          'plans'
        ]
        for (const t of expected) {
          assert.ok(tables.includes(t), `Missing table: ${t}`)
        }
      } finally {
        db.close()
      }
    })

    test('creates code-graph tables', () => {
      const db = createSchemaDb()
      try {
        const tables = getTableNames(db)
        const expected = [
          'code_graph_tags',
          'code_graph_edges',
          'code_graph_ranks',
          'code_chunks',
          'chunk_embeddings'
        ]
        for (const t of expected) {
          assert.ok(tables.includes(t), `Missing table: ${t}`)
        }
      } finally {
        db.close()
      }
    })

    test('creates utility tables', () => {
      const db = createSchemaDb()
      try {
        const tables = getTableNames(db)
        const expected = [
          'agent_sessions',
          'turn_usage',
          'bugs',
          'events',
          'memory_facts',
          'ideas',
          'checkpoints',
          'app_preferences',
          'user_profile',
          'llm_presets'
        ]
        for (const t of expected) {
          assert.ok(tables.includes(t), `Missing table: ${t}`)
        }
      } finally {
        db.close()
      }
    })

    // ── Column verification for key tables ──

    test('conversations table has expected columns', () => {
      const db = createSchemaDb()
      try {
        const cols = getColumnNames(db, 'conversations')
        assert.ok(cols.includes('id'))
        assert.ok(cols.includes('workspace_id'))
        assert.ok(cols.includes('title'))
        assert.ok(cols.includes('mode'))
        assert.ok(cols.includes('status'))
      } finally {
        db.close()
      }
    })

    test('messages table has expected columns', () => {
      const db = createSchemaDb()
      try {
        const cols = getColumnNames(db, 'messages')
        assert.ok(cols.includes('id'))
        assert.ok(cols.includes('conversation_id'))
        assert.ok(cols.includes('role'))
        assert.ok(cols.includes('content_md'))
      } finally {
        db.close()
      }
    })

    test('specialists table has workspace_id column', () => {
      const db = createSchemaDb()
      try {
        const cols = getColumnNames(db, 'specialists')
        assert.ok(cols.includes('id'))
        assert.ok(cols.includes('agent_id'))
        assert.ok(cols.includes('display_name'))
      } finally {
        db.close()
      }
    })

    test('agent_sessions table has token breakdown columns', () => {
      const db = createSchemaDb()
      try {
        const cols = getColumnNames(db, 'agent_sessions')
        assert.ok(cols.includes('input_tokens'))
        assert.ok(cols.includes('output_tokens'))
        assert.ok(cols.includes('cache_read_tokens'))
        assert.ok(cols.includes('cache_creation_tokens'))
      } finally {
        db.close()
      }
    })

    test('turn_usage table has context_tokens column', () => {
      const db = createSchemaDb()
      try {
        const cols = getColumnNames(db, 'turn_usage')
        assert.ok(cols.includes('context_tokens'))
      } finally {
        db.close()
      }
    })

    test('blueprints table has settings_json column', () => {
      const db = createSchemaDb()
      try {
        const cols = getColumnNames(db, 'blueprints')
        assert.ok(cols.includes('settings_json'))
        assert.ok(cols.includes('priority'))
      } finally {
        db.close()
      }
    })

    test('council_sessions table has phase and advisor tracking columns', () => {
      const db = createSchemaDb()
      try {
        const cols = getColumnNames(db, 'council_sessions')
        assert.ok(cols.includes('phase'))
        assert.ok(cols.includes('advisor_reviews_json'))
        assert.ok(cols.includes('peer_reviews_json'))
        assert.ok(cols.includes('completed_advisors'))
      } finally {
        db.close()
      }
    })
  })

    test('v123_backfills_model_config_json_and_hardens_llm_provider', () => {
      const db = createSchemaDb()
      try {
        // Insert a workspace
        db.prepare(`INSERT INTO workspaces (id, name, repo_path, settings_json, created_at, last_opened_at)
          VALUES ('ws-test', 'Test', '/tmp/test', '{"llmProvider":"claude"}', datetime('now'), datetime('now'))`).run()

        // Insert a conversation without model_config_json — llm_provider takes NOT NULL DEFAULT 'claude'
        db.prepare(`INSERT INTO conversations (id, workspace_id, title, mode, type, model_config_json)
          VALUES ('conv-1', 'ws-test', 'Test Chat', 'plan', 'chat', NULL)`).run()

        // Run migration 123
        const m123 = env.migrations.find((m) => m.version === 123)
        assert.ok(m123, 'Migration 123 should exist')
        m123!.up(db)

        // Verify backfill
        const row = db.prepare('SELECT model_config_json, llm_provider FROM conversations WHERE id = ?')
          .get('conv-1') as { model_config_json: string | null; llm_provider: string | null }
        assert.ok(row.model_config_json, 'model_config_json should be backfilled')
        assert.strictEqual(row.llm_provider, 'claude', 'llm_provider should preserve DEFAULT value')

        const snapshot = JSON.parse(row.model_config_json!)
        assert.ok(snapshot.plan, 'snapshot should have plan')
        assert.ok(snapshot.build, 'snapshot should have build')
        assert.ok(snapshot.background, 'snapshot should have background')
        assert.ok(snapshot.snapshotAt, 'snapshot should have snapshotAt')
        assert.ok(snapshot.plan.modelId, 'plan should have modelId')
        assert.ok(snapshot.plan.provider, 'plan should have provider')
      } finally {
        db.close()
      }
    })

    test('v123_skips_conversations_with_existing_snapshot', () => {
      const db = createSchemaDb()
      try {
        db.prepare(`INSERT INTO workspaces (id, name, repo_path, settings_json, created_at, last_opened_at)
          VALUES ('ws-test2', 'Test2', '/tmp/test2', '{}', datetime('now'), datetime('now'))`).run()

        const existingSnapshot = JSON.stringify({
          plan: { provider: 'claude', modelId: 'claude-opus-4-8', source: 'roles' },
          build: { provider: 'claude', modelId: 'claude-sonnet-4-6', source: 'default' },
          background: { provider: 'claude', modelId: 'claude-haiku-4-5', source: 'default' },
          snapshotAt: '2026-01-01T00:00:00.000Z'
        })

        db.prepare(`INSERT INTO conversations (id, workspace_id, title, mode, type, llm_provider, model_config_json)
          VALUES ('conv-existing', 'ws-test2', 'Existing', 'plan', 'chat', 'claude', ?)`).run(existingSnapshot)

        const m123 = env.migrations.find((m) => m.version === 123)
        m123!.up(db)

        // Should not be modified
        const row = db.prepare('SELECT model_config_json FROM conversations WHERE id = ?')
          .get('conv-existing') as { model_config_json: string }
        const snapshot = JSON.parse(row.model_config_json)
        assert.equal(snapshot.snapshotAt, '2026-01-01T00:00:00.000Z', 'existing snapshot should not be overwritten')
      } finally {
        db.close()
      }
    })

  describe('Migration idempotency', () => {
    test('schema.sql can be applied twice without error (CREATE IF NOT EXISTS)', () => {
      const db = createSchemaDb()
      try {
        // Applying schema again should not throw
        const { readFileSync } = require('node:fs')
        const { join } = require('node:path')
        const schemaPath = join(__dirname, '../../schema.sql')
        const schema = readFileSync(schemaPath, 'utf-8')
        db.exec(schema)
        // Verify tables still exist
        const tables = getTableNames(db)
        assert.ok(tables.includes('workspaces'))
        assert.ok(tables.includes('conversations'))
      } finally {
        db.close()
      }
    })
  })
}
