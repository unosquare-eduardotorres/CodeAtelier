/**
 * Theme-aware avatar portrait images.
 * Static imports so Vite bundles, hashes, and tree-shakes each asset.
 * Each theme has its own avatar set; getAvatarImage() resolves with fallback.
 */
import type { AppTheme, UserAvatarVariant } from '../../../../shared/types'

// ── Code Atelier set ──
import caUser1 from './code-atelier/user-1.png'
import caUser2 from './code-atelier/user-2.png'
import caUser3 from './code-atelier/user-3.png'
import caDaVinci from './code-atelier/da-vinci.png'
import caAuditor from './code-atelier/atelier-auditor.png'
import caGrillme from './code-atelier/grillme.png'
import caMain from './code-atelier/mannequin-main.png'

export type AvatarKey =
  | 'user-1'
  | 'user-2'
  | 'user-3'
  | 'da-vinci'
  | 'atelier-auditor'
  | 'grillme'
  | 'mannequin-main'

const AVATAR_SETS: Record<AppTheme, Record<AvatarKey, string>> = {
  'code-atelier': {
    'user-1': caUser1,
    'user-2': caUser2,
    'user-3': caUser3,
    'da-vinci': caDaVinci,
    'atelier-auditor': caAuditor,
    grillme: caGrillme,
    'mannequin-main': caMain
  },
  glass: {
    'user-1': caUser1,
    'user-2': caUser2,
    'user-3': caUser3,
    'da-vinci': caDaVinci,
    'atelier-auditor': caAuditor,
    grillme: caGrillme,
    'mannequin-main': caMain
  },
  porcelain: {
    'user-1': caUser1,
    'user-2': caUser2,
    'user-3': caUser3,
    'da-vinci': caDaVinci,
    'atelier-auditor': caAuditor,
    grillme: caGrillme,
    'mannequin-main': caMain
  },
  // Developer theme reuses Code Atelier avatars (neutral palette works well)
  developer: {
    'user-1': caUser1,
    'user-2': caUser2,
    'user-3': caUser3,
    'da-vinci': caDaVinci,
    'atelier-auditor': caAuditor,
    grillme: caGrillme,
    'mannequin-main': caMain
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

/** Ordered mannequin keys for per-workspace rotation.
 *  Currently one portrait — add keys here when new mannequin images are created. */
export const MANNEQUIN_ROTATION: readonly AvatarKey[] = [
  'mannequin-main'
] as const
