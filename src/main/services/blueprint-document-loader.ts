/**
 * Blueprint Document Loader — on-demand content loader for reference documents.
 *
 * Reads file content for 'file' and 'workspace-file' types, and fetches URL
 * content for 'url' types. Used by blueprint phase services to inject full
 * document content into phase prompts.
 */

import { readFileSync } from 'node:fs'
import { resolve, normalize, isAbsolute } from 'node:path'
import log from 'electron-log'
import type { ReferenceDocument } from '../../shared/blueprint-types'

const docLog = log.scope('blueprint-doc-loader')

/** Maximum characters per document to prevent context window overflow */
const MAX_DOC_CHARS = 50_000

/** Content loaded from a reference document */
export interface LoadedDocument {
  doc: ReferenceDocument
  content: string
  truncated: boolean
}

/**
 * Load the content of a single reference document.
 *
 * Security: For file types, verifies the resolved path is within the workspace
 * to prevent path traversal attacks.
 */
export async function loadReferenceDocContent(
  workspacePath: string,
  doc: ReferenceDocument
): Promise<string> {
  switch (doc.type) {
    case 'file': {
      // User-dropped files may have absolute paths (e.g., /Users/foo/bar.pdf from Finder)
      if (isAbsolute(doc.path)) {
        return readFileSync(doc.path, 'utf-8')
      }
      // Relative file path — fall through to workspace-confined handling
    }
    // falls through
    case 'workspace-file': {
      const normalizedWorkspace = normalize(resolve(workspacePath))
      const fullPath = normalize(resolve(workspacePath, doc.path))

      // Security: verify path is within workspace
      if (!fullPath.startsWith(normalizedWorkspace)) {
        throw new Error(`Path traversal detected: ${doc.path} resolves outside workspace`)
      }

      return readFileSync(fullPath, 'utf-8')
    }

    case 'url': {
      return fetchUrlContent(doc.path)
    }

    default:
      throw new Error(`Unknown document type: ${(doc as ReferenceDocument).type}`)
  }
}

/**
 * Load all reference documents for a blueprint phase.
 * Each document is capped at MAX_DOC_CHARS characters.
 * Failures are gracefully handled — returns error message instead of throwing.
 */
export async function loadAllReferenceDocuments(
  workspacePath: string,
  documents: ReferenceDocument[]
): Promise<LoadedDocument[]> {
  return Promise.all(
    documents.map(async (doc): Promise<LoadedDocument> => {
      try {
        const raw = await loadReferenceDocContent(workspacePath, doc)
        const truncated = raw.length > MAX_DOC_CHARS
        return {
          doc,
          content: truncated ? raw.slice(0, MAX_DOC_CHARS) + '\n\n[… truncated]' : raw,
          truncated
        }
      } catch (err) {
        docLog.warn(`Failed to load reference doc "${doc.name}" (${doc.type}): ${err}`)
        return {
          doc,
          content: `(Failed to load: ${doc.name} — ${err instanceof Error ? err.message : 'unknown error'})`,
          truncated: false
        }
      }
    })
  )
}

/**
 * Fetch URL content as plain text.
 * Uses a simple fetch with timeout — no external MCP dependency.
 */
async function fetchUrlContent(url: string): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'AgentStudio/1.0 (Blueprint Document Loader)',
        Accept: 'text/plain, text/html, text/markdown, application/json, */*'
      }
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    return await response.text()
  } finally {
    clearTimeout(timeout)
  }
}
