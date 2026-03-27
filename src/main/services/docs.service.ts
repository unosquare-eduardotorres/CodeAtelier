import { join, extname } from 'node:path'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type { DocFile } from '../../shared/types'

const SUPPORTED_EXTENSIONS = new Set(['md'])

class DocsService {
  /**
   * List all files in {workspacePath}/docs.
   * Returns empty array if docs/ doesn't exist.
   */
  listDocs(workspacePath: string): DocFile[] {
    const docsDir = join(workspacePath, 'docs')
    if (!existsSync(docsDir)) return []

    const entries = readdirSync(docsDir, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => {
        const fullPath = join(docsDir, e.name)
        const ext = extname(e.name).slice(1).toLowerCase()
        const stat = statSync(fullPath)
        return {
          name: e.name,
          path: fullPath,
          extension: ext,
          supported: SUPPORTED_EXTENSIONS.has(ext),
          sizeBytes: stat.size,
          modifiedAt: stat.mtimeMs
        }
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt) // newest first
  }

  /**
   * Read file content as UTF-8 string.
   */
  readFile(filePath: string): string {
    return readFileSync(filePath, 'utf-8')
  }
}

export const docsService = new DocsService()
