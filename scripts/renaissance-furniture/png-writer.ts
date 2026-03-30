import fs from 'node:fs'
import path from 'node:path'
import type { PNG } from 'pngjs'
import type { GeneratedPng } from './types'
import { ensureDir } from './io'

export function writePngFile(filePath: string, png: PNG): Promise<void> {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(filePath))
    const stream = fs.createWriteStream(filePath)
    stream.on('error', reject)
    stream.on('finish', resolve)
    png.pack().on('error', reject).pipe(stream)
  })
}

export async function writePngSet(outDir: string, pngs: GeneratedPng[]): Promise<void> {
  ensureDir(outDir)
  for (const { fileName, png } of pngs) {
    await writePngFile(path.join(outDir, fileName), png)
  }
}
