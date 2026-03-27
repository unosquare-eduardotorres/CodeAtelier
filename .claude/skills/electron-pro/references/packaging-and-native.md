# Packaging, Distribution, and Native OS Integration

## Auto-updates

Use `electron-updater` (part of electron-builder) or Forge's built-in update support:

```typescript
// main/updater.ts
import { autoUpdater } from 'electron-updater'
import log from 'electron-log'

autoUpdater.logger = log
autoUpdater.autoDownload = false // let user decide

export function initAutoUpdater(win: BrowserWindow) {
  // Check on startup, then every 4 hours
  autoUpdater.checkForUpdates()
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000)

  autoUpdater.on('update-available', (info) => {
    win.webContents.send('update-available', info)
  })

  autoUpdater.on('download-progress', (progress) => {
    win.webContents.send('update-progress', progress.percent)
  })

  autoUpdater.on('update-downloaded', (info) => {
    win.webContents.send('update-downloaded', info)
  })

  autoUpdater.on('error', (err) => {
    log.error('Update error:', err)
  })
}

// Call from renderer via IPC when user confirms
ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall()
})
```

Update server options:

- GitHub Releases (free, simplest for open source)
- Nucleus, Hazel, or custom S3 bucket (for private apps)
- electron-updater supports all of these via `publish` config

## Packaging and distribution

### Option A: Electron Forge (officially recommended)

```bash
# Initialize in existing project
npx electron-forge import

# Build
npx electron-forge make

# Publish
npx electron-forge publish
```

Forge config (`forge.config.ts`):

```typescript
import type { ForgeConfig } from '@electron-forge/shared-types'

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    osxSign: {},
    osxNotarize: {
      appleId: process.env.APPLE_ID!,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD!,
      teamId: process.env.APPLE_TEAM_ID!
    }
  },
  makers: [
    { name: '@electron-forge/maker-squirrel', config: {} }, // Windows
    { name: '@electron-forge/maker-dmg', config: {} }, // macOS
    { name: '@electron-forge/maker-deb', config: {} } // Linux
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: { repository: { owner: 'you', name: 'app' } }
    }
  ]
}

export default config
```

### Option B: electron-builder

```yaml
# electron-builder.yml
appId: com.yourcompany.yourapp
productName: YourApp
directories:
  output: dist
  buildResources: resources
asar: true

mac:
  category: public.app-category.developer-tools
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  notarize: true

win:
  target:
    - target: nsis
      arch: [x64, arm64]
  signingHashAlgorithms: [sha256]

linux:
  target:
    - target: AppImage
    - target: deb
  category: Development

publish:
  provider: github
```

### Code signing checklist

**macOS**: Apple Developer account ($99/year). Set in CI:

- `CSC_LINK` — base64-encoded .p12 certificate
- `CSC_KEY_PASSWORD` — certificate password
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarization

**Windows**: EV code signing certificate (DigiCert, Sectigo) or Azure Trusted Signing. Set:

- `CSC_LINK` — path to .pfx certificate
- `CSC_KEY_PASSWORD` — certificate password

**Linux**: No code signing required, but sign with GPG for apt/rpm repos.

## Native OS integration recipes

### System tray

```typescript
import { Tray, Menu, nativeImage, app } from 'electron'

let tray: Tray | null = null

export function createTray(win: BrowserWindow) {
  const icon = nativeImage.createFromPath(path.join(__dirname, '../../resources/tray-icon.png'))
  tray = new Tray(icon.resize({ width: 16, height: 16 })) // 16x16 for macOS

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => win.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ])

  tray.setToolTip('YourApp')
  tray.setContextMenu(contextMenu)
  tray.on('click', () => win.show())
}
```

### Native menus

```typescript
import { Menu, shell } from 'electron'

const isMac = process.platform === 'darwin'

export function createMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' as const },
    { role: 'editMenu' as const },
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Documentation', click: () => shell.openExternal('https://yourapp.com/docs') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
```

### Deep links / protocol handlers

```typescript
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('yourapp', process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('yourapp')
}

// macOS
app.on('open-url', (_event, url) => {
  // url = yourapp://action/param
})

// Windows/Linux — handle via second-instance
app.on('second-instance', (_event, argv) => {
  const deepLink = argv.find((arg) => arg.startsWith('yourapp://'))
  if (deepLink) {
    /* route it */
  }
})
```

### Window state persistence

```typescript
import Store from 'electron-store'
const store = new Store()

function createWindow() {
  const bounds = store.get('windowBounds', { width: 1200, height: 800 })
  const win = new BrowserWindow({ ...bounds /* webPreferences... */ })

  win.on('close', () => {
    store.set('windowBounds', win.getBounds())
  })
}
```

### OS theme detection

```typescript
import { nativeTheme } from 'electron'

// Get current theme
const isDark = nativeTheme.shouldUseDarkColors

// Listen for changes
nativeTheme.on('updated', () => {
  win.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors)
})
```
