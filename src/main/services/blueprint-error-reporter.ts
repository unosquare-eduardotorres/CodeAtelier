/**
 * Blueprint error reporter — shared utility for all phase services.
 *
 * Reports blueprint phase failures to the bug tracker DB and notifies
 * the renderer so errors appear on the Bugs page with full stack traces.
 */

import { app, BrowserWindow } from 'electron'
import log from 'electron-log'
import { bugRepository } from '../db/repositories/bug.repository'

const bpLog = log.scope('blueprint-error')

/**
 * Report a blueprint phase error to the bug tracker.
 * Called from every phase service's catch block.
 */
export function reportBlueprintPhaseError(params: {
  blueprintId: string
  workspaceId: string
  phase: string
  error: unknown
}): { errorMessage: string } {
  const errorMessage = params.error instanceof Error ? params.error.message : String(params.error)
  const stackTrace = params.error instanceof Error ? params.error.stack : undefined

  try {
    const result = bugRepository.upsertBug({
      process: 'main',
      severity: 'error',
      errorMessage: `Blueprint ${params.phase} phase failed: ${errorMessage}`,
      stackTrace: stackTrace?.slice(0, 2048),
      componentName: `blueprint-${params.phase}`,
      workspaceId: params.workspaceId,
      appVersion: app.getVersion()
    })

    if (result.isNew) {
      const bug = bugRepository.getById(result.bugId)
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          win.webContents.send('bug:new', bug)
        } catch {
          /* window may be destroyed */
        }
      }
    }
  } catch (e) {
    bpLog.warn('[reportBlueprintPhaseError] Failed to report to bug tracker:', e)
  }

  return { errorMessage }
}
