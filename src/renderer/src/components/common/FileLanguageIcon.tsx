import { memo } from 'react'
import { FileText } from 'lucide-react'
import { FILE_ICONS, EXT_TO_ICON_NAME } from './file-language-icons'

/**
 * Resolve the file extension from a path — handles dotfiles like `.gitignore`
 * (extension = "gitignore") and normal `file.ts` (extension = "ts").
 */
// eslint-disable-next-line react-refresh/only-export-components -- intentional co-located helper export
export function getExtensionForIcon(filePath: string): string {
  const base = filePath.split('/').pop() ?? ''
  if (base.startsWith('.') && base.length > 1) return base.slice(1).toLowerCase()
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

/** Special-cased basenames that have their own icons. */
const BASENAME_OVERRIDES: Record<string, string> = {
  dockerfile: 'file-type-docker',
  'package.json': 'file-type-npm',
  'tsconfig.json': 'file-type-typescript',
  'pnpm-lock.yaml': 'file-type-lock',
  'package-lock.json': 'file-type-lock',
  'yarn.lock': 'file-type-lock',
  'cargo.lock': 'file-type-lock',
  'poetry.lock': 'file-type-lock'
}

function resolveIconName(filePath: string): string | undefined {
  const base = (filePath.split('/').pop() ?? '').toLowerCase()
  const override = BASENAME_OVERRIDES[base]
  if (override && FILE_ICONS[override]) return override
  const ext = getExtensionForIcon(filePath)
  const name = EXT_TO_ICON_NAME[ext]
  return name && FILE_ICONS[name] ? name : undefined
}

interface FileLanguageIconProps {
  filePath: string
  /** Pixel size — default 14. */
  size?: number
  className?: string
}

/**
 * Language/file-type icon rendered from build-time-extracted vscode-icons SVG
 * data. Falls back to a generic lucide FileText icon for unknown types.
 * Icons keep their native brand colors.
 */
function FileLanguageIcon({
  filePath,
  size = 14,
  className
}: FileLanguageIconProps): React.JSX.Element {
  const iconName = resolveIconName(filePath)
  const icon = iconName ? FILE_ICONS[iconName] : undefined

  if (!icon) {
    return <FileText size={size} className={`text-text-muted ${className ?? ''}`} />
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${icon.width} ${icon.height}`}
      className={`flex-shrink-0 ${className ?? ''}`}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: icon.body }}
    />
  )
}

export default memo(FileLanguageIcon)
