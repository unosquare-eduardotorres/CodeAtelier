import { dynamicItemSpecs } from './dynamic-items'
import { simpleItemSpecs } from './simple-items'
import { structuralItemSpecs } from './structural-items'
import {
  RENAISSANCE_FURNITURE_IDS,
  type RenaissanceFurnitureId,
  type RenaissanceFurnitureSpec
} from './types'

export const renaissanceFurnitureSpecs: RenaissanceFurnitureSpec[] = [
  ...simpleItemSpecs,
  ...structuralItemSpecs,
  ...dynamicItemSpecs
]

function isRenaissanceFurnitureId(value: string): value is RenaissanceFurnitureId {
  return RENAISSANCE_FURNITURE_IDS.includes(value as RenaissanceFurnitureId)
}

export interface RegistryValidationResult {
  duplicateIds: string[]
  unknownIds: string[]
  missingIds: RenaissanceFurnitureId[]
}

export function validateRegistry(specs: RenaissanceFurnitureSpec[]): RegistryValidationResult {
  const idCounts = new Map<string, number>()
  const unknownIds: string[] = []

  for (const spec of specs) {
    idCounts.set(spec.id, (idCounts.get(spec.id) ?? 0) + 1)
    if (!isRenaissanceFurnitureId(spec.id)) {
      unknownIds.push(spec.id)
    }
  }

  const duplicateIds = Array.from(idCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort()

  const missingIds = RENAISSANCE_FURNITURE_IDS.filter((id) => !idCounts.has(id))

  return {
    duplicateIds,
    unknownIds: Array.from(new Set(unknownIds)).sort(),
    missingIds
  }
}
