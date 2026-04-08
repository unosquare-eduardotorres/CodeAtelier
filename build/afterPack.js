// @ts-check
const { FuseV1Options, FuseVersion, flipFuses } = require('@electron/fuses')
const path = require('path')

/**
 * electron-builder afterPack hook — burns Electron fuses into the packaged binary.
 *
 * Fuses are compile-time security flags that disable dangerous runtime features:
 * - RunAsNode: prevents ELECTRON_RUN_AS_NODE env var from turning the app into a Node.js script
 * - EnableNodeOptionsEnvironmentVariable: blocks NODE_OPTIONS injection
 * - EnableNodeCliInspectArguments: blocks --inspect debugging in production
 * - OnlyLoadAppFromAsar: prevents loading unpackaged app code
 *
 * @param {import('electron-builder').AfterPackContext} context
 */
module.exports = async function afterPack(context) {
  const ext = { darwin: '.app', win32: '.exe', linux: '' }[context.electronPlatformName] || ''
  const executableName = context.packager.appInfo.productFilename + ext
  const executablePath = path.join(context.appOutDir, executableName)

  console.log(`[afterPack] Flipping fuses on: ${executablePath}`)

  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true
  })

  console.log('[afterPack] Fuses flipped successfully')
}
