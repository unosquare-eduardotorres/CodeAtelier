import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { docsService } from '../services/docs.service'
import { mermaidService } from '../services/mermaid.service'
import type { DocFile } from '../../shared/types'

export function registerDocsIpc(): void {
  ipcMain.handle(IPC_CHANNELS.DOCS_LIST, (_event, args: { workspacePath: string }): DocFile[] => {
    return docsService.listDocs(args.workspacePath)
  })

  ipcMain.handle(IPC_CHANNELS.DOCS_READ_FILE, (_event, args: { filePath: string }): string => {
    return docsService.readFile(args.filePath)
  })

  ipcMain.handle(
    IPC_CHANNELS.DOCS_RENDER_MERMAID,
    async (_event, args: { definition: string; id?: string }): Promise<{ svg: string }> => {
      return mermaidService.render(args.definition, args.id)
    }
  )
}
