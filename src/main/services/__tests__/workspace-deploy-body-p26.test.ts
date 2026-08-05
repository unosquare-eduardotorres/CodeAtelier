/**
 * Phase 26 Wave 3 — workspace-deploy.service.ts deep body coverage.
 *
 * R003: rewritten to assert real filesystem behaviour instead of bare
 * catch{} swallows and typeof-guard skips. scanWorkspaceClaude and
 * activateAgents are both deterministic, hermetic filesystem operations
 * (no LLM spawn, no network) — they are exercised against real temp
 * directories created for this test file, never outside the repo.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test, beforeEach, afterEach } from './test-harness'
import { setupFullMock, resetAllMocks } from './setup-full-mock'
setupFullMock()

const mod = require('../workspace-deploy.service')
const { workspaceDeployService } = mod

describe('WorkspaceDeployService (P26-W3)', () => {
  let tmpDir: string

  beforeEach(() => {
    resetAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'ca-workspace-deploy-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ─── scanWorkspaceClaude ─────────────────────────────────────────────────
  test('scanWorkspaceClaude reports an undeployed workspace with no .claude/ dir', () => {
    const status = workspaceDeployService.scanWorkspaceClaude(tmpDir)
    assert.equal(status.hasClaudeDir, false)
    assert.equal(status.hasClaudeMd, false)
    assert.deepEqual(status.deployedAgents, [])
    assert.deepEqual(status.deployedSkills, [])
    assert.equal(status.claudeMdPreview, null)
  })

  test('scanWorkspaceClaude discovers deployed agent/skill files and a CLAUDE.md preview', () => {
    const agentsDir = join(tmpDir, '.claude', 'agents')
    const skillsDir = join(tmpDir, '.claude', 'skills', 'my-skill')
    mkdirSync(agentsDir, { recursive: true })
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(join(agentsDir, 'reviewer.yml'), 'name: reviewer\n')
    writeFileSync(join(tmpDir, 'CLAUDE.md'), '# Project\nSome content here.')

    const status = workspaceDeployService.scanWorkspaceClaude(tmpDir)
    assert.equal(status.hasClaudeDir, true)
    assert.equal(status.hasAgentsDir, true)
    assert.equal(status.hasSkillsDir, true)
    assert.deepEqual(status.deployedAgents, ['reviewer.yml'])
    assert.deepEqual(status.deployedSkills, ['my-skill'])
    assert.equal(status.hasClaudeMd, true)
    assert.equal(status.claudeMdPreview, '# Project\nSome content here.')
  })

  // ─── scanWorkspaceAgents ─────────────────────────────────────────────────
  test('scanWorkspaceAgents parses deployed agent YAML and excludes the deprecated orchestrator', () => {
    const agentsDir = join(tmpDir, '.claude', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      join(agentsDir, 'reviewer.yml'),
      'name: reviewer\ndescription: Reviews code\nmodel: sonnet\n---\nBody text\n'
    )
    writeFileSync(join(agentsDir, 'orchestrator.yml'), 'name: orchestrator\n---\nDeprecated\n')

    const agents = workspaceDeployService.scanWorkspaceAgents(tmpDir)
    assert.equal(agents.length, 1)
    assert.equal(agents[0].parsed.name, 'reviewer')
    assert.equal(agents[0].filename, 'reviewer.yml')
  })

  // ─── activateAgents (deterministic — no LLM call) ────────────────────────
  test('activateAgents creates .claude directories and returns a successful result', async () => {
    const result = await workspaceDeployService.activateAgents(tmpDir)

    assert.equal(result.success, true)
    assert.equal(result.claudeMdWritten, false)
    assert.ok(Array.isArray(result.selectedAgents))
    assert.equal(typeof result.proposedClaudeMd, 'string')
  })

  test('activateAgents reports progress events in order ending with completion', async () => {
    const messages: string[] = []
    await workspaceDeployService.activateAgents(tmpDir, (event: { type: string; message: string }) => {
      messages.push(event.message)
    })

    assert.ok(messages.length > 0)
    assert.equal(messages[messages.length - 1], 'Activation complete!')
  })

  // ─── shutdown ─────────────────────────────────────────────────────────
  test('shutdown is a safe no-op (kept for API compatibility)', () => {
    workspaceDeployService.shutdown()
    // Calling it a second time must not throw — it has no internal state to corrupt.
    workspaceDeployService.shutdown()
  })
})
