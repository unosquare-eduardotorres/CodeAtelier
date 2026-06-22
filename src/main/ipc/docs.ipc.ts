import { ipcMain } from 'electron'
import { resolve } from 'node:path'
import { IPC_CHANNELS } from '../../shared/constants'
import { docsService } from '../services/docs.service'
import { mermaidService } from '../services/mermaid.service'
import type { DocFile } from '../../shared/types'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalString } from './validate-args'

export function registerDocsIpc(): void {
  // SVC-03: Add requireObject/requireString validation to DOCS_LIST
  ipcMain.handle(IPC_CHANNELS.DOCS_LIST, (event, rawArgs: unknown): DocFile[] => {
    validateSender(event)
    const ch = IPC_CHANNELS.DOCS_LIST
    const args = requireObject(rawArgs, ch)
    const workspacePath = requireString(args, 'workspacePath', ch)
    return docsService.listDocs(workspacePath)
  })

  // SEC-03: Add path confinement — only allow reads within workspace docs/ directory
  ipcMain.handle(IPC_CHANNELS.DOCS_READ_FILE, (event, rawArgs: unknown): string => {
    validateSender(event)
    const ch = IPC_CHANNELS.DOCS_READ_FILE
    const args = requireObject(rawArgs, ch)
    const filePath = requireString(args, 'filePath', ch)
    const workspacePath = requireString(args, 'workspacePath', ch)

    // Confine reads to the workspace docs/ directory — prevents path traversal
    const docsDir = resolve(workspacePath, 'docs')
    const resolvedPath = resolve(filePath)
    if (!resolvedPath.startsWith(docsDir + '/') && resolvedPath !== docsDir) {
      throw new Error(`${ch}: file path must be within workspace docs/ directory`)
    }

    return docsService.readFile(resolvedPath)
  })

  // MCP-05: Add requireObject/requireString validation to DOCS_RENDER_MERMAID
  ipcMain.handle(
    IPC_CHANNELS.DOCS_RENDER_MERMAID,
    async (event, rawArgs: unknown): Promise<{ svg: string }> => {
      validateSender(event)
      const ch = IPC_CHANNELS.DOCS_RENDER_MERMAID
      const args = requireObject(rawArgs, ch)
      const definition = requireString(args, 'definition', ch)
      const id = optionalString(args, 'id', ch)
      return mermaidService.render(definition, id)
    }
  )
}
