import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { worktreeRepository } from '../db/repositories'
import { gitWorktreeService } from '../services'
import { validateSender } from './validate-sender'

export function registerWorktreeIpc(): void {
  // ── List worktrees for a conversation ──
  ipcMain.handle(IPC_CHANNELS.WORKTREE_LIST, async (event, args: { conversationId: string }) => {
    validateSender(event)
    if (!args?.conversationId) throw new Error('Invalid conversation ID')
    return worktreeRepository.findByConversation(args.conversationId)
  })

  // ── Get diff for a specific worktree ──
  ipcMain.handle(IPC_CHANNELS.WORKTREE_GET_DIFF, async (event, args: { worktreeId: string }) => {
    validateSender(event)
    if (!args?.worktreeId) throw new Error('Invalid worktree ID')
    return gitWorktreeService.getDiff(args.worktreeId)
  })

  // ── Merge a single worktree ──
  ipcMain.handle(IPC_CHANNELS.WORKTREE_MERGE, async (event, args: { worktreeId: string }) => {
    validateSender(event)
    if (!args?.worktreeId) throw new Error('Invalid worktree ID')
    return gitWorktreeService.merge(args.worktreeId)
  })

  // ── Merge all active worktrees for a conversation ──
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_MERGE_ALL,
    async (event, args: { conversationId: string }) => {
      validateSender(event)
      if (!args?.conversationId) throw new Error('Invalid conversation ID')
      return gitWorktreeService.mergeAll(args.conversationId)
    }
  )

  // ── Abandon a worktree (remove without merging) ──
  ipcMain.handle(IPC_CHANNELS.WORKTREE_ABANDON, async (event, args: { worktreeId: string }) => {
    validateSender(event)
    if (!args?.worktreeId) throw new Error('Invalid worktree ID')
    await gitWorktreeService.remove(args.worktreeId, true)
  })
}
