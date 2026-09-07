// @ts-check
const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')

/** Count files recursively — cross-platform replacement for `find ... | wc -l` */
function countFiles(dir) {
  let count = 0
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile()) count++
      else if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name))
    }
  } catch {
    /* skip unreadable dirs */
  }
  return count
}

/**
 * electron-builder's `Arch` enum, by ordinal. Imported by value rather than
 * from `builder-util` because this hook also runs after `npm prune --omit=dev`,
 * where that package is gone.
 */
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

/** Node platform → the OS token Impeccable publishes under (`win32` → `windows`). */
const IMPECCABLE_OS_TOKENS = { darwin: 'darwin', win32: 'windows', linux: 'linux' }

/**
 * The `@impeccable/cli-*` package(s) a given build target requires.
 *
 * Returns `null` when Impeccable publishes no engine for the target at all
 * (e.g. linux/armv7l) — that is a warning, not a build failure.
 *
 * @param {string} platformName electron-builder's `electronPlatformName`
 * @param {number} archId electron-builder's `Arch` ordinal
 */
function expectedEnginePackages(platformName, archId) {
  const os = IMPECCABLE_OS_TOKENS[platformName]
  const arch = ARCH_NAMES[archId]
  if (!os || !arch) return null
  // A universal mac build must carry both slices; npm only ever installs the
  // host's, so this is reported rather than silently half-satisfied.
  if (arch === 'universal') return [`cli-${os}-arm64`, `cli-${os}-x64`]
  if (arch !== 'x64' && arch !== 'arm64') return null
  return [`cli-${os}-${arch}`]
}

/**
 * Verify the packaged bundle carries the engine for the target being built —
 * not merely *an* engine.
 *
 * Cross-building (e.g. `build-win.sh` on a Mac) copies the host `node_modules`,
 * which contains only `@impeccable/cli-darwin-arm64`. A presence-only check
 * would pass and ship a Mach-O binary inside a Windows app, and the design
 * audit would then fail on the end user's machine — exactly what this assertion
 * exists to prevent.
 *
 * @param {string} nmTarget packaged node_modules directory
 * @param {import('electron-builder').AfterPackContext} context
 */
function assertImpeccableEngine(nmTarget, context) {
  const scopeDir = path.join(nmTarget, '@impeccable')
  const platformName = context.electronPlatformName
  const expected = expectedEnginePackages(platformName, Number(context.arch))

  let present = []
  try {
    present = fs
      .readdirSync(scopeDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('cli-'))
      .map((e) => e.name)
  } catch {
    /* reported below as "none present" */
  }

  if (!expected) {
    console.warn(
      `[afterPack] Impeccable publishes no engine for ${platformName}/${ARCH_NAMES[Number(context.arch)] ?? context.arch} — ` +
        `the design audit will be unavailable in this build (LLM-only degradation).`
    )
    return
  }

  const remedy = (name) =>
    `Install it explicitly before packaging: \`npm install --no-save --force @impeccable/${name}\` ` +
    `(the package is os/cpu-gated, so npm skips it when cross-building).`

  const verified = []
  const missing = []
  for (const name of expected) {
    const exe = name.includes('windows') ? 'impeccable.exe' : 'impeccable'
    const binPath = path.join(scopeDir, name, 'bin', exe)
    let st
    try {
      st = fs.statSync(binPath)
    } catch {
      missing.push({ name, binPath })
      continue
    }
    // cp -a / fs.cpSync preserve mode; verify rather than assume, since a
    // non-executable engine fails at runtime with a confusing EACCES.
    if (process.platform !== 'win32' && !name.includes('windows') && !(st.mode & 0o111)) {
      throw new Error(
        `[afterPack] impeccable engine binary is not executable: ${binPath} ` +
          `(mode ${st.mode.toString(8)})`
      )
    }
    verified.push(`${name} (${(st.size / 1024 / 1024).toFixed(1)} MB)`)
  }

  // Universal builds are satisfied by at least one slice — a hard failure would
  // block a build that still works on the arch we could resolve.
  const isUniversal = expected.length > 1
  if (missing.length && (!isUniversal || verified.length === 0)) {
    const first = missing[0]
    throw new Error(
      `[afterPack] impeccable is a production dependency, but the engine for this build target ` +
        `(${platformName}/${ARCH_NAMES[Number(context.arch)] ?? context.arch}) is missing: ${first.binPath}. ` +
        `Present instead: ${present.length ? present.join(', ') : '(none)'}. ` +
        `Shipping this build would put a wrong-platform or absent engine in the app. ${remedy(first.name)}`
    )
  }
  for (const m of missing) {
    console.warn(`[afterPack] universal build missing one engine slice: ${m.name}`)
  }

  // A foreign engine adds ~12.7 MB of dead weight and, on macOS, an unsigned
  // nested Mach-O that codesign will reject. Surface it rather than ship it.
  const foreign = present.filter((name) => !expected.includes(name))
  if (foreign.length) {
    console.warn(`[afterPack] removing non-target impeccable engine(s): ${foreign.join(', ')}`)
    for (const name of foreign) {
      fs.rmSync(path.join(scopeDir, name), { recursive: true, force: true })
    }
  }

  console.log(`[afterPack] impeccable engine OK for ${platformName}: ${verified.join(', ')}`)
}

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

    const fileCount = countFiles(nmTarget)
    console.log(`[afterPack] node_modules copied (${fileCount} files)`)

    // ── 1b. Remove unnecessary assets that trigger Apple codesign failures ──
    console.log('[afterPack] Pruning non-essential node_modules assets')

    const IMAGE_EXTS = new Set([
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.svg',
      '.webp',
      '.ico',
      '.bmp',
      '.tiff',
      '.eps'
    ])
    const VIDEO_EXTS = new Set(['.mp4', '.webm', '.ogg', '.mov'])
    const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.d.ts', '.json'])
    const KEEP_IMAGES = new Set(['icon.png', 'icon.icns', 'background.png'])

    // Packages whose payload must survive pruning untouched. The Impeccable
    // engine is an extensionless ~12.7 MB Mach-O binary at
    // @impeccable/cli-<os>-<arch>/bin/impeccable; it happens to match none of
    // the rules above today, but that is incidental. Protect it explicitly so a
    // future prune-rule change cannot silently ship a broken design audit.
    const PROTECTED_PATH_PATTERNS = [
      `${path.sep}node_modules${path.sep}@impeccable${path.sep}`,
      `${path.sep}node_modules${path.sep}impeccable${path.sep}`
    ]
    function isProtected(dir) {
      const probe = dir.endsWith(path.sep) ? dir : dir + path.sep
      return PROTECTED_PATH_PATTERNS.some((p) => probe.includes(p))
    }

    let removed = 0
    function prune(dir) {
      if (isProtected(dir)) return
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
              fs.rmSync(full)
              removed++
              continue
            }
            if (IMAGE_EXTS.has(ext) && !KEEP_IMAGES.has(entry.name)) {
              fs.rmSync(full)
              removed++
              continue
            }
            if (VIDEO_EXTS.has(ext)) {
              fs.rmSync(full)
              removed++
              continue
            }
            if (/\b(example|test|demo|docs|samples)\b/i.test(dir)) {
              if (!CODE_EXTS.has(ext) && !entry.name.endsWith('.md')) {
                fs.rmSync(full)
                removed++
                continue
              }
            }
          }
        }
      } catch {
        /* skip */
      }
    }
    prune(nmTarget)
    if (removed) console.log(`[afterPack] Removed ${removed} non-essential file(s)`)

    const afterCount = countFiles(nmTarget)
    console.log(`[afterPack] node_modules: ${fileCount} → ${afterCount} files`)

    // ── 1c. Assert the Impeccable engine payload shipped ──────────────────
    // The design audit resolves this binary at runtime from app.getAppPath().
    // If it is missing we would ship a feature that fails only on the user's
    // machine — fail the build loudly instead.
    let declaresImpeccable = false
    try {
      const rootPkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'))
      declaresImpeccable = Boolean(rootPkg.dependencies && rootPkg.dependencies.impeccable)
    } catch {
      /* no package.json is a separate, louder problem */
    }

    if (declaresImpeccable) {
      assertImpeccableEngine(nmTarget, context)
    }
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
      'Electron Framework.framework'
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
      } catch {
        /* skip */
      }
    }
    if (fs.existsSync(frameworkPath)) stripLproj(frameworkPath)
    // Electron binary Resources
    try {
      const eResources = path.join(frameworkPath, 'Resources')
      if (fs.existsSync(eResources)) {
        fs.readdirSync(eResources).forEach((child) => {
          if (child.endsWith('.lproj')) {
            fs.rmSync(path.join(eResources, child), { recursive: true, force: true })
            lprojRemoved++
          }
        })
      }
    } catch {
      /* skip */
    }
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
            // NOTE: this pass is deliberately `.node`-only. The Impeccable
            // engine is a foreign vendor Mach-O with no extension, so it is
            // never matched here — stripping a third-party signed binary risks
            // corrupting it.
          } else if (entry.name.endsWith('.node')) {
            try {
              execSync(`strip -x "${full}"`, { stdio: 'pipe' })
              stripped++
            } catch {
              /* strip may silently skip — that's ok */
            }
          }
        }
      } catch {
        /* skip */
      }
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
    // OnlyLoadAppFromAsar: false — Required because native N-API modules
    // (better-sqlite3, onnxruntime-web) load .node binaries from outside
    // the ASAR archive via node_modules copied by this afterPack hook.
    // Enabling this fuse would prevent native module loading.
    // See: https://www.electronjs.org/docs/latest/tutorial/fuses
    [FuseV1Options.OnlyLoadAppFromAsar]: false
  })
  console.log('[afterPack] Fuses flipped successfully')
}

// Exposed for direct verification — this mapping is the whole of the
// cross-build guard, and it is not otherwise reachable without running a
// full pack.
module.exports.expectedEnginePackages = expectedEnginePackages
