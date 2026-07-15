/**
 * file-icons.tsx — Real file-type icons for reference documents.
 *
 * Provides `getRefDocIcon(fileName)` returning a distinct branded icon
 * for each supported file type, replacing the generic 3-icon TYPE_CONFIG.
 */

import React, { type JSX } from 'react'
import { FileText, FileCode2, FileImage, Link2 } from 'lucide-react'

// ── Custom SVG Icons ──

/** Custom Markdown icon — the ⬇M pill glyph in violet */
function MarkdownIcon({ size = 12, className = '' }: { size?: number; className?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect x="1" y="3" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M4 11V5l2.5 3L9 5v6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M11.5 8v3m0 0l1.5-1.5M11.5 11L10 9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

/** PDF badge icon — red file with "PDF" text */
function PdfIcon({ size = 12, className = '' }: { size?: number; className?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M4 1h5.5L13 4.5V14a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
      />
      <path d="M9 1v4h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <text x="4.5" y="12" fontSize="4.5" fontWeight="bold" fill="currentColor" fontFamily="system-ui">PDF</text>
    </svg>
  )
}

/** Word badge icon — blue file with "W" */
function WordIcon({ size = 12, className = '' }: { size?: number; className?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M4 1h5.5L13 4.5V14a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
      />
      <path d="M9 1v4h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <text x="5" y="12.5" fontSize="6" fontWeight="bold" fill="currentColor" fontFamily="system-ui">W</text>
    </svg>
  )
}

// ── Extension → Icon mapping ──

interface FileIconResult {
  icon: React.ComponentType<{ size?: number; className?: string }>
  color: string
  badge?: string
}

const EXT_MAP: Record<string, FileIconResult> = {
  // PDF
  '.pdf': { icon: PdfIcon, color: 'text-red-400' },
  // Word
  '.doc': { icon: WordIcon, color: 'text-blue-400' },
  '.docx': { icon: WordIcon, color: 'text-blue-400' },
  // Markdown
  '.md': { icon: MarkdownIcon, color: 'text-violet-400' },
  '.mdx': { icon: MarkdownIcon, color: 'text-violet-400' },
  // Images
  '.png': { icon: FileImage, color: 'text-cyan-400' },
  '.jpg': { icon: FileImage, color: 'text-cyan-400' },
  '.jpeg': { icon: FileImage, color: 'text-cyan-400' },
  '.gif': { icon: FileImage, color: 'text-cyan-400' },
  '.webp': { icon: FileImage, color: 'text-cyan-400' },
  '.svg': { icon: FileImage, color: 'text-cyan-400' },
  // Code
  '.ts': { icon: FileCode2, color: 'text-blue-300' },
  '.tsx': { icon: FileCode2, color: 'text-blue-300' },
  '.js': { icon: FileCode2, color: 'text-yellow-400' },
  '.jsx': { icon: FileCode2, color: 'text-yellow-400' },
  '.py': { icon: FileCode2, color: 'text-emerald-400' },
  '.rs': { icon: FileCode2, color: 'text-orange-400' },
  '.go': { icon: FileCode2, color: 'text-cyan-300' },
  '.java': { icon: FileCode2, color: 'text-orange-300' },
  '.kt': { icon: FileCode2, color: 'text-purple-400' },
  '.swift': { icon: FileCode2, color: 'text-orange-400' },
  '.rb': { icon: FileCode2, color: 'text-red-300' },
  '.php': { icon: FileCode2, color: 'text-indigo-400' },
  '.css': { icon: FileCode2, color: 'text-blue-300' },
  '.scss': { icon: FileCode2, color: 'text-pink-400' },
  '.html': { icon: FileCode2, color: 'text-orange-300' },
  '.sql': { icon: FileCode2, color: 'text-blue-400' },
  '.sh': { icon: FileCode2, color: 'text-green-400' },
  // Data
  '.json': { icon: FileText, color: 'text-green-400' },
  '.csv': { icon: FileText, color: 'text-green-400' },
  '.yaml': { icon: FileText, color: 'text-green-400' },
  '.yml': { icon: FileText, color: 'text-green-400' },
  '.xml': { icon: FileText, color: 'text-green-300' },
  '.toml': { icon: FileText, color: 'text-green-300' },
  // Plain text
  '.txt': { icon: FileText, color: 'text-slate-400' },
  '.env': { icon: FileText, color: 'text-slate-400' }
}

const URL_ICON: FileIconResult = { icon: Link2, color: 'text-purple-400' }
const DEFAULT_ICON: FileIconResult = { icon: FileText, color: 'text-slate-400' }

/**
 * Get the icon component and color for a given file name.
 * Falls back to generic FileText for unknown extensions.
 */
export function getRefDocIcon(fileName: string, type?: string): FileIconResult {
  if (type === 'url') return URL_ICON

  const dotIdx = fileName.lastIndexOf('.')
  if (dotIdx === -1) return DEFAULT_ICON

  const ext = fileName.slice(dotIdx).toLowerCase()
  return EXT_MAP[ext] ?? DEFAULT_ICON
}

export { MarkdownIcon, PdfIcon, WordIcon }
