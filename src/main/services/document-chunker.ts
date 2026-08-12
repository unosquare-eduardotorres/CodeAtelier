/**
 * document-chunker.ts — Structure-aware text chunking for document ingestion.
 *
 * Splits document content into chunks suitable for LLM fact extraction.
 * Three strategies based on content type:
 *
 * 1. **Markdown** — split on heading boundaries (H1→H2→H3), each chunk carries
 *    its heading breadcrumb ("Doc > Section > Subsection") for context.
 * 2. **Code files** — split on top-level declaration boundaries (blank-line
 *    heuristic), ~10K chars/chunk.
 * 3. **Plain text / PDF / DOCX** — paragraph-based packing to ~10K chars,
 *    10% overlap to avoid boundary fact loss.
 *
 * All functions are pure — no I/O, no side effects.
 */

// ── Configuration ────────────────────────────────────────────────────────────

/** Target chunk size in characters */
const TARGET_CHUNK_CHARS = 10_000

/** Max chunks per document (caps at ~250K chars total) */
const MAX_CHUNKS_PER_DOC = 25

/** Overlap fraction for plain-text chunking */
const OVERLAP_FRACTION = 0.1

// ── Types ────────────────────────────────────────────────────────────────────

export interface DocumentChunk {
  /** Chunk index (0-based) within the document */
  index: number
  /** Total chunks for this document */
  total: number
  /** The chunk text content */
  content: string
  /** Heading breadcrumb for markdown chunks (e.g. "Doc > API > Authentication") */
  breadcrumb?: string
}

export type ChunkStrategy = 'markdown' | 'code' | 'plain'

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Chunk a document's text content using the appropriate strategy.
 *
 * @param content - Full text content of the document
 * @param strategy - Chunking strategy to use
 * @param docName - Document name for breadcrumb context (optional)
 * @returns Array of chunks, capped at MAX_CHUNKS_PER_DOC
 */
export function chunkDocument(
  content: string,
  strategy: ChunkStrategy,
  docName?: string
): DocumentChunk[] {
  if (!content || content.length === 0) return []

  let chunks: DocumentChunk[]

  switch (strategy) {
    case 'markdown':
      chunks = chunkMarkdown(content, docName)
      break
    case 'code':
      chunks = chunkCode(content)
      break
    case 'plain':
      chunks = chunkPlainText(content)
      break
  }

  // Cap total chunks
  if (chunks.length > MAX_CHUNKS_PER_DOC) {
    chunks = chunks.slice(0, MAX_CHUNKS_PER_DOC)
    // Update totals on capped chunks
    for (const chunk of chunks) {
      chunk.total = MAX_CHUNKS_PER_DOC
    }
  }

  // Update totals
  const total = chunks.length
  for (const chunk of chunks) {
    chunk.total = total
  }

  return chunks
}

/**
 * Detect the appropriate chunking strategy for a file.
 */
export function detectStrategy(filePath: string): ChunkStrategy {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''

  if (['md', 'mdx', 'markdown'].includes(ext)) return 'markdown'

  if (
    [
      'ts',
      'tsx',
      'js',
      'jsx',
      'mjs',
      'cjs',
      'py',
      'pyi',
      'rb',
      'go',
      'rs',
      'java',
      'kt',
      'kts',
      'c',
      'cpp',
      'h',
      'hpp',
      'cs',
      'swift',
      'sh',
      'bash',
      'zsh',
      'sql',
      'graphql',
      'gql',
      'prisma'
    ].includes(ext)
  )
    return 'code'

  return 'plain'
}

// ── Markdown chunking ────────────────────────────────────────────────────────

interface HeadingSection {
  level: number
  title: string
  startLine: number
  content: string
}

/**
 * Split markdown on heading boundaries with breadcrumb context.
 * Each chunk carries its heading path (e.g. "Doc > API > Authentication").
 */
function chunkMarkdown(content: string, docName?: string): DocumentChunk[] {
  const lines = content.split('\n')
  const sections: HeadingSection[] = []
  let currentSection: HeadingSection | null = null
  const contentLines: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^(#{1,6})\s+(.+)/)

    if (headingMatch) {
      // Flush previous section
      if (currentSection) {
        currentSection.content = contentLines.join('\n').trim()
        if (currentSection.content.length > 0) {
          sections.push(currentSection)
        }
        contentLines.length = 0
      }

      currentSection = {
        level: headingMatch[1].length,
        title: headingMatch[2].trim(),
        startLine: i,
        content: ''
      }
    } else {
      contentLines.push(lines[i])
    }
  }

  // Flush last section
  if (currentSection) {
    currentSection.content = contentLines.join('\n').trim()
    if (currentSection.content.length > 0) {
      sections.push(currentSection)
    }
  }

  // If no headings found, treat as plain text
  if (sections.length === 0) {
    return chunkPlainText(content)
  }

  // Build breadcrumbs and pack sections into chunks
  const chunks: DocumentChunk[] = []
  const headingStack: string[] = docName ? [docName] : []

  let currentChunkContent = ''
  let currentBreadcrumb = docName ?? ''

  for (const section of sections) {
    // Update heading stack
    while (headingStack.length > section.level) {
      headingStack.pop()
    }
    // Pad stack if we jumped levels
    while (headingStack.length < section.level) {
      headingStack.push('')
    }
    headingStack[section.level - 1] = section.title
    // Ensure stack doesn't extend beyond current level
    headingStack.length = section.level

    const breadcrumb = (docName ? [docName, ...headingStack] : headingStack)
      .filter(Boolean)
      .join(' > ')

    const sectionText = `## ${section.title}\n\n${section.content}`

    // If adding this section would exceed target, flush current chunk
    if (
      currentChunkContent.length + sectionText.length > TARGET_CHUNK_CHARS &&
      currentChunkContent.length > 0
    ) {
      chunks.push({
        index: chunks.length,
        total: 0, // set later
        content: currentChunkContent.trim(),
        breadcrumb: currentBreadcrumb
      })
      currentChunkContent = ''
    }

    // If a single section exceeds target, split it into sub-chunks
    if (sectionText.length > TARGET_CHUNK_CHARS) {
      // Flush any accumulated content first
      if (currentChunkContent.length > 0) {
        chunks.push({
          index: chunks.length,
          total: 0,
          content: currentChunkContent.trim(),
          breadcrumb: currentBreadcrumb
        })
        currentChunkContent = ''
      }

      const subChunks = splitLongText(sectionText, TARGET_CHUNK_CHARS)
      for (const sub of subChunks) {
        chunks.push({
          index: chunks.length,
          total: 0,
          content: sub.trim(),
          breadcrumb
        })
      }
    } else {
      currentChunkContent += (currentChunkContent ? '\n\n' : '') + sectionText
      currentBreadcrumb = breadcrumb
    }
  }

  // Flush remaining
  if (currentChunkContent.trim().length > 0) {
    chunks.push({
      index: chunks.length,
      total: 0,
      content: currentChunkContent.trim(),
      breadcrumb: currentBreadcrumb
    })
  }

  return chunks
}

// ── Code chunking ────────────────────────────────────────────────────────────

/**
 * Split code files on blank-line boundaries between top-level declarations.
 * Two or more consecutive blank lines signal a declaration boundary.
 */
function chunkCode(content: string): DocumentChunk[] {
  // Split on double blank lines (common declaration separator)
  const blocks = content.split(/\n{3,}/)

  const chunks: DocumentChunk[] = []
  let currentChunk = ''

  for (const block of blocks) {
    if (currentChunk.length + block.length + 2 > TARGET_CHUNK_CHARS && currentChunk.length > 0) {
      chunks.push({
        index: chunks.length,
        total: 0,
        content: currentChunk.trim()
      })
      currentChunk = ''
    }

    // If a single block exceeds target, split it
    if (block.length > TARGET_CHUNK_CHARS) {
      if (currentChunk.length > 0) {
        chunks.push({
          index: chunks.length,
          total: 0,
          content: currentChunk.trim()
        })
        currentChunk = ''
      }

      const subChunks = splitLongText(block, TARGET_CHUNK_CHARS)
      for (const sub of subChunks) {
        chunks.push({
          index: chunks.length,
          total: 0,
          content: sub.trim()
        })
      }
    } else {
      currentChunk += (currentChunk ? '\n\n\n' : '') + block
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push({
      index: chunks.length,
      total: 0,
      content: currentChunk.trim()
    })
  }

  // If everything fit in one chunk, just return it
  if (chunks.length === 0 && content.trim().length > 0) {
    chunks.push({ index: 0, total: 1, content: content.trim() })
  }

  return chunks
}

// ── Plain text chunking ──────────────────────────────────────────────────────

/**
 * Split plain text on paragraph boundaries with overlap.
 * Paragraphs are separated by one or more blank lines.
 */
function chunkPlainText(content: string): DocumentChunk[] {
  const paragraphs = content.split(/\n\s*\n/).filter((p) => p.trim().length > 0)

  if (paragraphs.length === 0) return []

  // If content fits in one chunk, return as-is
  if (content.length <= TARGET_CHUNK_CHARS) {
    return [{ index: 0, total: 1, content: content.trim() }]
  }

  const chunks: DocumentChunk[] = []
  let currentChunk = ''
  let overlapBuffer = '' // trailing paragraphs from previous chunk for overlap

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i].trim()

    if (currentChunk.length + para.length + 2 > TARGET_CHUNK_CHARS && currentChunk.length > 0) {
      chunks.push({
        index: chunks.length,
        total: 0,
        content: currentChunk.trim()
      })

      // Build overlap from tail of current chunk
      const overlapChars = Math.floor(TARGET_CHUNK_CHARS * OVERLAP_FRACTION)
      overlapBuffer = currentChunk.slice(-overlapChars)
      currentChunk = overlapBuffer
    }

    currentChunk += (currentChunk ? '\n\n' : '') + para
  }

  if (currentChunk.trim().length > 0) {
    chunks.push({
      index: chunks.length,
      total: 0,
      content: currentChunk.trim()
    })
  }

  return chunks
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Split a long text into roughly equal parts, breaking on line boundaries.
 */
function splitLongText(text: string, maxChars: number): string[] {
  const lines = text.split('\n')
  const parts: string[] = []
  let current = ''

  for (const line of lines) {
    if (current.length + line.length + 1 > maxChars && current.length > 0) {
      parts.push(current)
      current = ''
    }
    current += (current ? '\n' : '') + line
  }

  if (current.length > 0) {
    parts.push(current)
  }

  return parts
}
