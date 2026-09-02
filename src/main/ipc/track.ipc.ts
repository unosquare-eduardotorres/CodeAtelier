/**
 * Work-track IPC — the first way a user can see the trees agents work in.
 *
 * Retention has kept uncommitted work safe on disk since the worktree service
 * shipped, and nothing in the UI could show it: `grep -ri worktree src/renderer`
 * matched nothing at all. A user whose chat closed with uncommitted changes had
 * no route back short of `git worktree list`, so the safe-by-default behaviour
 * read as "my work disappeared". These four channels are the smallest thing
 * that makes retention an actual promise instead of a log line.
 */

import { ipcMain, shell } from 'electron'
import log from 'electron-log/main'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalString } from './validate-args'
import { trackService, DISK_BUDGET_BYTES } from '../services/track.service'
import { landingService } from '../services/landing.service'
import type {
  TrackListResult,
  LandingResult,
  LandingPreview,
  MainlineSyncResult,
  TrackLandingMode
} from '../../shared/track-types'

const trackLog = log.scope('track-ipc')

/**
 * Read a landing mode off a renderer payload.
 *
 * Anything that is not one of the two known modes is dropped rather than
 * passed on, which leaves the track's own setting in force. `landNow` branches
 * on `mode === 'integration'`, so an unrecognised string would silently mean
 * "independent" — a typo would quietly open a PR for a workspace that had
 * chosen to merge locally.
 */
function optionalLandingMode(
  args: Record<string, unknown>,
  channel: string
): TrackLandingMode | undefined {
  const raw = optionalString(args, 'mode', channel)
  if (raw === undefined) return undefined
  if (raw === 'independent' || raw === 'integration') return raw
  throw new Error(`${channel}: mode must be 'independent' or 'integration'`)
}

export function registerTrackIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.TRACK_LIST,
    async (event, rawArgs: unknown): Promise<TrackListResult> => {
      validateSender(event)
      const args = requireObject(rawArgs, IPC_CHANNELS.TRACK_LIST)
      const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.TRACK_LIST)

      const tracks = await trackService.summarize(workspaceId)
      const totalBytes = tracks.reduce((sum, t) => sum + t.diskBytes, 0)
      // Read-only, and a repo it cannot read is not a reason to fail the list.
      let mainline: TrackListResult['mainline'] = null
      try {
        mainline = await landingService.mainlineStatus(workspaceId)
      } catch (err) {
        trackLog.warn(`[list] mainline status unavailable: ${(err as Error).message}`)
      }
      return { tracks, totalBytes, budgetBytes: DISK_BUDGET_BYTES, mainline }
    }
  )

  ipcMain.handle(IPC_CHANNELS.TRACK_DISCARD, async (event, rawArgs: unknown): Promise<boolean> => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.TRACK_DISCARD)
    const trackId = requireString(args, 'trackId', IPC_CHANNELS.TRACK_DISCARD)

    // The only caller of discard() anywhere. It destroys uncommitted work, so
    // it exists solely to serve an explicit user decision — never a default,
    // never a cleanup path.
    const removed = await trackService.discard(trackId)
    trackLog.info(`[discard] track=${trackId} removed=${removed}`)
    return removed
  })

  ipcMain.handle(IPC_CHANNELS.TRACK_REVEAL, (event, rawArgs: unknown): boolean => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.TRACK_REVEAL)
    const trackId = requireString(args, 'trackId', IPC_CHANNELS.TRACK_REVEAL)

    // The path comes from the DB rather than the renderer: this opens an
    // arbitrary directory in the OS file manager, and a renderer-supplied path
    // would make that a "reveal anything on disk" primitive.
    const track = trackService.get(trackId)
    if (!track) return false

    shell.showItemInFolder(track.path)
    return true
  })

  ipcMain.handle(IPC_CHANNELS.TRACK_ADOPT, (event, rawArgs: unknown): string | null => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.TRACK_ADOPT)
    const trackId = requireString(args, 'trackId', IPC_CHANNELS.TRACK_ADOPT)

    const conversationId = trackService.adopt(trackId)
    trackLog.info(`[adopt] track=${trackId} conversation=${conversationId ?? 'none'}`)
    return conversationId
  })

  ipcMain.handle(
    IPC_CHANNELS.TRACK_LAND,
    async (event, rawArgs: unknown): Promise<LandingResult> => {
      validateSender(event)
      const args = requireObject(rawArgs, IPC_CHANNELS.TRACK_LAND)
      const trackId = requireString(args, 'trackId', IPC_CHANNELS.TRACK_LAND)
      const commitMessage = requireString(args, 'commitMessage', IPC_CHANNELS.TRACK_LAND)
      const description = optionalString(args, 'description', IPC_CHANNELS.TRACK_LAND)
      const baseBranch = optionalString(args, 'baseBranch', IPC_CHANNELS.TRACK_LAND)
      const mode = optionalLandingMode(args, IPC_CHANNELS.TRACK_LAND)

      // The route home for work that is not a chat. A blueprint run owns a branch
      // and a worktree exactly like a chat does, but `/complete` only ever knew
      // about conversations — so before this, blueprint output had nowhere to go.
      const result = await landingService.land(trackId, {
        commitMessage,
        description,
        baseBranch,
        mode
      })
      trackLog.info(`[land] track=${trackId} outcome=${result.outcome} into=${result.landedInto}`)
      return result
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.TRACK_LAND_PREVIEW,
    async (event, rawArgs: unknown): Promise<LandingPreview> => {
      validateSender(event)
      const ch = IPC_CHANNELS.TRACK_LAND_PREVIEW
      const args = requireObject(rawArgs, ch)
      const trackId = requireString(args, 'trackId', ch)
      const baseBranch = optionalString(args, 'baseBranch', ch)
      const mode = optionalLandingMode(args, ch)

      // Read-only, so unlike `land` it is not queued and takes no lock.
      return landingService.previewLanding(trackId, { baseBranch, mode })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.TRACK_SYNC_MAINLINE,
    async (event, rawArgs: unknown): Promise<MainlineSyncResult> => {
      validateSender(event)
      const ch = IPC_CHANNELS.TRACK_SYNC_MAINLINE
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)

      // Blueprints land into the integration branch on their own; this is the
      // step that never happens without the user asking, because it is the only
      // one that moves the branch they are standing on.
      const result = await landingService.syncMainline(workspaceId)
      trackLog.info(
        `[syncMainline] workspace=${workspaceId} outcome=${result.outcome} ` +
          `commits=${result.commitCount}`
      )
      return result
    }
  )
}
