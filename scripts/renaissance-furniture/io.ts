import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const FURNITURE_OUTPUT_ROOT = path.join(
  PROJECT_ROOT,
  'src',
  'renderer',
  'src',
  'assets',
  'pixel-office',
  'furniture'
)

export function resolveFurnitureDir(itemId: string): string {
  return path.join(FURNITURE_OUTPUT_ROOT, itemId)
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

export function writeJson(filePath: string, value: unknown): void {
  const serialized = JSON.stringify(value, null, 2) + '\n'
  fs.writeFileSync(filePath, serialized, 'utf-8')
}
