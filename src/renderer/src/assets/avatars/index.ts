/**
 * Theme-aware avatar portrait images.
 * Static imports so Vite bundles, hashes, and tree-shakes each asset.
 * Each theme has its own avatar set; getAvatarImage() resolves with fallback.
 */
import type { AppTheme, UserAvatarVariant } from '../../../../shared/types'

// ── Code Atelier set ──
import caUser from './code-atelier/user.png'
import caUser1 from './code-atelier/user-1.png'
import caUser2 from './code-atelier/user-2.png'
import caUser3 from './code-atelier/user-3.png'
import caDaVinci from './code-atelier/da-vinci.png'
import caAuditor from './code-atelier/atelier-auditor.png'
import caGrillme from './code-atelier/grillme.png'
import caMain from './code-atelier/mannequin-main.png'
import ca2 from './code-atelier/mannequin-2.png'
import ca3 from './code-atelier/mannequin-3.png'
import ca4 from './code-atelier/mannequin-4.png'
import ca5 from './code-atelier/mannequin-5.png'

// ── Glass set ──
import glUser from './glass/user.png'
import glUser1 from './glass/user-1.png'
import glUser2 from './glass/user-2.png'
import glUser3 from './glass/user-3.png'
import glDaVinci from './glass/da-vinci.png'
import glAuditor from './glass/atelier-auditor.png'
import glGrillme from './glass/grillme.png'
import glMain from './glass/mannequin-main.png'
import gl2 from './glass/mannequin-2.png'
import gl3 from './glass/mannequin-3.png'
import gl4 from './glass/mannequin-4.png'
import gl5 from './glass/mannequin-5.png'

// ── Porcelain set ──
import pcUser from './porcelain/user.png'
import pcUser1 from './porcelain/user-1.png'
import pcUser2 from './porcelain/user-2.png'
import pcUser3 from './porcelain/user-3.png'
import pcDaVinci from './porcelain/da-vinci.png'
import pcAuditor from './porcelain/atelier-auditor.png'
import pcGrillme from './porcelain/grillme.png'
import pcMain from './porcelain/mannequin-main.png'
import pc2 from './porcelain/mannequin-2.png'
import pc3 from './porcelain/mannequin-3.png'
import pc4 from './porcelain/mannequin-4.png'
import pc5 from './porcelain/mannequin-5.png'

export type AvatarKey =
  | 'user'
  | 'user-1'
  | 'user-2'
  | 'user-3'
  | 'da-vinci'
  | 'atelier-auditor'
  | 'grillme'
  | 'mannequin-main'
  | 'mannequin-2'
  | 'mannequin-3'
  | 'mannequin-4'
  | 'mannequin-5'

const AVATAR_SETS: Record<AppTheme, Record<AvatarKey, string>> = {
  'code-atelier': {
    user: caUser,
    'user-1': caUser1,
    'user-2': caUser2,
    'user-3': caUser3,
    'da-vinci': caDaVinci,
    'atelier-auditor': caAuditor,
    grillme: caGrillme,
    'mannequin-main': caMain,
    'mannequin-2': ca2,
    'mannequin-3': ca3,
    'mannequin-4': ca4,
    'mannequin-5': ca5
  },
  glass: {
    user: glUser,
    'user-1': glUser1,
    'user-2': glUser2,
    'user-3': glUser3,
    'da-vinci': glDaVinci,
    'atelier-auditor': glAuditor,
    grillme: glGrillme,
    'mannequin-main': glMain,
    'mannequin-2': gl2,
    'mannequin-3': gl3,
    'mannequin-4': gl4,
    'mannequin-5': gl5
  },
  porcelain: {
    user: pcUser,
    'user-1': pcUser1,
    'user-2': pcUser2,
    'user-3': pcUser3,
    'da-vinci': pcDaVinci,
    'atelier-auditor': pcAuditor,
    grillme: pcGrillme,
    'mannequin-main': pcMain,
    'mannequin-2': pc2,
    'mannequin-3': pc3,
    'mannequin-4': pc4,
    'mannequin-5': pc5
  },
  // Developer theme reuses Code Atelier avatars (neutral palette works well)
  developer: {
    user: caUser,
    'user-1': caUser1,
    'user-2': caUser2,
    'user-3': caUser3,
    'da-vinci': caDaVinci,
    'atelier-auditor': caAuditor,
    grillme: caGrillme,
    'mannequin-main': caMain,
    'mannequin-2': ca2,
    'mannequin-3': ca3,
    'mannequin-4': ca4,
    'mannequin-5': ca5
  }
}

/** Resolve avatar image for the active theme, falling back to Code Atelier */
export function getAvatarImage(key: AvatarKey, theme: AppTheme): string {
  return AVATAR_SETS[theme]?.[key] ?? AVATAR_SETS['code-atelier'][key]
}

/** Canonical resolution: user variant preference → concrete AvatarKey.
 *  Used by Avatar component and any direct getAvatarImage callers. */
export function resolveUserAvatarKey(variant: UserAvatarVariant): AvatarKey {
  return `user-${variant}` as AvatarKey
}

/** Display metadata for the avatar picker in settings */
export const USER_AVATAR_OPTIONS: readonly {
  variant: UserAvatarVariant
  label: string
  description: string
}[] = [
  { variant: '1', label: 'The Hooded Artisan', description: 'Mysterious hooded craftsman with jeweled clasp' },
  { variant: '2', label: 'The Scholar', description: 'Renaissance scholar with high Medici collar' },
  { variant: '3', label: 'The Inventor', description: 'Workshop inventor with brass goggles' }
] as const

/** Ordered list of mannequin keys for per-workspace rotation (cycles every 5). */
export const MANNEQUIN_ROTATION: readonly AvatarKey[] = [
  'mannequin-main',
  'mannequin-2',
  'mannequin-3',
  'mannequin-4',
  'mannequin-5'
] as const
