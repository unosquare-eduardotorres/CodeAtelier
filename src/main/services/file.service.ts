import { readFileSync, statSync, existsSync } from 'node:fs'
import { extname } from 'node:path'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

export class FileService {
  private static readonly MAX_FILE_SIZE = 100 * 1024 // 100KB for text files
  private static readonly MAX_IMAGE_SIZE = 5 * 1024 * 1024 // 5MB for images

  readFileContent(filePath: string): string {
    const validation = this.validateFile(filePath)
    if (!validation.valid) {
      throw new Error(validation.error)
    }
    return readFileSync(filePath, 'utf-8')
  }

  isImageFile(filePath: string): boolean {
    return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase())
  }

  readImageAsBase64(filePath: string): { base64: string; mimeType: string } {
    const ext = extname(filePath).toLowerCase()
    const mimeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    }
    const validation = this.validateFile(filePath, FileService.MAX_IMAGE_SIZE)
    if (!validation.valid) {
      throw new Error(validation.error)
    }

    const buffer = readFileSync(filePath)
    return {
      base64: buffer.toString('base64'),
      mimeType: mimeMap[ext] || 'image/png'
    }
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }

  validateFile(filePath: string, maxSize?: number): { valid: boolean; error?: string } {
    if (!existsSync(filePath)) {
      return { valid: false, error: `File not found: ${filePath}` }
    }

    const effectiveMax = maxSize ?? FileService.MAX_FILE_SIZE

    try {
      const stats = statSync(filePath)

      if (!stats.isFile()) {
        return { valid: false, error: `Not a file: ${filePath}` }
      }

      if (stats.size > effectiveMax) {
        return {
          valid: false,
          error: `File too large: ${(stats.size / 1024).toFixed(1)}KB (max ${effectiveMax / 1024}KB)`
        }
      }

      return { valid: true }
    } catch {
      return { valid: false, error: `Cannot access file: ${filePath}` }
    }
  }
}

export const fileService = new FileService()
