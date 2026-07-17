/**
 * Generates size-optimized icon assets from tiered source PNGs.
 *
 * Each tier has a different detail level, mapped to appropriate icon sizes:
 *   T1 (full glitch)   → 512px, 1024px
 *   T2 (medium glitch) → 128px, 256px
 *   T3 (simple bold)   → 32px, 64px
 *   T4 (pixel glyph)   → 16px
 *
 * Applies macOS squircle mask (border-radius: 22.37%) via Playwright
 * headless Chromium for proper alpha-transparent corners.
 *
 * Usage: npx tsx scripts/render-icon.ts
 * Requirements: playwright (devDependency), sips, iconutil (macOS built-ins)
 */
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const TIERS_DIR = path.join(ROOT, 'resources', 'icon-tiers')

// ── Tier → size slot mapping ────────────────────────────────────────────────

interface TierConfig {
  source: string // filename in icon-tiers/
  sizes: number[] // target pixel sizes this tier covers
}

const TIERS: TierConfig[] = [
  { source: 't1-full.png', sizes: [1024, 512] },
  { source: 't2-medium.png', sizes: [256, 128] },
  { source: 't3-simple.png', sizes: [64, 32] },
  { source: 't4-tiny.png', sizes: [16] },
]

/** Maps each iconset slot filename to its pixel size and source tier index */
const ICONSET_SLOTS: Array<{ name: string; pixelSize: number; tierIndex: number }> = [
  { name: 'icon_512x512@2x.png', pixelSize: 1024, tierIndex: 0 },
  { name: 'icon_512x512.png', pixelSize: 512, tierIndex: 0 },
  { name: 'icon_256x256@2x.png', pixelSize: 512, tierIndex: 0 },
  { name: 'icon_256x256.png', pixelSize: 256, tierIndex: 1 },
  { name: 'icon_128x128@2x.png', pixelSize: 256, tierIndex: 1 },
  { name: 'icon_128x128.png', pixelSize: 128, tierIndex: 1 },
  { name: 'icon_32x32@2x.png', pixelSize: 64, tierIndex: 2 },
  { name: 'icon_32x32.png', pixelSize: 32, tierIndex: 2 },
  { name: 'icon_16x16@2x.png', pixelSize: 32, tierIndex: 2 },
  { name: 'icon_16x16.png', pixelSize: 16, tierIndex: 3 },
]

// ── Squircle mask via Playwright ────────────────────────────────────────────

async function applySquircleMask(
  srcPath: string,
  size: number,
  outPath: string
): Promise<void> {
  const browser = await chromium.launch()
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  })

  // Apple icon grid: artwork occupies 824/1024 (~80.5%) of canvas, centered
  const inner = Math.round(size * (824 / 1024))

  const base64 = fs.readFileSync(srcPath).toString('base64')
  const html = `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; }
  html, body { width: ${size}px; height: ${size}px; background: transparent; overflow: hidden;
               display: flex; align-items: center; justify-content: center; }
  .icon {
    width: ${inner}px;
    height: ${inner}px;
    border-radius: 22.37%;
    overflow: hidden;
    background-image: url(data:image/png;base64,${base64});
    background-size: cover;
  }
</style></head>
<body><div class="icon"></div></body></html>`

  await page.setContent(html, { waitUntil: 'networkidle' })
  await page.screenshot({ path: outPath, omitBackground: true, type: 'png' })
  await browser.close()
}

// ── Resize with sips ────────────────────────────────────────────────────────

async function resizePng(srcPath: string, size: number, outPath: string): Promise<void> {
  const { execSync } = await import('node:child_process')
  execSync(`sips -z ${size} ${size} "${srcPath}" --out "${outPath}"`, { stdio: 'pipe' })
}

// ── ICNS generation ─────────────────────────────────────────────────────────

async function generateIcns(
  sizeToFile: Map<number, string>,
  outPath: string
): Promise<void> {
  const { execSync } = await import('node:child_process')
  const tmpIconset = path.join(ROOT, 'build', 'icon.iconset')

  fs.mkdirSync(tmpIconset, { recursive: true })

  // Copy each tier-specific sized PNG into the iconset with correct naming
  for (const slot of ICONSET_SLOTS) {
    const srcFile = sizeToFile.get(slot.pixelSize)
    if (!srcFile) {
      throw new Error(`No sized PNG found for ${slot.pixelSize}px (slot: ${slot.name})`)
    }
    const dest = path.join(tmpIconset, slot.name)
    // Resize from the tier's masked source to the exact target size
    execSync(`sips -z ${slot.pixelSize} ${slot.pixelSize} "${srcFile}" --out "${dest}"`, {
      stdio: 'pipe',
    })
  }

  // Convert iconset to icns
  execSync(`iconutil -c icns "${tmpIconset}" -o "${outPath}"`, { stdio: 'pipe' })

  // Cleanup iconset
  fs.rmSync(tmpIconset, { recursive: true, force: true })
  console.log(`  ✓ ${path.relative(ROOT, outPath)} (icns — tier-optimized)`)
}

// ── ICO generation ──────────────────────────────────────────────────────────

async function generateIco(pngPath: string, outPath: string): Promise<void> {
  const { execSync } = await import('node:child_process')
  const tmpDir = path.join(ROOT, 'build', 'ico-tmp')
  fs.mkdirSync(tmpDir, { recursive: true })

  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const pngPaths: string[] = []

  for (const s of sizes) {
    const dest = path.join(tmpDir, `${s}.png`)
    execSync(`sips -z ${s} ${s} "${pngPath}" --out "${dest}"`, { stdio: 'pipe' })
    pngPaths.push(dest)
  }

  // Build ICO file manually (ICO format: header + directory entries + PNG data)
  const pngBuffers = pngPaths.map((p) => fs.readFileSync(p))
  const numImages = pngBuffers.length

  // ICO header: 6 bytes
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // Reserved
  header.writeUInt16LE(1, 2) // Type: 1 = ICO
  header.writeUInt16LE(numImages, 4)

  // Directory entries: 16 bytes each
  const dirSize = numImages * 16
  let dataOffset = 6 + dirSize

  const dirEntries: Buffer[] = []
  for (let i = 0; i < numImages; i++) {
    const entry = Buffer.alloc(16)
    const s = sizes[i]
    entry.writeUInt8(s >= 256 ? 0 : s, 0) // Width (0 = 256)
    entry.writeUInt8(s >= 256 ? 0 : s, 1) // Height (0 = 256)
    entry.writeUInt8(0, 2) // Color palette
    entry.writeUInt8(0, 3) // Reserved
    entry.writeUInt16LE(1, 4) // Color planes
    entry.writeUInt16LE(32, 6) // Bits per pixel
    entry.writeUInt32LE(pngBuffers[i].length, 8) // Size of image data
    entry.writeUInt32LE(dataOffset, 12) // Offset to image data
    dataOffset += pngBuffers[i].length
    dirEntries.push(entry)
  }

  const ico = Buffer.concat([header, ...dirEntries, ...pngBuffers])
  fs.writeFileSync(outPath, ico)

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true })
  console.log(`  ✓ ${path.relative(ROOT, outPath)} (ico — T2-based)`)
}

// ── Main pipeline ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Generating tier-optimized icon assets with squircle mask...\n')

  // Validate all tier sources exist
  for (const tier of TIERS) {
    const srcPath = path.join(TIERS_DIR, tier.source)
    if (!fs.existsSync(srcPath)) {
      throw new Error(`Tier source not found: ${srcPath}`)
    }
  }

  const tmpDir = path.join(ROOT, 'build', 'icon-tmp')
  fs.mkdirSync(tmpDir, { recursive: true })

  // 1. Apply squircle mask to each tier at 1024px (large enough for all downscales)
  console.log('Step 1: Applying squircle masks via Playwright...')
  const maskedPaths: string[] = []
  for (let i = 0; i < TIERS.length; i++) {
    const tier = TIERS[i]
    const srcPath = path.join(TIERS_DIR, tier.source)
    const maskedPath = path.join(tmpDir, `masked-t${i + 1}.png`)
    await applySquircleMask(srcPath, 1024, maskedPath)
    maskedPaths.push(maskedPath)
    console.log(`  ✓ T${i + 1} masked (${tier.source})`)
  }

  // 2. Resize each masked tier to its target sizes
  console.log('\nStep 2: Resizing masked tiers to target sizes...')
  const sizeToFile = new Map<number, string>()

  for (let i = 0; i < TIERS.length; i++) {
    const tier = TIERS[i]
    const maskedPath = maskedPaths[i]

    for (const size of tier.sizes) {
      const sizedPath = path.join(tmpDir, `t${i + 1}-${size}.png`)
      if (size === 1024) {
        // Already at 1024px from the mask step
        fs.copyFileSync(maskedPath, sizedPath)
      } else {
        await resizePng(maskedPath, size, sizedPath)
      }
      sizeToFile.set(size, sizedPath)
      console.log(`  ✓ T${i + 1} → ${size}px`)
    }
  }

  // 3. Build .icns with tier-specific artwork per slot
  console.log('\nStep 3: Building icon assets...')
  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true })
  await generateIcns(sizeToFile, path.join(ROOT, 'build', 'icon.icns'))

  // 4. Generate .ico using T2 masked as source (best readability across ICO sizes)
  const t2MaskedPath = maskedPaths[1]
  await generateIco(t2MaskedPath, path.join(ROOT, 'build', 'icon.ico'))

  // 5. Copy T1 masked 1024px → resources/icon.png
  const t1_1024 = sizeToFile.get(1024)!
  fs.copyFileSync(t1_1024, path.join(ROOT, 'resources', 'icon.png'))
  console.log('  ✓ resources/icon.png (T1 @ 1024px with squircle)')

  // 5b. Copy T1 masked 1024px → build/icon.png (Linux electron-builder icon)
  fs.copyFileSync(t1_1024, path.join(ROOT, 'build', 'icon.png'))
  console.log('  ✓ build/icon.png (T1 @ 1024px with squircle)')

  // 6. Resize T1 masked → docs/CodeAtelier/icon_512x512.png
  const docsIconPath = path.join(ROOT, 'docs', 'CodeAtelier', 'icon_512x512.png')
  fs.mkdirSync(path.dirname(docsIconPath), { recursive: true })
  const t1_512 = sizeToFile.get(512)!
  fs.copyFileSync(t1_512, docsIconPath)
  console.log('  ✓ docs/CodeAtelier/icon_512x512.png (T1 @ 512px with squircle)')

  // Cleanup temp files
  fs.rmSync(tmpDir, { recursive: true, force: true })

  console.log('\nDone! All tier-optimized icon assets regenerated.')
}

main().catch((err) => {
  console.error('Failed to render icons:', err)
  process.exit(1)
})
