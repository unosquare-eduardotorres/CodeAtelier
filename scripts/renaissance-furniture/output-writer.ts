import type { GeneratedFurnitureItem } from './types'
import { resolveFurnitureDir } from './io'
import { writeManifest } from './manifest-writer'
import { writePngSet } from './png-writer'

export async function writeGeneratedFurnitureItem(item: GeneratedFurnitureItem): Promise<void> {
  const outDir = resolveFurnitureDir(item.id)
  await writePngSet(outDir, item.pngs)
  writeManifest(outDir, item.manifest)
}
