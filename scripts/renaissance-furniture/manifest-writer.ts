import path from 'node:path'
import type { FurnitureManifest } from './types'
import { writeJson } from './io'

export function writeManifest(outDir: string, manifest: FurnitureManifest): void {
  writeJson(path.join(outDir, 'manifest.json'), manifest)
}
