/**
 * Renders icon.svg → PNG at multiple sizes, then generates .icns and .ico
 *
 * Usage: npx tsx scripts/render-icon.ts
 *
 * Requirements: playwright (already in devDependencies)
 */
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SVG_PATH = path.join(ROOT, 'docs', 'CodeAtelier', 'icon.svg')

interface RenderTarget {
  outPath: string
  size: number
}

const TARGETS: RenderTarget[] = [
  { outPath: path.join(ROOT, 'build', 'icon.png'), size: 1024 },
  { outPath: path.join(ROOT, 'resources', 'icon.png'), size: 1024 },
  { outPath: path.join(ROOT, 'docs', 'CodeAtelier', 'icon_512x512.png'), size: 512 }
]

async function renderSvgToPng(svgContent: string, size: number, outPath: string): Promise<void> {
  const browser = await chromium.launch()
  const page = await browser.newPage({
    viewport: { width: size, height: size }
  })

  const html = `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; }
  body { width: ${size}px; height: ${size}px; background: transparent; }
  img { width: ${size}px; height: ${size}px; }
</style>
</head>
<body>
  <img src="data:image/svg+xml;base64,${Buffer.from(svgContent).toString('base64')}" />
</body>
</html>`

  await page.setContent(html, { waitUntil: 'networkidle' })

  // Wait a bit for fonts to settle
  await page.waitForTimeout(500)

  await page.screenshot({
    path: outPath,
    omitBackground: true, // Critical: transparent gutter
    type: 'png'
  })

  await browser.close()
  console.log(`  ✓ ${path.relative(ROOT, outPath)} (${size}×${size})`)
}

async function generateIcns(pngPath: string, outPath: string): Promise<void> {
  const { execSync } = await import('node:child_process')
  const tmpIconset = path.join(ROOT, 'build', 'icon.iconset')

  // Create iconset directory
  fs.mkdirSync(tmpIconset, { recursive: true })

  // Generate all required sizes using sips
  const sizes = [16, 32, 64, 128, 256, 512, 1024]
  for (const s of sizes) {
    const name = s === 1024 ? 'icon_512x512@2x.png' : s === 64 ? 'icon_32x32@2x.png' : `icon_${s}x${s}.png`
    const dest = path.join(tmpIconset, name)
    execSync(`sips -z ${s} ${s} "${pngPath}" --out "${dest}"`, { stdio: 'pipe' })

    // Also create @2x variants where needed
    if (s <= 512 && s !== 64) {
      const retinaSize = s * 2
      if (retinaSize <= 1024) {
        const retinaName = `icon_${s}x${s}@2x.png`
        const retinaDest = path.join(tmpIconset, retinaName)
        execSync(`sips -z ${retinaSize} ${retinaSize} "${pngPath}" --out "${retinaDest}"`, { stdio: 'pipe' })
      }
    }
  }

  // Convert iconset to icns
  execSync(`iconutil -c icns "${tmpIconset}" -o "${outPath}"`, { stdio: 'pipe' })

  // Cleanup iconset
  fs.rmSync(tmpIconset, { recursive: true, force: true })
  console.log(`  ✓ ${path.relative(ROOT, outPath)} (icns)`)
}

async function generateIco(pngPath: string, outPath: string): Promise<void> {
  // Generate ICO using sharp-free approach: embed PNGs of various sizes into ICO format
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
  console.log(`  ✓ ${path.relative(ROOT, outPath)} (ico)`)
}

async function main(): Promise<void> {
  console.log('Rendering icon assets...\n')

  const svgContent = fs.readFileSync(SVG_PATH, 'utf-8')

  // Render PNGs
  for (const target of TARGETS) {
    await renderSvgToPng(svgContent, target.size, target.outPath)
  }

  const mainPng = path.join(ROOT, 'build', 'icon.png')

  // Generate .icns (macOS)
  console.log('')
  await generateIcns(mainPng, path.join(ROOT, 'build', 'icon.icns'))

  // Generate .ico (Windows)
  await generateIco(mainPng, path.join(ROOT, 'build', 'icon.ico'))

  console.log('\nDone! All icon assets regenerated.')
}

main().catch((err) => {
  console.error('Failed to render icons:', err)
  process.exit(1)
})
