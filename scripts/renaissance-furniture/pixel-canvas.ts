import { PNG } from 'pngjs'

export interface RgbaColor {
  r: number
  g: number
  b: number
  a?: number
}

const TRANSPARENT: Required<RgbaColor> = { r: 0, g: 0, b: 0, a: 0 }

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function normalizeColor(color: RgbaColor): Required<RgbaColor> {
  return {
    r: clampByte(color.r),
    g: clampByte(color.g),
    b: clampByte(color.b),
    a: clampByte(color.a ?? 255)
  }
}

export class PixelCanvas {
  readonly png: PNG

  constructor(
    public readonly width: number,
    public readonly height: number
  ) {
    this.png = new PNG({ width, height, colorType: 6 })
    this.clear()
  }

  clear(color: RgbaColor = TRANSPARENT): void {
    this.fillRect(0, 0, this.width, this.height, color)
  }

  setPixel(x: number, y: number, color: RgbaColor): void {
    if (!Number.isInteger(x) || !Number.isInteger(y)) return
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return

    const rgba = normalizeColor(color)
    const idx = (this.width * y + x) << 2
    this.png.data[idx] = rgba.r
    this.png.data[idx + 1] = rgba.g
    this.png.data[idx + 2] = rgba.b
    this.png.data[idx + 3] = rgba.a
  }

  fillRect(x: number, y: number, width: number, height: number, color: RgbaColor): void {
    const startX = Math.max(0, x)
    const startY = Math.max(0, y)
    const endX = Math.min(this.width, x + width)
    const endY = Math.min(this.height, y + height)

    for (let py = startY; py < endY; py += 1) {
      for (let px = startX; px < endX; px += 1) {
        this.setPixel(px, py, color)
      }
    }
  }

  strokeRect(x: number, y: number, width: number, height: number, color: RgbaColor): void {
    if (width <= 0 || height <= 0) return
    this.hLine(x, x + width - 1, y, color)
    this.hLine(x, x + width - 1, y + height - 1, color)
    this.vLine(x, y, y + height - 1, color)
    this.vLine(x + width - 1, y, y + height - 1, color)
  }

  hLine(x1: number, x2: number, y: number, color: RgbaColor): void {
    const minX = Math.min(x1, x2)
    const maxX = Math.max(x1, x2)
    for (let x = minX; x <= maxX; x += 1) {
      this.setPixel(x, y, color)
    }
  }

  vLine(x: number, y1: number, y2: number, color: RgbaColor): void {
    const minY = Math.min(y1, y2)
    const maxY = Math.max(y1, y2)
    for (let y = minY; y <= maxY; y += 1) {
      this.setPixel(x, y, color)
    }
  }

  blitCentered(
    draw: (target: PixelCanvas, offsetX: number, offsetY: number) => void,
    spriteWidth: number,
    spriteHeight: number
  ): void {
    const offsetX = Math.floor((this.width - spriteWidth) / 2)
    const offsetY = Math.floor((this.height - spriteHeight) / 2)
    draw(this, offsetX, offsetY)
  }
}

export function createPixelCanvas(width: number, height: number): PixelCanvas {
  return new PixelCanvas(width, height)
}
