import { useRef, useEffect, useState } from 'react'
import { PIXEL_SPRITE_CATALOG, type PixelSpriteEntry } from '@renderer/assets/pixel-office/sprites'

// ── Vite glob import: resolve all sprite PNGs at build time ──

const spriteModules = import.meta.glob<string>('@renderer/assets/pixel-office/sprites/**/*.png', {
  eager: true,
  import: 'default'
})

/** Resolve a catalog entry's src path to an actual Vite-resolved URL */
function resolveSpriteSrc(entry: PixelSpriteEntry): string {
  const relative = entry.src.replace('./', '')
  for (const [key, url] of Object.entries(spriteModules)) {
    if (key.endsWith(relative)) return url
  }
  return entry.src
}

interface PixelSpriteAvatarProps {
  spriteId: string
  size?: number
  className?: string
}

export function PixelSpriteAvatar({
  spriteId,
  size = 32,
  className
}: PixelSpriteAvatarProps): React.JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [loaded, setLoaded] = useState(false)

  const entry = PIXEL_SPRITE_CATALOG.find((e) => e.id === spriteId)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !entry) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const img = new Image()
    img.onload = (): void => {
      ctx.imageSmoothingEnabled = false
      ctx.clearRect(0, 0, size, size)
      // Center frame of row 0 (idle-down) = x:32 y:0 size 32x32
      ctx.drawImage(img, 32, 0, 32, 32, 0, 0, size, size)
      setLoaded(true)
    }
    img.src = resolveSpriteSrc(entry)
  }, [entry, size])

  if (!entry) return null

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className={`block rounded-full ${className ?? ''}`}
      style={{
        width: size,
        height: size,
        imageRendering: 'pixelated',
        opacity: loaded ? 1 : 0
      }}
      aria-label={entry.label}
    />
  )
}
