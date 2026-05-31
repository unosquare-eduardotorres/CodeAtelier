import log from 'electron-log/main'
import { basename, dirname } from 'node:path'
import { memoryCheckpoint } from './indexing-diagnostics'
import { SKIP_PATTERNS, matchesSkipPattern, shouldSkipFile } from './preprocessing/file-validation'
import { extractRelevantImports } from './preprocessing/import-extraction'
import { splitLongChunk } from './preprocessing/chunk-splitting'

// ── Types ──

export interface RawChunk {
  id: string
  filePath: string
  symbolName: string
  symbolKind: 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'const'
  body: string
  startLine: number
  endLine: number
  signature: string
  isPublic: boolean
  isAsync: boolean
  isStatic: boolean
  isAbstract: boolean
  language: string
}

interface ScopeContext {
  className: string
  classKind: 'class' | 'interface' | 'abstract class' | 'record'
  classSignature: string
  classDecorators: string[]
  parentClassImports: string[]
  siblingMethodSignatures: string[]
}

export interface ChunkMetadata {
  filePath: string
  fileName: string
  directory: string
  projectName: string
  symbolName: string
  symbolKind: string
  className: string | null
  signature: string
  startLine: number
  endLine: number
  language: string
  isPublic: boolean
  isAsync: boolean
  isStatic: boolean
  isAbstract: boolean
  hasTests: boolean
  importedBy: string[]
  pageRank: number
  hasDocstring: boolean
  lineCount: number
  hasDescription: boolean
  lastModified: number
  indexedAt: number
}

export interface ProcessedChunk {
  id: string
  embedText: string
  body: string
  metadata: ChunkMetadata
}

export interface PreprocessingOptions {
  generateDescriptions: boolean
  descriptionModel: string
  maxChunkLines: number
  overlapLines: number
  skipPatterns: string[]
  includePrivateMethods: boolean
  includeSiblingSignatures: boolean
  paused: boolean
  cancelled: boolean
}

export const DEFAULT_PREPROCESSING_OPTIONS: PreprocessingOptions = {
  generateDescriptions: false,
  descriptionModel: 'claude-haiku-4-5-20251001',
  maxChunkLines: 80,
  overlapLines: 5,
  skipPatterns: [],
  includePrivateMethods: true,
  includeSiblingSignatures: true,
  paused: false,
  cancelled: false
}

// ── Stage 1: Noise filtering (extracted to preprocessing/file-validation.ts) ──
// Re-export for backward compatibility with external consumers.
export { SKIP_PATTERNS, matchesSkipPattern, shouldSkipFile } from './preprocessing/file-validation'

// ── Stage 2: Context injection (extractRelevantImports extracted to preprocessing/import-extraction.ts) ──
// Re-export for backward compatibility with external consumers.
export { extractRelevantImports } from './preprocessing/import-extraction'

/**
 * Stage 2: Build a structured header to prepend to the chunk for embedding.
 */
export function buildChunkHeader(
  chunk: RawChunk & { imports: string[]; className?: string | null }
): string {
  const parts: string[] = []

  // File path (last 3 segments to keep it concise)
  const shortPath = chunk.filePath.split('/').slice(-3).join('/')
  parts.push(`# File: ${shortPath}`)

  // Language
  parts.push(`# Language: ${chunk.language}`)

  // Scope chain (e.g. "UserService > validateJwt")
  if (chunk.className) {
    parts.push(`# Scope: ${chunk.className} > ${chunk.symbolName}`)
  } else {
    parts.push(`# Scope: ${chunk.symbolName}`)
  }

  // Symbol kind and visibility
  const visibility = chunk.isPublic ? 'public' : 'private'
  parts.push(`# Kind: ${visibility} ${chunk.symbolKind}`)

  // Full signature
  parts.push(`# Signature: ${chunk.signature}`)

  // Key imports used by this chunk
  if (chunk.imports.length > 0) {
    parts.push(`# Uses: ${chunk.imports.join(', ')}`)
  }

  // Blank line separator before code
  parts.push('')

  return parts.join('\n')
}

/**
 * Stage 2: Build the full embed text (header + body).
 */
export function buildEmbedText(
  chunk: RawChunk & { imports: string[]; className?: string | null }
): string {
  return buildChunkHeader(chunk) + chunk.body
}

// ── Stage 3: Scope enrichment ──

/**
 * Stage 3: Build scope contexts for all classes in a file.
 * Groups methods by their parent class and collects sibling signatures.
 */
export function buildScopeContexts(fileTags: RawChunk[]): Map<string, ScopeContext> {
  const contexts = new Map<string, ScopeContext>()

  // Find all classes/interfaces
  const classChunks = fileTags.filter(
    (t) => t.symbolKind === 'class' || t.symbolKind === 'interface'
  )

  for (const cls of classChunks) {
    // Find methods that belong to this class (by line range)
    const methods = fileTags.filter(
      (t) => t.symbolKind === 'method' && t.startLine >= cls.startLine && t.endLine <= cls.endLine
    )

    // Extract decorators from the class body
    const decorators: string[] = []
    const decoratorRegex = /@(\w+)\([^)]*\)/g
    const classHeader = cls.body.split('{')[0] ?? ''
    let match: RegExpExecArray | null
    while ((match = decoratorRegex.exec(classHeader)) !== null) {
      decorators.push(match[0])
    }

    // Determine class kind
    let classKind: ScopeContext['classKind'] = 'class'
    if (cls.symbolKind === 'interface') {
      classKind = 'interface'
    } else if (cls.signature.includes('abstract')) {
      classKind = 'abstract class'
    } else if (cls.signature.includes('record')) {
      classKind = 'record'
    }

    const siblingSignatures = methods.filter((m) => m.isPublic).map((m) => m.signature)

    contexts.set(cls.symbolName, {
      className: cls.symbolName,
      classKind,
      classSignature: cls.signature,
      classDecorators: decorators,
      parentClassImports: [],
      siblingMethodSignatures: siblingSignatures
    })
  }

  return contexts
}

/**
 * Stage 3: Build scope-enriched text to prepend for methods in classes.
 */
export function buildScopeHeader(scope: ScopeContext, includeSiblings: boolean): string {
  const parts: string[] = []
  parts.push(`# Class: ${scope.classSignature}`)

  if (scope.classDecorators.length > 0) {
    parts.push(`# Class decorators: ${scope.classDecorators.join(', ')}`)
  }

  if (includeSiblings && scope.siblingMethodSignatures.length > 0) {
    // Show only method names for brevity
    const shortSigs = scope.siblingMethodSignatures.map((s) => {
      const nameMatch = s.match(/(\w+)\s*\(/)
      return nameMatch ? `${nameMatch[1]}()` : s
    })
    parts.push(`# Other public methods: ${shortSigs.join(', ')}`)
  }

  return parts.join('\n') + '\n'
}

// ── Stage 5: Metadata enrichment ──

/**
 * Stage 5: Build structured metadata for ChromaDB filtered queries.
 */
export function buildMetadata(
  chunk: RawChunk,
  scope: ScopeContext | null,
  projectName: string,
  hasDescription: boolean = false
): ChunkMetadata {
  // Detect if test file exists
  const hasTests =
    chunk.filePath.includes('.test.') ||
    chunk.filePath.includes('.spec.') ||
    chunk.filePath.includes('__tests__')

  // Detect docstring
  const hasDocstring =
    chunk.body.includes('/**') || chunk.body.includes('///') || chunk.body.includes('/// <summary>')

  const lines = chunk.body.split('\n')

  return {
    filePath: chunk.filePath,
    fileName: basename(chunk.filePath),
    directory: dirname(chunk.filePath),
    projectName,
    symbolName: chunk.symbolName,
    symbolKind: chunk.symbolKind,
    className: scope?.className ?? null,
    signature: chunk.signature,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    language: chunk.language,
    isPublic: chunk.isPublic,
    isAsync: chunk.isAsync,
    isStatic: chunk.isStatic,
    isAbstract: chunk.isAbstract,
    hasTests,
    importedBy: [],
    pageRank: 0,
    hasDocstring,
    lineCount: lines.length,
    hasDescription,
    lastModified: Date.now(),
    indexedAt: Date.now()
  }
}

// ── Stage 6: Overlap handling ──

// Stage 6: splitLongChunk extracted to preprocessing/chunk-splitting.ts
// Re-export for backward compatibility with external consumers.
export { splitLongChunk } from './preprocessing/chunk-splitting'

// ── Full pipeline ──

/**
 * Process a single raw chunk through all preprocessing stages.
 * Returns null if the chunk should be skipped.
 */
export function preprocessChunk(
  rawChunk: RawChunk,
  fileContent: string,
  scopeContext: ScopeContext | null,
  projectName: string,
  options: PreprocessingOptions,
  description?: string
): ProcessedChunk[] | null {
  // Skip private methods if configured
  if (!options.includePrivateMethods && !rawChunk.isPublic && rawChunk.symbolKind === 'method') {
    return null
  }

  // Stage 2: Context injection
  const imports = extractRelevantImports(fileContent, rawChunk)
  const chunkWithImports = {
    ...rawChunk,
    imports,
    className: scopeContext?.className ?? null
  }

  let embedText = ''

  // Stage 4: Prepend description if available
  if (description) {
    embedText += description + '\n'
  }

  // Stage 3: Scope enrichment
  if (scopeContext && rawChunk.symbolKind === 'method') {
    embedText += buildScopeHeader(scopeContext, options.includeSiblingSignatures)
  }

  // Stage 2: Header + body
  embedText += buildEmbedText(chunkWithImports)

  // Stage 5: Metadata enrichment
  const metadata = buildMetadata(rawChunk, scopeContext, projectName, !!description)

  const processed: ProcessedChunk = {
    id: rawChunk.id,
    embedText,
    body: rawChunk.body,
    metadata
  }

  // Stage 6: Overlap handling
  const chunks = splitLongChunk(processed, options.maxChunkLines, options.overlapLines)

  // Rebuild embedText for split chunks
  if (chunks.length > 1) {
    for (const chunk of chunks) {
      // Rebuild header for each part with its updated symbolName
      const partChunk = {
        ...rawChunk,
        imports,
        className: scopeContext?.className ?? null,
        symbolName: chunk.metadata.symbolName
      }
      let partEmbedText = ''
      if (description) partEmbedText += description + '\n'
      if (scopeContext && rawChunk.symbolKind === 'method') {
        partEmbedText += buildScopeHeader(scopeContext, options.includeSiblingSignatures)
      }
      partEmbedText += buildChunkHeader(partChunk) + chunk.body
      chunk.embedText = partEmbedText
    }
  }

  return chunks
}

/** Split an array into chunks of a given size. */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size))
  }
  return result
}

/** Find the scope context for a chunk based on its symbol kind. */
function findScopeContext(
  rawChunk: RawChunk,
  scopeContexts: Map<string, ScopeContext>
): ScopeContext | null {
  if (rawChunk.symbolKind !== 'method') return null
  for (const [className, ctx] of scopeContexts) {
    if (
      ctx.siblingMethodSignatures.some((sig) => sig.includes(rawChunk.symbolName)) ||
      className === rawChunk.symbolName
    ) {
      return ctx
    }
  }
  return null
}

/** Batch size for grouping symbols in a single CLI call. */
const DESCRIPTION_BATCH_SIZE = 8

/** Number of concurrent CLI calls for batch description generation. */
const DESCRIPTION_CONCURRENCY = 3

interface DescriptionProgressUpdate {
  descriptionsProcessed: number
  descriptionsTotal: number
  descriptionsCached: number
  descriptionsGenerated: number
}

/**
 * Run the full preprocessing pipeline over a set of raw chunks.
 *
 * When AI descriptions are enabled, uses a 3-phase approach:
 *   Phase 1 — Fast scan: collect all chunks needing descriptions, build embed text
 *   Phase 2 — Batch AI descriptions: generate in batches of 8 with 3 concurrent CLI calls
 *   Phase 3 — Preprocess: apply descriptions + metadata (all sync, fast)
 *
 * Calls onProgress at each file boundary and onDescriptionProgress during Phase 2.
 */
export async function runPreprocessingPipeline(
  tags: RawChunk[],
  fileContents: Map<string, string>,
  projectName: string,
  options: PreprocessingOptions,
  onProgress: (update: {
    processedFiles: number
    totalFiles: number
    processedChunks: number
    totalChunks: number
    skippedFiles: number
    currentFile: string
  }) => void,
  getDescription?: (chunk: RawChunk, embedText: string) => Promise<string | undefined>,
  getBatchDescriptions?: (
    chunks: Array<{ chunk: RawChunk; embedText: string }>
  ) => Promise<{ descriptions: Map<number, string>; cached: number; generated: number }>,
  onDescriptionProgress?: (update: DescriptionProgressUpdate) => void
): Promise<ProcessedChunk[]> {
  const results: ProcessedChunk[] = []

  // Group tags by file
  const fileGroups = new Map<string, RawChunk[]>()
  for (const tag of tags) {
    const group = fileGroups.get(tag.filePath) ?? []
    group.push(tag)
    fileGroups.set(tag.filePath, group)
  }

  const totalFiles = fileGroups.size
  let processedFiles = 0
  let processedChunks = 0
  let skippedFiles = 0

  // Pre-compute scope contexts and filter out skipped files (used in all phases)
  const validFiles: Array<{
    filePath: string
    fileTags: RawChunk[]
    content: string
    scopeContexts: Map<string, ScopeContext>
  }> = []

  for (const [filePath, fileTags] of fileGroups) {
    const content = fileContents.get(filePath)
    if (!content) {
      skippedFiles++
      processedFiles++
      continue
    }
    if (shouldSkipFile(filePath, content, options.skipPatterns)) {
      skippedFiles++
      processedFiles++
      onProgress({
        processedFiles,
        totalFiles,
        processedChunks,
        totalChunks: tags.length,
        skippedFiles,
        currentFile: filePath
      })
      continue
    }
    const scopeContexts = buildScopeContexts(fileTags)
    validFiles.push({ filePath, fileTags, content, scopeContexts })
  }

  // ── Phase 1+2: Batch AI descriptions (only when enabled + batch callback available) ──
  const descriptionMap = new Map<string, string>() // chunkId → description

  if (options.generateDescriptions && getBatchDescriptions) {
    // Phase 1: Collect all chunks that need descriptions (fast)
    const allChunksForDesc: Array<{
      chunkId: string
      chunk: RawChunk
      embedText: string
    }> = []

    for (const { fileTags, content, scopeContexts } of validFiles) {
      for (const rawChunk of fileTags) {
        const scopeContext = findScopeContext(rawChunk, scopeContexts)
        const imports = extractRelevantImports(content, rawChunk)
        const tempEmbedText = buildEmbedText({
          ...rawChunk,
          imports,
          className: scopeContext?.className ?? null
        })
        allChunksForDesc.push({
          chunkId: rawChunk.id,
          chunk: rawChunk,
          embedText: tempEmbedText
        })
      }
    }

    const descriptionsTotal = allChunksForDesc.length
    let descriptionsProcessed = 0
    let totalCached = 0
    let totalGenerated = 0

    memoryCheckpoint('DESC_PHASE_START', {
      descriptionsTotal,
      chunksCollected: allChunksForDesc.length
    })

    onDescriptionProgress?.({
      descriptionsProcessed: 0,
      descriptionsTotal,
      descriptionsCached: 0,
      descriptionsGenerated: 0
    })

    // Phase 2: Batch generate descriptions with limited concurrency
    const batches = chunkArray(allChunksForDesc, DESCRIPTION_BATCH_SIZE)
    const totalDescBatches = batches.length

    for (let i = 0; i < batches.length; i += DESCRIPTION_CONCURRENCY) {
      if (options.cancelled) break

      // Wait while paused
      while (options.paused && !options.cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      if (options.cancelled) break

      const concurrentBatches = batches.slice(i, i + DESCRIPTION_CONCURRENCY)
      const descBatchGroup = Math.floor(i / DESCRIPTION_CONCURRENCY) + 1
      const totalDescGroups = Math.ceil(totalDescBatches / DESCRIPTION_CONCURRENCY)

      // Log first, every 5th, and last batch group
      const isLogGroup =
        descBatchGroup === 1 || descBatchGroup % 5 === 0 || descBatchGroup === totalDescGroups
      if (isLogGroup) {
        memoryCheckpoint(`DESC_BATCH_GROUP_${descBatchGroup}/${totalDescGroups}`, {
          batchesInGroup: concurrentBatches.length,
          descriptionsProcessed
        })
      }

      const batchPromises = concurrentBatches.map((batch) =>
        getBatchDescriptions(batch.map((b) => ({ chunk: b.chunk, embedText: b.embedText })))
      )

      const batchResults = await Promise.all(batchPromises)

      // Map results back to chunk IDs
      for (let bIdx = 0; bIdx < concurrentBatches.length; bIdx++) {
        const batch = concurrentBatches[bIdx]
        const result = batchResults[bIdx]

        for (const [itemIdx, desc] of result.descriptions) {
          descriptionMap.set(batch[itemIdx].chunkId, desc)
        }

        descriptionsProcessed += batch.length
        totalCached += result.cached
        totalGenerated += result.generated
      }

      onDescriptionProgress?.({
        descriptionsProcessed,
        descriptionsTotal,
        descriptionsCached: totalCached,
        descriptionsGenerated: totalGenerated
      })
    }

    memoryCheckpoint('DESC_PHASE_DONE', {
      generated: totalGenerated,
      cached: totalCached,
      total: descriptionsTotal,
      descriptionMapSize: descriptionMap.size
    })

    log.info(
      `[Preprocessing] AI descriptions: ${totalGenerated} generated, ${totalCached} cached, ${descriptionsTotal} total`
    )
  }

  // ── Phase 3: Preprocess all chunks (fast — descriptions already resolved) ──
  memoryCheckpoint('CHUNK_PREPROCESS_START', { validFiles: validFiles.length })
  for (const { filePath, fileTags, content, scopeContexts } of validFiles) {
    if (options.cancelled) {
      log.info('[Preprocessing] Cancelled by user')
      break
    }

    // Wait while paused
    while (options.paused && !options.cancelled) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    for (const rawChunk of fileTags) {
      if (options.cancelled) break

      const scopeContext = findScopeContext(rawChunk, scopeContexts)

      // Look up pre-generated description, or fall back to single-call if no batch
      let description: string | undefined = descriptionMap.get(rawChunk.id)
      if (!description && options.generateDescriptions && getDescription && !getBatchDescriptions) {
        try {
          const imports = extractRelevantImports(content, rawChunk)
          const tempEmbedText = buildEmbedText({
            ...rawChunk,
            imports,
            className: scopeContext?.className ?? null
          })
          description = await getDescription(rawChunk, tempEmbedText)
        } catch (error) {
          log.warn(`[Preprocessing] Description generation failed for ${rawChunk.id}:`, error)
        }
      }

      const processed = preprocessChunk(
        rawChunk,
        content,
        scopeContext,
        projectName,
        options,
        description
      )

      if (processed) {
        results.push(...processed)
      }

      processedChunks++
    }

    processedFiles++
    onProgress({
      processedFiles,
      totalFiles,
      processedChunks,
      totalChunks: tags.length,
      skippedFiles,
      currentFile: filePath
    })
  }

  memoryCheckpoint('CHUNK_PREPROCESS_DONE', {
    resultChunks: results.length,
    processedFiles,
    skippedFiles
  })

  log.info(
    `[Preprocessing] Complete: ${results.length} chunks from ${processedFiles} files (${skippedFiles} skipped)`
  )

  return results
}
