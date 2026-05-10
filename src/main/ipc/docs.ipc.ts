import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { docsService } from '../services/docs.service'
import { mermaidService } from '../services/mermaid.service'
import type { DocFile } from '../../shared/types'
import { validateSender } from './validate-sender'

export function registerDocsIpc(): void {
  ipcMain.handle(IPC_CHANNELS.DOCS_LIST, (event, args: { workspacePath: string }): DocFile[] => {
    validateSender(event)
    return docsService.listDocs(args.workspacePath)
  })

  ipcMain.handle(IPC_CHANNELS.DOCS_READ_FILE, (event, args: { filePath: string }): string => {
    validateSender(event)
    return docsService.readFile(args.filePath)
  })

  ipcMain.handle(
    IPC_CHANNELS.DOCS_RENDER_MERMAID,
    async (event, args: { definition: string; id?: string }): Promise<{ svg: string }> => {
      validateSender(event)
      return mermaidService.render(args.definition, args.id)
    }
  )
}
