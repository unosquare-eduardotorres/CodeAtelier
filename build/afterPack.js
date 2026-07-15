// @ts-check
const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')

/**
 * electron-builder afterPack hook:
 *  1. Copy node_modules into the app bundle (bypasses electron-builder's
 *     dependency resolver which OOMs on large trees)
 *  2. Restore original package.json in the app bundle
 *  3. Strip codesign-problematic files (.lproj, images, .node sections)
 *  4. Burn Electron fuses into the packaged binary
 *
 * @param {import('electron-builder').AfterPackContext} context
 */
module.exports = async function afterPack(context) {
  // ── 1. Copy node_modules into the app bundle ───────────────────────────
  const projectRoot = path.resolve(__dirname, '..')
  const nmSource = path.join(projectRoot, 'node_modules')

  let nmTarget
  if (fs.existsSync(nmSource)) {
    let appDir
    if (context.electronPlatformName === 'darwin') {
      const appName = context.packager.appInfo.productFilename
      appDir = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources', 'app')
    } else {
      appDir = path.join(context.appOutDir, 'resources', 'app')
    }

    nmTarget = path.join(appDir, 'node_modules')
    console.log(`[afterPack] Copying node_modules to ${nmTarget}`)

    if (process.platform === 'win32') {
      fs.cpSync(nmSource, nmTarget, { recursive: true })
    } else {
      execSync(`cp -a "${nmSource}" "${nmTarget}"`, { stdio: 'inherit' })
    }

    const fileCount = execSync(`find "${nmTarget}" -type f | wc -l`, { encoding: 'utf8' }).trim()
    console.log(`[afterPack] node_modules copied (${fileCount} files)`)

    // ── 1b. Remove unnecessary assets that trigger Apple codesign failures ──
    console.log('[afterPack] Pruning non-essential node_modules assets')

    const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico', '.bmp', '.tiff', '.eps'])
    const VIDEO_EXTS = new Set(['.mp4', '.webm', '.ogg', '.mov'])
    const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.d.ts', '.json'])
    const KEEP_IMAGES = new Set(['icon.png', 'icon.icns', 'background.png'])

    let removed = 0
    function prune(dir) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            prune(full)
            if (entry.name === 'node_modules') prune(full)
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase()
            if (dir.includes('iconv-lite/encodings/tables') && ext === '.json') {
              fs.rmSync(full); removed++; continue
            }
            if (IMAGE_EXTS.has(ext) && !KEEP_IMAGES.has(entry.name)) {
              fs.rmSync(full); removed++; continue
            }
            if (VIDEO_EXTS.has(ext)) {
              fs.rmSync(full); removed++; continue
            }
            if (/\b(example|test|demo|docs|samples)\b/i.test(dir)) {
              if (!CODE_EXTS.has(ext) && !entry.name.endsWith('.md')) {
                fs.rmSync(full); removed++; continue
              }
            }
          }
        }
      } catch { /* skip */ }
    }
    prune(nmTarget)
    if (removed) console.log(`[afterPack] Removed ${removed} non-essential file(s)`)

    const afterCount = execSync(`find "${nmTarget}" -type f | wc -l`, { encoding: 'utf8' }).trim()
    console.log(`[afterPack] node_modules: ${fileCount} → ${afterCount} files`)
  } else {
    console.warn('[afterPack] node_modules not found at project root — skipping copy')
  }

  // ── 2. Restore original package.json in the app bundle ─────────────────
  const originalPkg = path.join(projectRoot, 'package.json.original')
  if (fs.existsSync(originalPkg)) {
    let appDir
    if (context.electronPlatformName === 'darwin') {
      const appName = context.packager.appInfo.productFilename
      appDir = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources', 'app')
    } else {
      appDir = path.join(context.appOutDir, 'resources', 'app')
    }
    fs.copyFileSync(originalPkg, path.join(appDir, 'package.json'))
    console.log('[afterPack] Restored original package.json in app bundle')
  }

  // ── 2b. Strip Electron Framework localized .lproj directories ──────────
  // Apple's distribution codesign rejects .pak locale bundles with errSecInternalComponent.
  if (context.electronPlatformName === 'darwin') {
    const frameworkPath = path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
    )
    let lprojRemoved = 0
    function stripLproj(dir) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const full = path.join(dir, entry.name)
            if (entry.name.endsWith('.lproj')) {
              fs.rmSync(full, { recursive: true, force: true })
              lprojRemoved++
            } else {
              stripLproj(full)
            }
          }
        }
      } catch { /* skip */ }
    }
    if (fs.existsSync(frameworkPath)) stripLproj(frameworkPath)
    // Electron binary Resources
    try {
      const eResources = path.join(frameworkPath, 'Resources')
      if (fs.existsSync(eResources)) {
        fs.readdirSync(eResources).forEach(child => {
          if (child.endsWith('.lproj')) {
            fs.rmSync(path.join(eResources, child), { recursive: true, force: true })
            lprojRemoved++
          }
        })
      }
    } catch { /* skip */ }
    if (lprojRemoved) console.log(`[afterPack] Stripped ${lprojRemoved} Electron .lproj dirs`)
  }

  // ── 2c. Strip Mach-O sections from .node native addons ─────────────────
  // Apple's distribution codesign rejects some .node files with errSecInternalComponent.
  // We strip debug/redundant sections to fix this.
  if (nmTarget && context.electronPlatformName === 'darwin') {
    let stripped = 0
    function stripDotNode(dir) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            stripDotNode(full)
          } else if (entry.name.endsWith('.node')) {
            try {
              execSync(`strip -x "${full}"`, { stdio: 'pipe' })
              stripped++
            } catch { /* strip may silently skip — that's ok */ }
          }
        }
      } catch { /* skip */ }
    }
    stripDotNode(nmTarget)
    if (stripped) console.log(`[afterPack] Stripped ${stripped} .node file(s) for codesign`)
  }

  // ── 3. Flip Electron fuses ─────────────────────────────────────────────
  let flipFuses, FuseV1Options, FuseVersion
  try {
    ;({ flipFuses, FuseV1Options, FuseVersion } = require('@electron/fuses'))
  } catch {
    console.warn('[afterPack] @electron/fuses not available — skipping (dev deps pruned)')
    return
  }

  const ext = { darwin: '.app', win32: '.exe', linux: '' }[context.electronPlatformName] || ''
  const executableName = context.packager.appInfo.productFilename + ext
  const executablePath = path.join(context.appOutDir, executableName)

  console.log(`[afterPack] Flipping fuses on: ${executablePath}`)
  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: false
  })
  console.log('[afterPack] Fuses flipped successfully')
}
