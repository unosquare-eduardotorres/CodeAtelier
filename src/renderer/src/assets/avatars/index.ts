/**
 * Avatar portrait images.
 * Static imports so Vite bundles, hashes, and tree-shakes each asset.
 */
import atelierAuditorImg from './atelier-auditor.png'
import daVinciImg from './da-vinci.png'
import userImg from './user.png'
import mannequinMainImg from './mannequin-main.png'
import mannequin2Img from './mannequin-2.png'
import mannequin3Img from './mannequin-3.png'
import mannequin4Img from './mannequin-4.png'
import mannequin5Img from './mannequin-5.png'
import grillmeImg from './grillme.png'

export const AVATAR_IMAGES = {
  user: userImg,
  'da-vinci': daVinciImg,
  'atelier-auditor': atelierAuditorImg,
  grillme: grillmeImg,
  'mannequin-main': mannequinMainImg,
  'mannequin-2': mannequin2Img,
  'mannequin-3': mannequin3Img,
  'mannequin-4': mannequin4Img,
  'mannequin-5': mannequin5Img
} as const

export type AvatarKey = keyof typeof AVATAR_IMAGES

/** Ordered list of mannequin keys for per-workspace rotation (cycles every 5). */
export const MANNEQUIN_ROTATION: readonly AvatarKey[] = [
  'mannequin-main',
  'mannequin-2',
  'mannequin-3',
  'mannequin-4',
  'mannequin-5'
] as const
