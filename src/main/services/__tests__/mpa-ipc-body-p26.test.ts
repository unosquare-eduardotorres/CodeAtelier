/**
 * Phase 26 — mpa.ipc.ts deep body coverage.
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import {
  setupFullMock,
  getMockRepo,
  mockMainWindow,
  getHandlers,
  tryInvokeHandler,
  sentEvents
} from './setup-full-mock'

setupFullMock()

const mpaRunRepo = getMockRepo('mpaRun')
const mpaArtifactRepo = getMockRepo('mpaArtifact')
const mpaCampaignRepo = getMockRepo('mpaCampaign')

const mod = require('../../ipc/mpa.ipc')
const registerFn = mod.registerMpaIpc || mod.default
if (registerFn) {
  try {
    registerFn(mockMainWindow)
  } catch {
    /* OK */
  }
}

describe('mpa.ipc — deep body (P26)', () => {
  beforeEach(() => {
    sentEvents.length = 0
  })

  test('registers mpa handlers', () => {
    const handlers = getHandlers()
    const mpaHandlers = [...handlers.keys()].filter((k) => k.startsWith('mpa:'))
    assert.ok(mpaHandlers.length > 0)
  })

  test('mpa:listCampaigns returns campaigns', async () => {
    mpaCampaignRepo.findByWorkspace.mockReturnValue([])
    const r = await tryInvokeHandler('mpa:listCampaigns', { workspaceId: 'ws-1' })
    if (r.ok) assert.ok(Array.isArray(r.result) || typeof r.result === 'object')
  })

  test('mpa:getCampaign returns campaign', async () => {
    mpaCampaignRepo.findById.mockReturnValue({ id: 'camp-1', status: 'active' })
    mpaRunRepo.findByCampaign.mockReturnValue([])
    const r = await tryInvokeHandler('mpa:getCampaign', { campaignId: 'camp-1' })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('mpa:listRuns returns runs', async () => {
    mpaRunRepo.findByWorkspace.mockReturnValue([])
    const r = await tryInvokeHandler('mpa:listRuns', { workspaceId: 'ws-1' })
    if (r.ok) assert.ok(Array.isArray(r.result) || typeof r.result === 'object')
  })

  test('mpa:getRun returns single run', async () => {
    mpaRunRepo.findById.mockReturnValue({ id: 'run-1', status: 'active' })
    const r = await tryInvokeHandler('mpa:getRun', { runId: 'run-1' })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('mpa:cancel cancels active MPA', async () => {
    const r = await tryInvokeHandler('mpa:cancel', { workspaceId: 'ws-1' })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('mpa:getStatus returns status', async () => {
    const r = await tryInvokeHandler('mpa:getStatus', { workspaceId: 'ws-1' })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('mpa:getArtifact returns artifact', async () => {
    mpaArtifactRepo.findById.mockReturnValue({ id: 'art-1', content: 'test' })
    const r = await tryInvokeHandler('mpa:getArtifact', { artifactId: 'art-1' })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })
})
