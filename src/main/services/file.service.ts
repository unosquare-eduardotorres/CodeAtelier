import { readFileSync, statSync, existsSync } from 'node:fs';

export class FileService {
  private static readonly MAX_FILE_SIZE = 100 * 1024; // 100KB

  readFileContent(filePath: string): string {
    const validation = this.validateFile(filePath);
    if (!validation.valid) {
      throw new Error(validation.error);
    }
    return readFileSync(filePath, 'utf-8');
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  validateFile(filePath: string): { valid: boolean; error?: string } {
    if (!existsSync(filePath)) {
      return { valid: false, error: `File not found: ${filePath}` };
    }

    try {
      const stats = statSync(filePath);

      if (!stats.isFile()) {
        return { valid: false, error: `Not a file: ${filePath}` };
      }

      if (stats.size > FileService.MAX_FILE_SIZE) {
        return {
          valid: false,
          error: `File too large: ${(stats.size / 1024).toFixed(1)}KB (max ${FileService.MAX_FILE_SIZE / 1024}KB)`
        };
      }

      return { valid: true };
    } catch {
      return { valid: false, error: `Cannot access file: ${filePath}` };
    }
  }
}

export const fileService = new FileService();
