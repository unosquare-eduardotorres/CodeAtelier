/**
 * Stage 6: Chunk splitting utilities for the preprocessing pipeline.
 *
 * Extracted from preprocessing.service.ts — purely functional,
 * no class dependencies.
 */

import type { ProcessedChunk } from '../preprocessing.service'

/**
 * Stage 6: Split a chunk that exceeds maxLines with overlapping boundaries.
 */
export function splitLongChunk(
  chunk: ProcessedChunk,
  maxLines: number,
  overlapLines: number
): ProcessedChunk[] {
  const lines = chunk.body.split('\n')
  if (lines.length <= maxLines) return [chunk]

  const parts: ProcessedChunk[] = []
  let start = 0
  let partIndex = 0
  const totalParts = Math.ceil(lines.length / maxLines)

  while (start < lines.length) {
    const end = Math.min(start + maxLines, lines.length)
    const overlap = start > 0 ? lines.slice(start - overlapLines, start) : []
    const partBody = [...overlap, ...lines.slice(start, end)].join('\n')

    const partSymbolName = `${chunk.metadata.symbolName} (part ${partIndex + 1}/${totalParts})`

    parts.push({
      id: `${chunk.id}::part${partIndex}`,
      embedText: chunk.embedText, // Will be rebuilt with updated body
      body: partBody,
      metadata: {
        ...chunk.metadata,
        symbolName: partSymbolName,
        startLine: chunk.metadata.startLine + start - (start > 0 ? overlapLines : 0),
        endLine: chunk.metadata.startLine + end,
        lineCount: partBody.split('\n').length
      }
    })

    start = end
    partIndex++
  }

  return parts
}
