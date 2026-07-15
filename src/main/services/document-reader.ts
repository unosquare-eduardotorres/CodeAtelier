/**
 * document-reader.ts — Format-specific text extraction for document ingestion.
 *
 * Routes files to the appropriate reader based on extension:
 * - .md, .txt, code files → readFileSync (zero deps)
 * - .pdf → pdf-parse (pure JS)
 * - .docx → mammoth extractRawText (pure JS)
 * - images (.png/.jpg/.webp/.gif) → placeholder (vision extraction handled upstream)
 * - Other binaries → skipped
 *
 * All functions are pure/stateless — no singletons, no side effects.
 */

import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import log from 'electron-log'

const docReaderLog = log.scope('document-reader')

// ── Size caps ────────────────────────────────────────────────────────────────

/** Max file size for PDF/DOCX (20 MB) */
const MAX_DOC_SIZE_BYTES = 20 * 1024 * 1024

/** Max file size for images (8 MB) */
const MAX_IMAGE_SIZE_BYTES = 8 * 1024 * 1024

/** Min content length to bother extracting */
const MIN_CONTENT_CHARS = 20

// ── Extension sets ───────────────────────────────────────────────────────────

/** Text-readable code/config extensions (read as UTF-8) */
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.rst', '.adoc',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi', '.rb', '.go', '.rs', '.java', '.kt', '.kts',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.swift',
  '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env',
  '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.sql', '.graphql', '.gql', '.prisma',
  '.dockerfile', '.makefile', '.cmake',
  '.csv', '.tsv', '.log'
])

/** Image extensions supported for vision-based extraction */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

/** Binary extensions that are always skipped */
const SKIP_EXTENSIONS = new Set([
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.dmg', '.exe', '.msi', '.deb', '.rpm',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
  '.ico', '.bmp', '.tiff', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.sqlite', '.db', '.dat', '.bin',
  '.psd', '.ai', '.sketch', '.fig',
  '.doc', // .doc (legacy Word) is not supported — only .docx
  '.xls', '.xlsx', '.ppt', '.pptx'
])

// ── Result type ──────────────────────────────────────────────────────────────

export type DocumentReadResult =
  | { ok: true; content: string; format: 'text' | 'pdf' | 'docx' | 'image'; isImage: boolean }
  | { ok: false; reason: 'too_large' | 'too_short' | 'binary_skip' | 'not_found' | 'read_error'; message: string }

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Read a file and extract its text content based on format.
 *
 * For images, returns the raw file content as base64 with `isImage: true` —
 * callers use this to send to Claude Vision for fact extraction.
 */
export async function readDocument(filePath: string): Promise<DocumentReadResult> {
  const ext = extname(filePath).toLowerCase()

  // Handle extensionless files (Dockerfile, Makefile, etc.)
  const basename = filePath.split('/').pop() ?? ''
  const isKnownExtensionless = ['dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile'].includes(
    basename.toLowerCase()
  )

  // 1. Check if binary/skip
  if (SKIP_EXTENSIONS.has(ext)) {
    return { ok: false, reason: 'binary_skip', message: `Unsupported binary format: ${ext}` }
  }

  // 2. Check file size
  let fileSize: number
  try {
    fileSize = statSync(filePath).size
  } catch {
    return { ok: false, reason: 'not_found', message: `File not found or inaccessible: ${filePath}` }
  }

  // 3. Route by format
  if (ext === '.pdf') {
    if (fileSize > MAX_DOC_SIZE_BYTES) {
      return { ok: false, reason: 'too_large', message: `PDF exceeds ${MAX_DOC_SIZE_BYTES / 1024 / 1024}MB limit` }
    }
    return readPdf(filePath)
  }

  if (ext === '.docx') {
    if (fileSize > MAX_DOC_SIZE_BYTES) {
      return { ok: false, reason: 'too_large', message: `DOCX exceeds ${MAX_DOC_SIZE_BYTES / 1024 / 1024}MB limit` }
    }
    return readDocx(filePath)
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    if (fileSize > MAX_IMAGE_SIZE_BYTES) {
      return { ok: false, reason: 'too_large', message: `Image exceeds ${MAX_IMAGE_SIZE_BYTES / 1024 / 1024}MB limit` }
    }
    return readImage(filePath)
  }

  if (TEXT_EXTENSIONS.has(ext) || isKnownExtensionless) {
    return readTextFile(filePath)
  }

  // Unknown extension — try as text, fail gracefully
  return readTextFile(filePath)
}

/**
 * Check if a file extension is supported for reading.
 */
export function isSupportedExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  const basename = filePath.split('/').pop() ?? ''
  const isKnownExtensionless = ['dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile'].includes(
    basename.toLowerCase()
  )
  return (
    TEXT_EXTENSIONS.has(ext) ||
    IMAGE_EXTENSIONS.has(ext) ||
    ext === '.pdf' ||
    ext === '.docx' ||
    isKnownExtensionless
  )
}

/**
 * Check if a file is an image (for vision-based extraction).
 */
export function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase())
}

// ── Internal readers ─────────────────────────────────────────────────────────

function readTextFile(filePath: string): DocumentReadResult {
  try {
    const content = readFileSync(filePath, 'utf-8')
    if (content.length < MIN_CONTENT_CHARS) {
      return { ok: false, reason: 'too_short', message: `File content too short (${content.length} chars)` }
    }
    return { ok: true, content, format: 'text', isImage: false }
  } catch (err) {
    return {
      ok: false,
      reason: 'read_error',
      message: `Failed to read as text: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

async function readPdf(filePath: string): Promise<DocumentReadResult> {
  try {
    // Dynamic import to keep cold-start fast when not ingesting PDFs
    const { PDFParse } = await import('pdf-parse')
    const buffer = readFileSync(filePath)
    const parser = new PDFParse({ data: buffer })
    const result = await parser.getText()
    const text = result.text?.trim()

    if (!text || text.length < MIN_CONTENT_CHARS) {
      return { ok: false, reason: 'too_short', message: `PDF extracted text too short (${text?.length ?? 0} chars)` }
    }

    return { ok: true, content: text, format: 'pdf', isImage: false }
  } catch (err) {
    docReaderLog.warn(`[readPdf] Failed to parse ${filePath}:`, err)
    return {
      ok: false,
      reason: 'read_error',
      message: `PDF parse failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

async function readDocx(filePath: string): Promise<DocumentReadResult> {
  try {
    const mammoth = await import('mammoth')
    const buffer = readFileSync(filePath)
    const result = await mammoth.extractRawText({ buffer })
    const text = result.value?.trim()

    if (!text || text.length < MIN_CONTENT_CHARS) {
      return { ok: false, reason: 'too_short', message: `DOCX extracted text too short (${text?.length ?? 0} chars)` }
    }

    return { ok: true, content: text, format: 'docx', isImage: false }
  } catch (err) {
    docReaderLog.warn(`[readDocx] Failed to parse ${filePath}:`, err)
    return {
      ok: false,
      reason: 'read_error',
      message: `DOCX parse failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

function readImage(filePath: string): DocumentReadResult {
  try {
    const buffer = readFileSync(filePath)
    const base64 = buffer.toString('base64')
    const ext = extname(filePath).toLowerCase()
    const mimeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif'
    }
    const mime = mimeMap[ext] ?? 'image/png'
    // Return base64 data URL — callers send this to Claude Vision
    return { ok: true, content: `data:${mime};base64,${base64}`, format: 'image', isImage: true }
  } catch (err) {
    return {
      ok: false,
      reason: 'read_error',
      message: `Image read failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}
