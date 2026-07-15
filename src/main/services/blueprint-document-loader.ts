/**
 * Blueprint Document Loader — on-demand content loader for reference documents.
 *
 * Reads file content for 'file' and 'workspace-file' types, and fetches URL
 * content for 'url' types. Used by blueprint phase services to inject full
 * document content into phase prompts.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, normalize, isAbsolute, extname, basename, join } from 'node:path'
import log from 'electron-log'
/** Inline type — ReferenceDocument was removed from shared/blueprint-types */
interface ReferenceDocument {
  type: 'file' | 'workspace-file' | 'url'
  path: string
  url?: string
  name?: string
  label?: string
}

const docLog = log.scope('blueprint-doc-loader')

/** Maximum characters per document to prevent context window overflow */
const MAX_DOC_CHARS = 50_000

/** Binary extensions listed by path instead of read as UTF-8 */
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp',
  '.pdf', '.doc', '.docx',
  '.zip', '.tar', '.gz', '.dmg', '.exe', '.mp3', '.mp4', '.wav'
])

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
      let fullPath = normalize(resolve(workspacePath, doc.path))

      // Security: verify path is within workspace
      if (!fullPath.startsWith(normalizedWorkspace)) {
        throw new Error(`Path traversal detected: ${doc.path} resolves outside workspace`)
      }

      // Defensive fallback: if file not found, search for the filename in the workspace (depth ≤3)
      if (!existsSync(fullPath)) {
        const fileName = basename(doc.path)
        const found = findFileInWorkspace(workspacePath, fileName)
        if (found) {
          docLog.info(`Resolved bare filename "${doc.path}" → "${found}" (fallback search)`)
          fullPath = found
        }
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

// ── Exported Helpers ──────────────────────────────────────────────────────────

/**
 * Split reference documents into text-readable and binary-path-only groups.
 * Pure, synchronous, testable.
 */
export function splitBinaryDocs(
  docs: ReferenceDocument[]
): { textDocs: ReferenceDocument[]; binaryPaths: string[] } {
  const textDocs: ReferenceDocument[] = []
  const binaryPaths: string[] = []

  for (const doc of docs) {
    const ext = extname(doc.path).toLowerCase()
    if (BINARY_EXTS.has(ext)) {
      binaryPaths.push(doc.path)
    } else {
      textDocs.push(doc)
    }
  }

  return { textDocs, binaryPaths }
}

/**
 * Build the full reference-docs markdown block for injection into a phase prompt.
 * Splits binary from text, loads text docs, and assembles sections.
 * Returns undefined when there are no documents to render.
 */
export async function buildReferenceDocsBlock(
  workspacePath: string,
  docs: ReferenceDocument[]
): Promise<string | undefined> {
  if (!docs.length) return undefined

  const { textDocs, binaryPaths } = splitBinaryDocs(docs)
  const parts: string[] = []

  if (textDocs.length > 0) {
    const loaded = await loadAllReferenceDocuments(workspacePath, textDocs)
    for (const ld of loaded) {
      parts.push(`### ${ld.doc.name || ld.doc.path}\n\n${ld.content}`)
    }
  }

  if (binaryPaths.length > 0) {
    parts.push(
      '### Binary Reference Files\n\n' +
      'The following binary files were attached as reference. ' +
      'Use your file tools to view them if needed:\n\n' +
      binaryPaths.map((p) => `- \`${p}\``).join('\n')
    )
  }

  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined
}

// ── Workspace Documentation Loader ──────────────────────────────────────────

/** Maximum characters per workspace doc (CLAUDE.md, README.md, etc.) */
const MAX_WORKSPACE_DOC_CHARS = 30_000

/** Well-known workspace documentation files to pre-read for prompt injection. */
const WORKSPACE_DOC_FILES = [
  { name: 'CLAUDE.md', path: 'CLAUDE.md' },
  { name: 'README.md', path: 'README.md' },
  { name: 'package.json', path: 'package.json' },
  { name: 'PLAN.md', path: 'PLAN.md' },
] as const

/**
 * Pre-read key workspace documentation files for prompt injection.
 * Reads CLAUDE.md, README.md, package.json, and PLAN.md from workspace root.
 * Returns a formatted markdown block or undefined if no files found.
 *
 * Each file is capped at MAX_WORKSPACE_DOC_CHARS to avoid context overflow.
 * Files that don't exist are silently skipped.
 */
export async function buildWorkspaceDocsBlock(workspacePath: string): Promise<string | undefined> {
  const parts: string[] = []

  for (const doc of WORKSPACE_DOC_FILES) {
    const fullPath = resolve(workspacePath, doc.path)
    if (existsSync(fullPath)) {
      try {
        let content = readFileSync(fullPath, 'utf-8')
        if (content.length > MAX_WORKSPACE_DOC_CHARS) {
          content = content.slice(0, MAX_WORKSPACE_DOC_CHARS) + '\n\n[… truncated]'
        }
        parts.push(`### ${doc.name}\n\n${content}`)
      } catch (err) {
        docLog.warn(`Failed to read workspace doc "${doc.name}": ${err}`)
      }
    }
  }

  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Shallow filename search in the workspace (depth ≤3).
 * Returns the first absolute match or undefined. Used as a fallback when a bare
 * filename was stored (e.g. Electron 32+ dropped File.path).
 */
function findFileInWorkspace(workspacePath: string, fileName: string): string | undefined {
  try {
    return walkForFile(workspacePath, fileName, 0, 3)
  } catch {
    return undefined
  }
}

/** Recursive directory walk limited to `maxDepth` levels. */
function walkForFile(dir: string, target: string, depth: number, maxDepth: number): string | undefined {
  if (depth > maxDepth) return undefined
  const entries = readdirSync(dir, { withFileTypes: true })
  // Check files first at this level
  for (const e of entries) {
    if (e.isFile() && e.name === target) return join(dir, e.name)
  }
  // Then recurse into subdirectories
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue
    const found = walkForFile(join(dir, e.name), target, depth + 1, maxDepth)
    if (found) return found
  }
  return undefined
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
