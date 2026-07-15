/**
 * IPC handlers for the E2E testing feature.
 *
 * All handlers start with validateSender(event) per security convention.
 */

import { ipcMain, type BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalString } from './validate-args'
import { e2eRunnerService, preflight } from '../services/e2e-testing/e2e-runner.service'
import { getScenarioSummaries } from '../services/e2e-testing/scenario-catalog'
import { fixtureManager } from '../services/e2e-testing/fixture-manager'
import { e2eTestRunRepository, e2eTestResultRepository, workspaceRepository } from '../db/repositories'

export function registerTestingIpc(mainWindow: BrowserWindow): void {
  e2eRunnerService.setMainWindow(mainWindow)

  // Recover orphaned runs left in 'running' state from a prior crash/kill.
  // This must run early (before any IPC calls) so the UI never sees stale 'running' runs.
  try {
    const recovered = e2eTestRunRepository.recoverOrphanedRuns()
    if (recovered > 0) {
      console.log(`[Testing] Recovered ${recovered} orphaned E2E test run(s) from prior session`)
    }
  } catch (e) {
    console.warn('[Testing] Orphan recovery failed (non-fatal):', e)
  }

  // ── List all scenarios (implemented + planned) ──
  ipcMain.handle(IPC_CHANNELS.TESTING_LIST_SCENARIOS, (event) => {
    validateSender(event)
    return getScenarioSummaries()
  })

  // ── Preflight check: is oMLX reachable? ──
  ipcMain.handle(IPC_CHANNELS.TESTING_PREFLIGHT, async (event, rawArgs?: unknown) => {
    validateSender(event)
    const workspaceId = rawArgs != null
      ? optionalString(requireObject(rawArgs, IPC_CHANNELS.TESTING_PREFLIGHT), 'workspaceId', IPC_CHANNELS.TESTING_PREFLIGHT)
      : undefined
    return preflight(workspaceId)
  })

  // ── Run scenarios ──
  ipcMain.handle(IPC_CHANNELS.TESTING_RUN, async (event, rawArgs: unknown) => {
    validateSender(event)

    const ch = IPC_CHANNELS.TESTING_RUN

    // Args are optional — if provided, extract fields
    if (rawArgs !== undefined && rawArgs !== null) {
      const args = requireObject(rawArgs, ch)
      const category = optionalString(args, 'category', ch)

      // Validate scenarioIds as optional string array
      let scenarioIds: string[] | undefined
      if (args.scenarioIds !== undefined) {
        if (!Array.isArray(args.scenarioIds)) {
          throw new Error(`[${ch}] scenarioIds must be an array`)
        }
        for (const item of args.scenarioIds) {
          if (typeof item !== 'string') {
            throw new Error(`[${ch}] scenarioIds must contain only strings`)
          }
        }
        scenarioIds = args.scenarioIds as string[]
      }

      const workspaceId = optionalString(args, 'workspaceId', ch)
      const forceTools = args.forceTools === true
      return { runId: await e2eRunnerService.run({ scenarioIds, category, workspaceId, forceTools }) }
    }

    return { runId: await e2eRunnerService.run() }
  })

  // ── Requeue failed scenarios from a previous run ──
  ipcMain.handle(IPC_CHANNELS.TESTING_REQUEUE_FAILED, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.TESTING_REQUEUE_FAILED
    const args = requireObject(rawArgs, ch)
    const runId = requireString(args, 'runId', ch)
    const workspaceId = optionalString(args, 'workspaceId', ch)
    return { runId: await e2eRunnerService.requeueFailed(runId, workspaceId) }
  })

  // ── Resume an interrupted run (re-runs queued/error scenarios as a new run) ──
  ipcMain.handle(IPC_CHANNELS.TESTING_RESUME_RUN, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.TESTING_RESUME_RUN
    const args = requireObject(rawArgs, ch)
    const runId = requireString(args, 'runId', ch)
    const workspaceId = optionalString(args, 'workspaceId', ch)
    const newRunId = await e2eRunnerService.resumeRun(runId, workspaceId ?? undefined)
    return { runId: newRunId }
  })

  // ── Cancel current run ──
  ipcMain.handle(IPC_CHANNELS.TESTING_CANCEL, (event) => {
    validateSender(event)
    e2eRunnerService.cancel()
  })

  // ── Get all runs (resolves fixture workspace internally when no workspaceId) ──
  ipcMain.handle(IPC_CHANNELS.TESTING_GET_RUNS, (event, rawArgs?: unknown) => {
    validateSender(event)
    // Resolve fixture workspace ID — runs are stored under the fixture workspace
    let workspaceId: string | undefined
    if (rawArgs != null) {
      const args = requireObject(rawArgs, IPC_CHANNELS.TESTING_GET_RUNS)
      workspaceId = optionalString(args, 'workspaceId', IPC_CHANNELS.TESTING_GET_RUNS)
    }
    if (!workspaceId) {
      // Look up the fixture workspace by its known path
      const fixturePath = fixtureManager.getFixturePath()
      const fixtureWs = workspaceRepository.findByPath(fixturePath)
      workspaceId = fixtureWs?.id
    }
    if (!workspaceId) return []
    return e2eTestRunRepository.findByWorkspace(workspaceId)
  })

  // ── Get results for a specific run (lightweight — no transcript/assertions) ──
  ipcMain.handle(IPC_CHANNELS.TESTING_GET_RUN_RESULTS, (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.TESTING_GET_RUN_RESULTS
    const args = requireObject(rawArgs, ch)
    const runId = requireString(args, 'runId', ch)
    return e2eTestResultRepository.summariesByRun(runId)
  })

  // ── Get detail for a single result ──
  ipcMain.handle(IPC_CHANNELS.TESTING_GET_RESULT_DETAIL, (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.TESTING_GET_RESULT_DETAIL
    const args = requireObject(rawArgs, ch)
    const resultId = requireString(args, 'resultId', ch)
    return e2eTestResultRepository.findById(resultId)
  })
}
