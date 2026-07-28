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

/**
 * Phase 5.2: Additional trusted roots beyond the workspace.
 * The managed docs directory (userData/blueprint-docs/) is whitelisted
 * so copy-on-attach documents can be loaded even though they're outside
 * the workspace.
 */
let managedDocsRoot: string | null = null

/** Call from main process to register the managed docs root for whitelist */
export function setManagedDocsRoot(root: string): void {
  managedDocsRoot = root
  docLog.info(`[managed-docs] Registered trusted root: ${root}`)
}

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
  /** True when document loading failed — content contains the error message */
  failed?: boolean
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
  // Phase 5.5: Diagnostic logging — trace every doc resolution attempt
  docLog.info(
    `[resolve] type=${doc.type} name="${doc.name ?? ''}" storedPath="${doc.path}" workspace="${workspacePath}"`
  )

  switch (doc.type) {
    case 'file': {
      // User-dropped files may have absolute paths (e.g., /Users/foo/bar.pdf from Finder)
      if (isAbsolute(doc.path)) {
        // Phase 5.2: Allow managed docs root (copy-on-attach directory)
        const inManagedRoot = managedDocsRoot && normalize(doc.path).startsWith(normalize(managedDocsRoot))
        if (!inManagedRoot) {
          docLog.info(`[resolve] absolute path (external), checking existence: "${doc.path}"`)
        }
        const exists = existsSync(doc.path)
        docLog.info(`[resolve] absolute path exists=${exists} → "${doc.path}"${inManagedRoot ? ' (managed)' : ''}`)
        if (!exists) {
          // Fallback: search workspace for the filename
          const fileName = basename(doc.path)
          const found = findFileInWorkspace(workspacePath, fileName)
          if (found) {
            docLog.info(`[resolve] absolute path missing, fallback found in workspace: "${found}"`)
            return readFileSync(found, 'utf-8')
          }
          throw new Error(`Reference document not found at absolute path: ${doc.path}`)
        }
        return readFileSync(doc.path, 'utf-8')
      }
      // Relative file path — fall through to workspace-confined handling
    }
    // falls through
    case 'workspace-file': {
      const normalizedWorkspace = normalize(resolve(workspacePath))
      let fullPath = normalize(resolve(workspacePath, doc.path))

      // Security: verify path is within workspace or managed docs root
      const inWorkspace = fullPath.startsWith(normalizedWorkspace)
      const inManagedDir = managedDocsRoot && fullPath.startsWith(normalize(managedDocsRoot))
      if (!inWorkspace && !inManagedDir) {
        throw new Error(`Path traversal detected: ${doc.path} resolves outside workspace`)
      }

      // Defensive fallback: if file not found, search for the filename in the workspace (depth ≤3)
      if (!existsSync(fullPath)) {
        docLog.warn(`[resolve] primary path missing: "${fullPath}", searching workspace…`)
        const fileName = basename(doc.path)
        const found = findFileInWorkspace(workspacePath, fileName)
        if (found) {
          docLog.info(`[resolve] fallback hit: "${doc.path}" → "${found}"`)
          fullPath = found
        } else {
          docLog.warn(`[resolve] fallback miss: "${fileName}" not found in workspace (depth ≤3)`)
        }
      } else {
        docLog.info(`[resolve] direct hit: "${fullPath}"`)
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
        const errMsg = err instanceof Error ? err.message : 'unknown error'
        docLog.error(
          `[resolve] FAILED doc="${doc.name}" type=${doc.type} path="${doc.path}": ${errMsg}`
        )
        return {
          doc,
          content: `(Failed to load: ${doc.name} — ${errMsg})`,
          truncated: false,
          failed: true
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

/** Result from buildReferenceDocsBlock with failure tracking */
export interface ReferenceDocsResult {
  /** Assembled markdown block for prompt injection, or undefined if empty */
  block: string | undefined
  /** Names of documents that failed to load */
  failedDocs: string[]
}

/**
 * Build the full reference-docs markdown block for injection into a phase prompt.
 * Splits binary from text, loads text docs, and assembles sections.
 * Returns structured result with the block and any failure info.
 */
export async function buildReferenceDocsBlock(
  workspacePath: string,
  docs: ReferenceDocument[]
): Promise<ReferenceDocsResult> {
  if (!docs.length) return { block: undefined, failedDocs: [] }

  const { textDocs, binaryPaths } = splitBinaryDocs(docs)
  const parts: string[] = []
  const failedDocs: string[] = []

  if (textDocs.length > 0) {
    const loaded = await loadAllReferenceDocuments(workspacePath, textDocs)
    for (const ld of loaded) {
      if (ld.failed) {
        failedDocs.push(ld.doc.name || ld.doc.path)
      }
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

  return {
    block: parts.length > 0 ? parts.join('\n\n---\n\n') : undefined,
    failedDocs
  }
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
