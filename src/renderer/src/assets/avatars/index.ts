/**
 * Theme-aware avatar portrait images.
 * Static imports so Vite bundles, hashes, and tree-shakes each asset.
 * Each theme has its own avatar set; getAvatarImage() resolves with fallback.
 */
import type { AppTheme } from '../../../../shared/types'

// ── Code Atelier set ──
import caUser from './code-atelier/user.png'
import caDaVinci from './code-atelier/da-vinci.png'
import caAuditor from './code-atelier/atelier-auditor.png'
import caGrillme from './code-atelier/grillme.png'
import caMain from './code-atelier/mannequin-main.png'
import ca2 from './code-atelier/mannequin-2.png'
import ca3 from './code-atelier/mannequin-3.png'
import ca4 from './code-atelier/mannequin-4.png'
import ca5 from './code-atelier/mannequin-5.png'

// ── Neon Forge set (placeholders — user will provide custom images) ──
import nfUser from './neon-forge/user.png'
import nfDaVinci from './neon-forge/da-vinci.png'
import nfAuditor from './neon-forge/atelier-auditor.png'
import nfGrillme from './neon-forge/grillme.png'
import nfMain from './neon-forge/mannequin-main.png'
import nf2 from './neon-forge/mannequin-2.png'
import nf3 from './neon-forge/mannequin-3.png'
import nf4 from './neon-forge/mannequin-4.png'
import nf5 from './neon-forge/mannequin-5.png'

// ── Porcelain set (placeholders — user will provide custom images) ──
import pcUser from './porcelain/user.png'
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
    'da-vinci': caDaVinci,
    'atelier-auditor': caAuditor,
    grillme: caGrillme,
    'mannequin-main': caMain,
    'mannequin-2': ca2,
    'mannequin-3': ca3,
    'mannequin-4': ca4,
    'mannequin-5': ca5
  },
  'neon-forge': {
    user: nfUser,
    'da-vinci': nfDaVinci,
    'atelier-auditor': nfAuditor,
    grillme: nfGrillme,
    'mannequin-main': nfMain,
    'mannequin-2': nf2,
    'mannequin-3': nf3,
    'mannequin-4': nf4,
    'mannequin-5': nf5
  },
  porcelain: {
    user: pcUser,
    'da-vinci': pcDaVinci,
    'atelier-auditor': pcAuditor,
    grillme: pcGrillme,
    'mannequin-main': pcMain,
    'mannequin-2': pc2,
    'mannequin-3': pc3,
    'mannequin-4': pc4,
    'mannequin-5': pc5
  }
}

/** Resolve avatar image for the active theme, falling back to Code Atelier */
export function getAvatarImage(key: AvatarKey, theme: AppTheme): string {
  return AVATAR_SETS[theme]?.[key] ?? AVATAR_SETS['code-atelier'][key]
}

/** Ordered list of mannequin keys for per-workspace rotation (cycles every 5). */
export const MANNEQUIN_ROTATION: readonly AvatarKey[] = [
  'mannequin-main',
  'mannequin-2',
  'mannequin-3',
  'mannequin-4',
  'mannequin-5'
] as const
