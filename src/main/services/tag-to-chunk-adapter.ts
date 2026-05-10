import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import type { RawChunk } from './preprocessing.service'

/** Repomap Tag shape (from repomap-mcp tree-sitter output) */
export interface RepomapTag {
  relFname: string
  fname: string
  line: number
  name: string
  kind: 'def' | 'ref'
}

/**
 * Convert repomap definition tags into RawChunks by reading the source files
 * and extracting symbol bodies using simple heuristics (brace/indent counting).
 *
 * Returns both the chunks and a Map of relPath → content for the preprocessing pipeline.
 */
export function convertTagsToChunks(
  tags: RepomapTag[],
  workspacePath: string
): { chunks: RawChunk[]; fileContents: Map<string, string> } {
  // Only process definition tags (not references)
  const defTags = tags.filter((t) => t.kind === 'def')

  // Group by file
  const fileGroups = new Map<string, RepomapTag[]>()
  for (const tag of defTags) {
    const group = fileGroups.get(tag.relFname) ?? []
    group.push(tag)
    fileGroups.set(tag.relFname, group)
  }

  const chunks: RawChunk[] = []
  const fileContents = new Map<string, string>()

  for (const [relFname, fileTags] of fileGroups) {
    const absPath = join(workspacePath, relFname)
    let content: string
    try {
      content = readFileSync(absPath, 'utf-8')
    } catch {
      continue
    }
    fileContents.set(relFname, content)
    const lines = content.split('\n')

    // Sort tags by line number
    const sorted = [...fileTags].sort((a, b) => a.line - b.line)

    for (let i = 0; i < sorted.length; i++) {
      const tag = sorted[i]
      const startLine = tag.line - 1 // 0-indexed
      // End boundary: next tag's start line or end-of-file
      const nextTagLine = i + 1 < sorted.length ? sorted[i + 1].line - 1 : lines.length
      // Extract body using brace matching or simple range
      const endLine = findSymbolEnd(lines, startLine, nextTagLine)
      const body = lines.slice(startLine, endLine).join('\n')

      // Infer metadata from the definition line
      const defLine = lines[startLine] ?? ''
      const symbolKind = inferSymbolKind(defLine)
      const language = inferLanguage(relFname)

      chunks.push({
        id: `${relFname}::${tag.name}::${tag.line}`,
        filePath: relFname,
        symbolName: tag.name,
        symbolKind,
        body,
        startLine: tag.line,
        endLine: startLine + (endLine - startLine),
        signature: extractSignature(defLine),
        isPublic: inferVisibility(defLine),
        isAsync: defLine.includes('async '),
        isStatic: defLine.includes('static '),
        isAbstract: defLine.includes('abstract '),
        language
      })
    }
  }

  log.info(
    `[TagAdapter] Converted ${defTags.length} tags → ${chunks.length} chunks from ${fileGroups.size} files`
  )
  return { chunks, fileContents }
}

/** Find end of symbol body via brace counting */
export function findSymbolEnd(lines: string[], start: number, maxEnd: number): number {
  let braceDepth = 0
  let foundOpen = false
  for (let i = start; i < maxEnd && i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        braceDepth++
        foundOpen = true
      }
      if (ch === '}') braceDepth--
    }
    if (foundOpen && braceDepth <= 0) return i + 1
  }
  return Math.min(maxEnd, lines.length)
}

/** Infer symbol kind from definition line */
export function inferSymbolKind(line: string): RawChunk['symbolKind'] {
  const trimmed = line.trim()
  if (/\bclass\b/.test(trimmed)) return 'class'
  if (/\binterface\b/.test(trimmed)) return 'interface'
  if (/\btype\b/.test(trimmed)) return 'type'
  if (/\benum\b/.test(trimmed)) return 'enum'
  if (/\bconst\b/.test(trimmed)) return 'const'
  if (/\bfunction\b/.test(trimmed)) return 'function'
  // Inside a class → method
  return 'method'
}

/** Infer language from file extension */
export function inferLanguage(filePath: string): string {
  if (filePath.endsWith('.tsx')) return 'tsx'
  if (filePath.endsWith('.ts')) return 'typescript'
  if (filePath.endsWith('.jsx')) return 'jsx'
  if (filePath.endsWith('.js')) return 'javascript'
  if (filePath.endsWith('.cs')) return 'csharp'
  if (filePath.endsWith('.py')) return 'python'
  return 'unknown'
}

/** Infer visibility from definition line */
export function inferVisibility(line: string): boolean {
  if (line.includes('private ') || line.includes('private(')) return false
  if (line.includes('protected ')) return false
  if (line.includes('#')) return false // JS private fields
  return true // default public
}

/** Extract signature (first line up to opening brace) */
export function extractSignature(line: string): string {
  const trimmed = line.trim()
  const braceIdx = trimmed.indexOf('{')
  return braceIdx > 0 ? trimmed.slice(0, braceIdx).trim() : trimmed
}
