const MAX_FILES_DISCUSSED = 15

/** A ranked file source for enrichFilesDiscussed. Extensible for future sources (semantic, etc). */
interface FileSource {
  source: string // 'generalist' | 'repomap' | 'semantic'
  files: string[] // ordered by relevance within source
  priority: number // lower = higher precedence (0=generalist, 1=repomap, 2=semantic)
}

/** Parse file paths from repomap text output. Format: `path/file.ts:\n(Rank value: N)` */
export function parseRepomapFiles(mapText: string): string[] {
  const fileLineRegex = /^(\S.*):$/gm
  const files: string[] = []
  let match: RegExpExecArray | null
  while ((match = fileLineRegex.exec(mapText)) !== null) {
    const filePath = match[1]
    if (filePath.includes('/') || filePath.includes('.')) {
      files.push(filePath)
    }
  }
  return files
}

/**
 * Merge multiple ranked file sources into filesDiscussed.
 * Priority-ordered, deduplicated, capped. Returns contributions for logging.
 */
export function enrichFilesDiscussed(
  sources: FileSource[],
  maxFiles = MAX_FILES_DISCUSSED
): { files: string[]; contributions: Record<string, number> } {
  const sorted = [...sources].sort((a, b) => a.priority - b.priority)
  const seen = new Set<string>()
  const merged: string[] = []
  const contributions: Record<string, number> = {}

  for (const source of sorted) {
    let count = 0
    for (const file of source.files) {
      if (merged.length >= maxFiles) break
      const key = file.toLowerCase()
      if (!seen.has(key)) {
        merged.push(file)
        seen.add(key)
        count++
      }
    }
    contributions[source.source] = count
  }
  return { files: merged, contributions }
}

