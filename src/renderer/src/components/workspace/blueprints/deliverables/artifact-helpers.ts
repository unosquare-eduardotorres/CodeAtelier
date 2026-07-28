/**
 * Pure helpers for finding artifacts in phase data.
 * Separated from shared.tsx to satisfy react-refresh's
 * components-only export requirement.
 */

import type { BlueprintArtifact } from '../../../../../../shared/blueprint-types'

export function findArtifact(
  artifactsJson: BlueprintArtifact[] | undefined,
  ...types: string[]
): BlueprintArtifact | undefined {
  return artifactsJson?.findLast((a) => types.includes(a.type))
}

export function findAllArtifacts(
  artifactsJson: BlueprintArtifact[] | undefined,
  ...types: string[]
): BlueprintArtifact[] {
  return artifactsJson?.filter((a) => types.includes(a.type)) ?? []
}

/**
 * Extract discovery entries from separate 'discoveries' artifacts.
 * Discoveries are stored as `{ type: 'discoveries', contentJson: { phase, entries } }`
 * and should not be looked up inside the main phase-completion contentJson.
 */
export function extractDiscoveries(
  artifactsJson: BlueprintArtifact[] | undefined
): string[] | undefined {
  const discoveryArtifacts = artifactsJson?.filter((a) => a.type === 'discoveries') ?? []
  if (discoveryArtifacts.length === 0) return undefined

  const allEntries: string[] = []
  for (const art of discoveryArtifacts) {
    const entries = (art.contentJson as Record<string, unknown>)?.entries as string[] | undefined
    if (entries?.length) allEntries.push(...entries)
  }
  return allEntries.length > 0 ? allEntries : undefined
}
