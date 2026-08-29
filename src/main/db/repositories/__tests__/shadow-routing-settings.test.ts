/**
 * Pure tests for mergeShadowRoutingSettings — the shadow (worktree) workspace
 * model-routing inheritance rule. No DB required.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { mergeShadowRoutingSettings } from '../workspace.repository'
import type { WorkspaceSettings } from '../../../../shared/types'

describe('mergeShadowRoutingSettings', () => {
  test('inherits routing keys the shadow lacks', () => {
    const parent: WorkspaceSettings = {
      llmProvider: 'glm',
      modelRoles: { 'blueprint:clarify': { provider: 'glm', model: 'glm-5.3' } },
      costPreference: 'economy',
      localLlmBackend: 'omlx',
      glmBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
      glmApiKey: 'sk-test',
      glmModel: 'glm-5.3',
      glmContextLimit: 200_000,
      openCodeBaseUrl: 'http://localhost:4096',
      openCodeApiKey: 'oc-key'
    }
    const merged = mergeShadowRoutingSettings({}, parent)
    assert.equal(merged.llmProvider, 'glm')
    assert.deepEqual(merged.modelRoles, parent.modelRoles)
    assert.equal(merged.costPreference, 'economy')
    assert.equal(merged.localLlmBackend, 'omlx')
    assert.equal(merged.glmBaseUrl, parent.glmBaseUrl)
    assert.equal(merged.glmApiKey, parent.glmApiKey)
    assert.equal(merged.glmModel, parent.glmModel)
    assert.equal(merged.glmContextLimit, parent.glmContextLimit)
    assert.equal(merged.openCodeBaseUrl, parent.openCodeBaseUrl)
    assert.equal(merged.openCodeApiKey, parent.openCodeApiKey)
  })

  test("shadow's own values always win", () => {
    const parent: WorkspaceSettings = { llmProvider: 'glm', glmModel: 'glm-5.3' }
    const shadow: WorkspaceSettings = { llmProvider: 'claude', glmModel: 'claude-sonnet-5' }
    const merged = mergeShadowRoutingSettings(shadow, parent)
    assert.equal(merged.llmProvider, 'claude')
    assert.equal(merged.glmModel, 'claude-sonnet-5')
  })

  test('null shadow values are treated as absent and inherited', () => {
    const parent: WorkspaceSettings = { llmProvider: 'glm' }
    const shadow = { llmProvider: null } as unknown as WorkspaceSettings
    const merged = mergeShadowRoutingSettings(shadow, parent)
    assert.equal(merged.llmProvider, 'glm')
  })

  test('non-routing keys are NOT inherited', () => {
    const parent: WorkspaceSettings = {
      gateCommands: { build: { command: 'npm run build' } },
      githubToken: 'ghp-secret',
      jiraHost: 'https://jira.example.com',
      watcherEnabled: true,
      theme: 'dark',
      leadReviewPass: true,
      memoryEnabled: false,
      communicationTone: 'calm'
    }
    const merged = mergeShadowRoutingSettings({}, parent)
    assert.equal('gateCommands' in merged, false, 'gate-command overrides stay per-workspace')
    assert.equal('githubToken' in merged, false, 'integration tokens stay per-workspace')
    assert.equal('jiraHost' in merged, false)
    assert.equal('watcherEnabled' in merged, false)
    assert.equal('theme' in merged, false)
    assert.equal('leadReviewPass' in merged, false)
    assert.equal('memoryEnabled' in merged, false)
    assert.equal('communicationTone' in merged, false)
  })

  test('prefix families: glm*/openCode*/localLlm* inherit, non-matching lookalikes do not', () => {
    const parent = {
      glmEndpointMode: 'coding-plan',
      glmDiscoveredModels: ['glm-5.3'],
      openCodeProvider: 'opencode',
      localLlmStrategy: 'balanced',
      xglmThing: 'not-a-real-key',
      myOpenCodeThing: 'not-a-real-key',
      elocalLlmThing: 'not-a-real-key'
    } as unknown as WorkspaceSettings
    const merged = mergeShadowRoutingSettings({}, parent)
    assert.equal(merged.glmEndpointMode, 'coding-plan')
    assert.deepEqual(merged.glmDiscoveredModels, ['glm-5.3'])
    assert.equal(merged.openCodeProvider, 'opencode')
    assert.equal((merged as Record<string, unknown>).localLlmStrategy, 'balanced')
    assert.equal('xglmThing' in merged, false)
    assert.equal('myOpenCodeThing' in merged, false)
    assert.equal('elocalLlmThing' in merged, false)
  })

  test('empty parent inherits nothing; empty shadow inherits everything routing', () => {
    assert.deepEqual(mergeShadowRoutingSettings({}, {}), {})
    const parent: WorkspaceSettings = { llmProvider: 'glm', glmModel: 'glm-5.3' }
    const merged = mergeShadowRoutingSettings({}, parent)
    assert.deepEqual(merged, parent)
  })

  test('modelOverrides (routing) inherits while other record-valued keys do not', () => {
    const parent = {
      modelOverrides: { chat: 'glm-5.3' },
      mcpOverrides: { repomap: false }
    } as unknown as WorkspaceSettings
    const merged = mergeShadowRoutingSettings({}, parent)
    assert.deepEqual((merged as Record<string, unknown>).modelOverrides, { chat: 'glm-5.3' })
    assert.equal('mcpOverrides' in merged, false)
  })
})
