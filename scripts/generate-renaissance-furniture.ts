import path from 'node:path'
import { renaissanceFurnitureSpecs, validateRegistry } from './renaissance-furniture/registry'
import { FURNITURE_OUTPUT_ROOT } from './renaissance-furniture/io'
import { writeGeneratedFurnitureItem } from './renaissance-furniture/output-writer'

async function main(): Promise<void> {
  const validation = validateRegistry(renaissanceFurnitureSpecs)
  if (
    validation.duplicateIds.length > 0 ||
    validation.unknownIds.length > 0 ||
    validation.missingIds.length > 0
  ) {
    const details = [
      validation.duplicateIds.length > 0
        ? `duplicate: ${validation.duplicateIds.join(', ')}`
        : null,
      validation.unknownIds.length > 0 ? `unknown: ${validation.unknownIds.join(', ')}` : null,
      validation.missingIds.length > 0 ? `missing: ${validation.missingIds.join(', ')}` : null
    ]
      .filter(Boolean)
      .join(' | ')
    throw new Error(`Invalid renaissance furniture registry: ${details}`)
  }

  const implemented = renaissanceFurnitureSpecs.filter(
    (spec) => typeof spec.generator === 'function'
  )
  const pending = renaissanceFurnitureSpecs.filter((spec) => typeof spec.generator !== 'function')

  console.log(
    `Renaissance furniture output root: ${path.relative(process.cwd(), FURNITURE_OUTPUT_ROOT)}`
  )
  console.log(`Total specs: ${renaissanceFurnitureSpecs.length}`)
  console.log(`Implemented generators: ${implemented.length}`)
  console.log(`Pending generators: ${pending.length}`)

  for (const spec of implemented) {
    const item = await spec.generator!()
    if (item.id !== spec.id) {
      throw new Error(`Generator ID mismatch for ${spec.id}: returned ${item.id}`)
    }
    await writeGeneratedFurnitureItem(item)
    console.log(`Generated ${spec.id} (${item.pngs.length} PNG file(s))`)
  }

  if (pending.length > 0) {
    const pendingIds = pending.map((spec) => spec.id).join(', ')
    console.log(`Pending implementation: ${pendingIds}`)
  }
}

main().catch((error) => {
  console.error('Failed to generate renaissance furniture assets:', error)
  process.exit(1)
})
