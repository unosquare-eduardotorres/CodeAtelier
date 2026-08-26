/**
 * File formats the blueprint attachment zones accept.
 *
 * Shared by the creation form (BlueprintInputView) and the draft editor
 * (DraftPanel) so a format added in one place is accepted in both.
 */

export const ACCEPTED_EXTENSIONS = [
  '.txt',
  '.md',
  '.json',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.sql',
  '.yml',
  '.yaml',
  '.csv',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.pdf',
  '.doc',
  '.docx',
  '.html',
  '.xml',
  '.toml',
  '.env',
  '.sh',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.swift',
  '.rb',
  '.php',
  '.css',
  '.scss'
]

/**
 * react-dropzone `accept` map. The MIME keys are placeholders — dropzone
 * matches on the extension list, and the zones are drag/click-only (no
 * type sniffing), so the key just has to be unique per extension.
 */
export const DROPZONE_ACCEPT: Record<string, string[]> = ACCEPTED_EXTENSIONS.reduce(
  (acc, ext) => {
    acc[`application/${ext.slice(1)}`] = [ext]
    return acc
  },
  {} as Record<string, string[]>
)
