// @ts-check
const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')

/**
 * electron-builder afterPack hook:
 *  1. Copy node_modules into the app bundle (bypasses electron-builder's
 *     dependency resolver which OOMs on large trees)
 *  2. Restore original package.json in the app bundle
 *  3. Burn Electron fuses into the packaged binary
 *
 * @param {import('electron-builder').AfterPackContext} context
 */
module.exports = async function afterPack(context) {
  // ── 1. Copy node_modules into the app bundle ───────────────────────────
  // electron-builder doesn't include node_modules (dependencies stripped from
  // package.json to bypass its OOM-prone resolver). We copy them here, before
  // signing, so they're included in the code signature.
  const projectRoot = path.resolve(__dirname, '..')
  const nmSource = path.join(projectRoot, 'node_modules')

  if (fs.existsSync(nmSource)) {
    let appDir
    if (context.electronPlatformName === 'darwin') {
      const appName = context.packager.appInfo.productFilename
      appDir = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources', 'app')
    } else {
      // Windows/Linux: Resources/app/
      appDir = path.join(context.appOutDir, 'resources', 'app')
    }

    const nmTarget = path.join(appDir, 'node_modules')
    console.log(`[afterPack] Copying node_modules to ${nmTarget}`)

    // Use cp -a on macOS/Linux for APFS clonefile (near-instant) and symlink preservation.
    // Fall back to fs.cpSync on Windows.
    if (process.platform === 'win32') {
      fs.cpSync(nmSource, nmTarget, { recursive: true })
    } else {
      execSync(`cp -a "${nmSource}" "${nmTarget}"`, { stdio: 'inherit' })
    }

    const fileCount = execSync(`find "${nmTarget}" -type f | wc -l`, { encoding: 'utf8' }).trim()
    console.log(`[afterPack] node_modules copied (${fileCount} files)`)
  } else {
    console.warn('[afterPack] node_modules not found at project root — skipping copy')
  }

  // ── 2. Restore original package.json in the app bundle ─────────────────
  // During build, dependencies are stripped from package.json to prevent
  // electron-builder from resolving node_modules. Restore the original so
  // the packaged app has a complete package.json (not needed at runtime, but
  // useful for debugging).
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

  // ── 3. Flip Electron fuses ─────────────────────────────────────────────
  let flipFuses, FuseV1Options, FuseVersion
  try {
    ;({ flipFuses, FuseV1Options, FuseVersion } = require('@electron/fuses'))
  } catch {
    console.warn(
      '[afterPack] @electron/fuses not available — skipping fuse flipping (dev deps pruned)'
    )
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
    // No ASAR — app loads from loose files. macOS code signing + hardened
    // runtime + notarization protect integrity instead of ASAR fuse.
    [FuseV1Options.OnlyLoadAppFromAsar]: false
  })

  console.log('[afterPack] Fuses flipped successfully')
}
