/**
 * Stage 2: Import extraction utilities for the preprocessing pipeline.
 *
 * Extracted from preprocessing.service.ts — purely functional,
 * no class dependencies.
 */

import type { RawChunk } from '../preprocessing.service'

/**
 * Extract relevant import names from file content that are used in a chunk.
 * Uses regex-based extraction (not AST — good enough for headers).
 */
export function extractRelevantImports(fileContent: string, chunk: RawChunk): string[] {
  const imports: string[] = []

  // Match ES import statements: import { X, Y } from 'module'
  const esImportRegex = /import\s+(?:type\s+)?{([^}]+)}\s+from\s+['"]([^'"]+)['"]/g
  // Match default imports: import X from 'module'
  const defaultImportRegex = /import\s+(?:type\s+)?(\w+)\s+from\s+['"]([^'"]+)['"]/g
  // Match C# using: using Namespace.Type;
  const csharpUsingRegex = /using\s+([\w.]+)\s*;/g

  const allImportedNames: { name: string; module: string }[] = []

  let match: RegExpExecArray | null
  while ((match = esImportRegex.exec(fileContent)) !== null) {
    const names = match[1].split(',').map((n) =>
      n
        .trim()
        .split(/\s+as\s+/)
        .pop()!
        .trim()
    )
    const module = match[2]
    for (const name of names) {
      if (name) allImportedNames.push({ name, module })
    }
  }

  while ((match = defaultImportRegex.exec(fileContent)) !== null) {
    allImportedNames.push({ name: match[1], module: match[2] })
  }

  while ((match = csharpUsingRegex.exec(fileContent)) !== null) {
    const parts = match[1].split('.')
    allImportedNames.push({ name: parts[parts.length - 1], module: match[1] })
  }

  // Filter to imports actually referenced in the chunk body
  for (const imp of allImportedNames) {
    if (chunk.body.includes(imp.name)) {
      imports.push(imp.name)
    }
  }

  return [...new Set(imports)].slice(0, 8)
}
