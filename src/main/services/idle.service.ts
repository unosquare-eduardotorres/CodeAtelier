import { powerMonitor } from 'electron'
import { dbLogger } from '../logger'
import { dreamService } from './dream.service'
import { dreamRunRepository } from '../db/repositories'

const log = dbLogger

/** Idle threshold in seconds before triggering a dream (5 minutes) */
const IDLE_THRESHOLD_SECONDS = 5 * 60
/** Minimum time between dream runs in ms (24 hours) */
const MIN_DREAM_INTERVAL_MS = 24 * 60 * 60 * 1000
/** How often to check idle state in ms (60 seconds) */
const CHECK_INTERVAL_MS = 60 * 1000

/**
 * Service that monitors system idle time and triggers dream consolidation
 * when the user has been idle for a configured period.
 *
 * Uses Electron's powerMonitor.getSystemIdleTime() for accurate detection
 * across all platforms.
 */
class IdleService {
  private checkTimer: ReturnType<typeof setInterval> | null = null
  private currentWorkspaceId: string | null = null
  private enabled: boolean = true

  /**
   * Start monitoring idle time for the given workspace.
   */
  start(workspaceId: string): void {
    this.currentWorkspaceId = workspaceId
    this.enabled = true

    if (this.checkTimer) {
      clearInterval(this.checkTimer)
    }

    this.checkTimer = setInterval(() => {
      this.checkIdle()
    }, CHECK_INTERVAL_MS)

    log.info(`Idle service started for workspace ${workspaceId}`)
  }

  /**
   * Stop monitoring idle time.
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }
    this.currentWorkspaceId = null
    this.enabled = false
    log.info('Idle service stopped')
  }

  /**
   * Check if the system is idle and trigger a dream if appropriate.
   */
  private async checkIdle(): Promise<void> {
    if (!this.enabled || !this.currentWorkspaceId) return

    try {
      const idleSeconds = powerMonitor.getSystemIdleTime()

      if (idleSeconds >= IDLE_THRESHOLD_SECONDS) {
        // Check if enough time has passed since the last dream run
        const recentRuns = dreamRunRepository.findByWorkspace(this.currentWorkspaceId, 1)
        if (recentRuns.length > 0) {
          const lastRun = recentRuns[0]
          const lastRunTime = new Date(lastRun.startedAt).getTime()
          const timeSinceLastRun = Date.now() - lastRunTime

          if (timeSinceLastRun < MIN_DREAM_INTERVAL_MS) {
            return // Too soon since last dream
          }
        }

        // Check if a dream is already running
        const running = dreamRunRepository.findRunning(this.currentWorkspaceId)
        if (running) return

        log.info(`System idle for ${idleSeconds}s — triggering dream consolidation`)

        try {
          await dreamService.run(this.currentWorkspaceId, 'idle')
        } catch (error) {
          log.error('Idle-triggered dream failed:', error)
        }
      }
    } catch (error) {
      log.error('Idle check failed:', error)
    }
  }

  /**
   * Enable/disable idle dream triggers.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    log.info(`Idle service ${enabled ? 'enabled' : 'disabled'}`)
  }
}

export const idleService = new IdleService()
