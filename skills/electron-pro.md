---
name: electron-pro
description: Use this skill for ANY Electron desktop application work — creating new apps, debugging IPC issues, configuring builds, setting up auto-updates, code signing, native OS integration, or optimizing performance. Trigger whenever the user mentions Electron, BrowserWindow, main process, renderer process, preload scripts, electron-builder, electron-forge, contextBridge, ipcMain/ipcRenderer, desktop app packaging, or cross-platform desktop development. Also trigger for Tauri-to-Electron migration questions, choosing between desktop frameworks, Electron security hardening, IPC patterns, or context isolation questions.
---

# Electron Pro

> **Skill version**: 2.0  
> **Last updated**: 2026-03-21  
> **Electron version covered**: 28 — 41  
> **Next review date**: 2026-06-21 (quarterly, or on Electron major release)

Build secure, performant, cross-platform desktop applications with Electron 28+.

## Before you start

1. Check the project's Electron version: `npx electron --version`. These instructions target Electron 28+ (which enforces context isolation and sandbox by default). For older versions, flag the upgrade path first.
2. Identify the target platforms (Windows, macOS, Linux) — this affects signing, packaging, and native module compilation.
3. Confirm the frontend framework in use (React, Vue, Svelte, vanilla) — this determines the renderer setup and HMR configuration.
4. Choose your build tool: **Electron Forge** (officially recommended, integrated workflow) or **electron-builder** (more mature, broader community). This skill covers both.

## Project structure

Always scaffold Electron projects with clear process separation:

```
my-app/
├── src/
│   ├── main/              # Main process code (Node.js environment)
│   │   ├── index.ts       # Entry point — app lifecycle, window creation
│   │   ├── ipc-handlers.ts # All ipcMain.handle() registrations
│   │   ├── menu.ts        # Native menu construction
│   │   ├── tray.ts        # System tray setup
│   │   └── updater.ts     # Auto-update logic
│   ├── preload/
│   │   └── index.ts       # contextBridge.exposeInMainWorld() — the ONLY bridge
│   ├── renderer/          # Frontend code (React/Vue/Svelte/vanilla)
│   │   └── ...
│   └── shared/            # Types and constants shared across processes
│       ├── ipc-channels.ts # Channel name constants (single source of truth)
│       └── types.ts       # Shared TypeScript interfaces
├── resources/             # App icons, platform-specific assets
├── electron-builder.yml   # OR forge.config.ts
├── package.json
└── tsconfig.json
```

Key rules:
- Never put main process logic in the renderer folder or vice versa.
- Every IPC channel name must be defined in `shared/ipc-channels.ts` — no magic strings.
- The preload script is the ONLY place where Node/Electron APIs cross into the renderer.
- The main process is a Node.js environment with full system access. Each BrowserWindow spawns a separate renderer process that behaves like a web page — it has NO direct access to Node.js APIs.

## Security — non-negotiable defaults

Electron is NOT a web browser. Your code has full system access. Follow all 20 items from the official Electron security checklist. The critical ones:

```typescript
// main/index.ts — BrowserWindow creation
const win = new BrowserWindow({
  webPreferences: {
    contextIsolation: true,      // NEVER set to false (default since Electron 12)
    nodeIntegration: false,      // NEVER set to true (default since Electron 5)
    sandbox: true,               // Enable renderer sandboxing (default since Electron 28)
    preload: path.join(__dirname, '../preload/index.js'),
    webSecurity: true,           // NEVER disable — enforces same-origin policy
  },
});
```

### Content Security Policy

Always define a CSP. Set via HTML meta tag or session headers:

```typescript
// main/index.ts — set CSP via session (preferred — can't be overridden by renderer)
session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
  callback({
    responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': [
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"
      ],
    },
  });
});
```

### Validate IPC sender

Always verify that IPC messages come from expected sources — a compromised renderer could send malicious messages:

```typescript
// main/ipc-handlers.ts — validate sender origin
ipcMain.handle('sensitive-action', async (event) => {
  // Verify the sender is your app's window, not a rogue webview
  const senderUrl = event.senderFrame.url;
  if (!senderUrl.startsWith('file://') && !senderUrl.startsWith('https://yourdomain.com')) {
    throw new Error('Unauthorized IPC sender');
  }
  // ... proceed with action
});
```

### Permission request handling

Control what web permissions (camera, microphone, geolocation, notifications) your app grants:

```typescript
// main/index.ts — restrict permissions
session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
  const allowedPermissions = ['notifications']; // only what your app needs
  callback(allowedPermissions.includes(permission));
});
```

### shell.openExternal safety

Never pass untrusted URLs to `shell.openExternal` — it can execute arbitrary protocols:

```typescript
// ❌ DANGEROUS — user-supplied URL could be file://, smb://, or custom protocol
shell.openExternal(userProvidedUrl);

// ✅ SAFE — validate protocol first
function safeOpenExternal(url: string) {
  const parsed = new URL(url);
  if (['https:', 'http:', 'mailto:'].includes(parsed.protocol)) {
    shell.openExternal(url);
  }
}
```

### Navigation and new window restrictions

Prevent your app from navigating to untrusted origins:

```typescript
// main/index.ts — lock down navigation
win.webContents.on('will-navigate', (event, url) => {
  const parsed = new URL(url);
  if (parsed.origin !== 'file://') {
    event.preventDefault(); // block navigation to external sites
  }
});

// Prevent new windows from being opened
win.webContents.setWindowOpenHandler(({ url }) => {
  // Open external links in the user's browser instead
  if (url.startsWith('https://')) {
    shell.openExternal(url);
  }
  return { action: 'deny' }; // never open new Electron windows from links
});
```

If the user asks you to disable contextIsolation or enable nodeIntegration, explain why this is dangerous and provide the secure alternative using preload + contextBridge instead.

## IPC communication — the correct patterns

IPC is the ONLY way for renderer and main processes to communicate. There are 4 patterns (from the official docs). Use the right one for each case:

### Pattern 1: Renderer → Main (two-way, use for most cases)

Use `ipcRenderer.invoke` / `ipcMain.handle` — returns a Promise, propagates errors:

```typescript
// shared/ipc-channels.ts
export const IPC = {
  GET_SYSTEM_INFO: 'system:get-info',
  SAVE_FILE: 'file:save',
  OPEN_DIALOG: 'dialog:open',
  READ_SETTINGS: 'settings:read',
  WRITE_SETTINGS: 'settings:write',
} as const;
```

```typescript
// preload/index.ts — expose typed API to renderer
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

const electronAPI = {
  getSystemInfo: () => ipcRenderer.invoke(IPC.GET_SYSTEM_INFO),
  saveFile: (data: string) => ipcRenderer.invoke(IPC.SAVE_FILE, data),
  openDialog: () => ipcRenderer.invoke(IPC.OPEN_DIALOG),
  readSettings: () => ipcRenderer.invoke(IPC.READ_SETTINGS),
  writeSettings: (settings: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC.WRITE_SETTINGS, settings),
} as const;

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// Export type for renderer TypeScript usage
export type ElectronAPI = typeof electronAPI;
```

```typescript
// shared/types.ts — type the window global for renderer
import type { ElectronAPI } from '../preload/index';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
```

```typescript
// main/ipc-handlers.ts — register handlers with input validation
import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPC } from '../shared/ipc-channels';

export function registerIpcHandlers() {
  ipcMain.handle(IPC.GET_SYSTEM_INFO, async () => {
    return { platform: process.platform, arch: process.arch, version: process.versions.electron };
  });

  ipcMain.handle(IPC.SAVE_FILE, async (_event, data: string) => {
    if (typeof data !== 'string' || data.length > 10_000_000) {
      throw new Error('Invalid data');
    }
    // ... save logic
  });

  ipcMain.handle(IPC.OPEN_DIALOG, async () => {
    return dialog.showOpenDialog({ properties: ['openFile'] });
  });
}
```

### Pattern 2: Renderer → Main (one-way, fire-and-forget)

Use `ipcRenderer.send` / `ipcMain.on` — for actions where you don't need a response:

```typescript
// preload — fire-and-forget
contextBridge.exposeInMainWorld('electronAPI', {
  setTitle: (title: string) => ipcRenderer.send('set-title', title),
});

// main — handle without returning
ipcMain.on('set-title', (event, title: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.setTitle(title);
});
```

### Pattern 3: Main → Renderer (push events)

Use `webContents.send` in main, listen via preload-exposed callback:

```typescript
// preload — expose event subscription with cleanup
contextBridge.exposeInMainWorld('electronAPI', {
  onUpdateAvailable: (callback: (info: any) => void) => {
    const handler = (_event: any, info: any) => callback(info);
    ipcRenderer.on('update-available', handler);
    return () => ipcRenderer.removeListener('update-available', handler);
  },
  onMenuAction: (callback: (action: string) => void) => {
    const handler = (_event: any, action: string) => callback(action);
    ipcRenderer.on('menu-action', handler);
    return () => ipcRenderer.removeListener('menu-action', handler);
  },
});

// main — push to renderer
win.webContents.send('update-available', updateInfo);
```

### Pattern 4: Renderer ↔ Renderer (via main as broker)

Use MessagePorts for direct renderer-to-renderer communication when needed:

```typescript
// main — create message channel between two windows
const { port1, port2 } = new MessageChannelMain();
win1.webContents.postMessage('port', null, [port1]);
win2.webContents.postMessage('port', null, [port2]);
```

### IPC anti-patterns — never do these

```typescript
// ❌ NEVER expose raw ipcRenderer — allows renderer to call ANY channel
contextBridge.exposeInMainWorld('ipc', { send: ipcRenderer.send });

// ❌ NEVER use sendSync — blocks the renderer main thread
const result = ipcRenderer.sendSync('get-data');

// ❌ NEVER use ipcRenderer.send for request-response — no error propagation
ipcRenderer.send('get-data'); // can't await this
```

## Auto-updates

Use `electron-updater` (part of electron-builder) or Forge's built-in update support:

```typescript
// main/updater.ts
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';

autoUpdater.logger = log;
autoUpdater.autoDownload = false; // let user decide

export function initAutoUpdater(win: BrowserWindow) {
  // Check on startup, then every 4 hours
  autoUpdater.checkForUpdates();
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);

  autoUpdater.on('update-available', (info) => {
    win.webContents.send('update-available', info);
  });

  autoUpdater.on('download-progress', (progress) => {
    win.webContents.send('update-progress', progress.percent);
  });

  autoUpdater.on('update-downloaded', (info) => {
    win.webContents.send('update-downloaded', info);
  });

  autoUpdater.on('error', (err) => {
    log.error('Update error:', err);
  });
}

// Call from renderer via IPC when user confirms
ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall();
});
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
import type { ForgeConfig } from '@electron-forge/shared-types';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    osxSign: {},
    osxNotarize: {
      appleId: process.env.APPLE_ID!,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD!,
      teamId: process.env.APPLE_TEAM_ID!,
    },
  },
  makers: [
    { name: '@electron-forge/maker-squirrel', config: {} },   // Windows
    { name: '@electron-forge/maker-dmg', config: {} },         // macOS
    { name: '@electron-forge/maker-deb', config: {} },         // Linux
  ],
  publishers: [
    { name: '@electron-forge/publisher-github', config: { repository: { owner: 'you', name: 'app' } } },
  ],
};

export default config;
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

## Performance — measure, then optimize

The official Electron docs emphasize: profile first, optimize second. Don't guess.

| Metric | Target | How to measure |
|--------|--------|----------------|
| Cold startup | < 3s | `process.hrtime()` from app ready to first paint |
| Idle memory | < 200MB | Task Manager / Activity Monitor |
| Animation | 60 FPS | DevTools Performance tab |
| Installer size | < 100MB | Check `dist/` output |

### Defer module loading

The #1 performance killer is importing heavy modules at startup. Electron apps are not Node.js servers — startup time matters:

```typescript
// ❌ BAD — loads everything at startup, even if unused
import * as xlsx from 'xlsx';
import * as sharp from 'sharp';

// ✅ GOOD — lazy import when actually needed
async function processExcel(filePath: string) {
  const xlsx = await import('xlsx');
  return xlsx.readFile(filePath);
}
```

Profile module weight before adding dependencies:
```bash
# Measure CPU + memory cost of requiring a module
node --cpu-prof --heap-prof -e "require('the-module')"
```

### Other key optimizations
- **Lazy-load windows**: don't create BrowserWindow instances until needed.
- **Stagger initialization**: use `app.whenReady()` + `setTimeout` for non-critical work.
- **Don't call `Menu.setApplicationMenu(null)`** if you want no menu — but DO call it, because Electron creates a default menu that costs resources. If you need no menu, explicitly set null.
- **Bundle your renderer code** with webpack, Vite, or esbuild — don't ship raw `node_modules` to the renderer.
- **Avoid unnecessary polyfills**: Electron ships a current Chromium — you don't need Babel/core-js for modern JS features.
- **Profile with `--inspect`**: `electron --inspect=9229 .` and connect Chrome DevTools.

## Native OS integration recipes

### System tray
```typescript
import { Tray, Menu, nativeImage, app } from 'electron';

let tray: Tray | null = null;

export function createTray(win: BrowserWindow) {
  const icon = nativeImage.createFromPath(
    path.join(__dirname, '../../resources/tray-icon.png')
  );
  tray = new Tray(icon.resize({ width: 16, height: 16 })); // 16x16 for macOS

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => win.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setToolTip('YourApp');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => win.show());
}
```

### Native menus
```typescript
import { Menu, shell } from 'electron';

const isMac = process.platform === 'darwin';

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
        { role: 'zoomOut' as const },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Documentation', click: () => shell.openExternal('https://yourapp.com/docs') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
```

### Deep links / protocol handlers
```typescript
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('yourapp', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('yourapp');
}

// macOS
app.on('open-url', (_event, url) => {
  // url = yourapp://action/param
});

// Windows/Linux — handle via second-instance
app.on('second-instance', (_event, argv) => {
  const deepLink = argv.find(arg => arg.startsWith('yourapp://'));
  if (deepLink) { /* route it */ }
});
```

### Window state persistence
```typescript
import Store from 'electron-store';
const store = new Store();

function createWindow() {
  const bounds = store.get('windowBounds', { width: 1200, height: 800 });
  const win = new BrowserWindow({ ...bounds, /* webPreferences... */ });

  win.on('close', () => {
    store.set('windowBounds', win.getBounds());
  });
}
```

### OS theme detection
```typescript
import { nativeTheme } from 'electron';

// Get current theme
const isDark = nativeTheme.shouldUseDarkColors;

// Listen for changes
nativeTheme.on('updated', () => {
  win.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors);
});
```

## Common pitfalls — check for these

1. **White screen on startup**: wrong `loadFile`/`loadURL` path. Log the resolved path and verify it exists. Common when using bundlers that change output directories.
2. **IPC not working**: preload path must point to compiled JS, not TS source. Always use `path.join(__dirname, ...)`, never relative paths.
3. **Native modules crash**: run `npx electron-rebuild` after installing native deps. Forge does this automatically. Also check that the native module supports your Electron version's Node.js ABI.
4. **App rejected by macOS notarization**: ensure `hardenedRuntime: true`, proper entitlements, and no unsigned binaries in the `.app` bundle. Run `codesign --verify --deep --strict YourApp.app` to check.
5. **Huge installer size**: check for accidentally bundled `node_modules`. Use `files` config in electron-builder to exclude dev deps. Consider `asar: true` (default). Audit with `npx electron-builder --dir` to inspect output.
6. **Memory leaks**: common causes are: not removing IPC listeners, not closing child windows, not cleaning up `setInterval` timers. Use `win.on('closed', ...)` to clean up. Profile with `--inspect` heap snapshots.
7. **`require is not defined` in renderer**: this is correct behavior with context isolation. Use the preload + contextBridge pattern instead.
8. **`window.myAPI is undefined` in renderer**: context isolation is enabled (good), but you're trying to set window properties directly in preload. Use `contextBridge.exposeInMainWorld()`.
9. **Slow startup on Windows**: module loading is slower on Windows due to filesystem. Defer non-critical `require()` calls and bundle aggressively.

## Debugging

```bash
# Main process debugging
electron --inspect=9229 .
electron --inspect-brk=9229 .  # break on first line

# Enable Electron verbose logging
ELECTRON_ENABLE_LOGGING=1 electron .

# Enable security warnings in production (usually dev-only)
ELECTRON_ENABLE_SECURITY_WARNINGS=1 electron .
```

Crash reporting:
```typescript
import { crashReporter } from 'electron';
crashReporter.start({
  productName: 'YourApp',
  submitURL: 'https://your-crash-server.com/submit',
  uploadToServer: true,
});
```

## Testing

```typescript
// E2E with Playwright (recommended)
import { test, expect, _electron as electron } from '@playwright/test';

test('app launches and shows main window', async () => {
  const app = await electron.launch({ args: ['.'] });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  const title = await window.title();
  expect(title).toBe('YourApp');

  // Test IPC round-trip
  const result = await window.evaluate(() => window.electronAPI.getSystemInfo());
  expect(result.platform).toBeTruthy();

  await app.close();
});
```

Unit tests for main process logic: use Vitest or Jest with Electron APIs mocked. Keep main process logic in pure functions that are testable without Electron runtime.

## Electron Fuses

Fuses are compile-time feature flags baked into the Electron binary. They allow you to disable features you don't need for additional security:

```bash
npx @electron/fuses read --app /path/to/YourApp.app

# Example: disable Node.js CLI flags in production
npx @electron/fuses write --app /path/to/YourApp.app \
  EnableNodeCliInspectArguments=off \
  RunAsNode=off
```

Disabling `RunAsNode` prevents attackers from using your Electron binary as a general Node.js runtime. Consider this for production builds.

## ESM (ES Modules) support

ESM is supported since Electron 28. The behavior differs by process:

**Main process** — uses Node.js ESM loader. Enable via `.mjs` extension or `"type": "module"` in package.json:

```typescript
// main.mjs — ESM main process entry
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// CRITICAL: await dynamic imports before app is ready
// ESM loads asynchronously — without await, app.ready fires before imports resolve
await import('./setup-paths.mjs');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
    },
  });
  win.loadFile('index.html');
});
```

**Renderer process** — uses Chromium's ESM loader. No access to Node.js built-ins or `node_modules`. Use a bundler (Vite, webpack) for npm packages.

**Preload scripts** — ESM preload scripts MUST use `.mjs` extension (`"type": "module"` in package.json is ignored for preloads). Sandboxed preloads CANNOT use ESM imports — use a bundler or stick to CommonJS with `require('electron')`.

**Migration gotcha**: if you're migrating from transpiled CJS (Babel/TypeScript converting `import` to `require`), be aware that native ESM loads asynchronously. Code that relied on synchronous `require()` timing may break. Always `await` dynamic imports before `app.ready`.

## Electron version strategy

Electron ships a new major version every 8 weeks, aligned with Chromium releases. Each major version includes a new Chromium, a new Node.js, and potentially breaking API changes.

**Support policy**: the latest 3 major versions receive security patches. Older versions are EOL.

**Before upgrading**, always check the breaking changes doc: https://www.electronjs.org/docs/latest/breaking-changes

Key recent breaking changes to watch for:
- **v40**: `clipboard` API deprecated in renderer — move to preload + contextBridge
- **v41**: PDFs no longer create separate WebContents — use frame tree instead
- **v28**: sandbox enabled by default in renderers
- **v12**: contextIsolation enabled by default
- **v5**: nodeIntegration disabled by default

**Version pinning**: lock your Electron version in `package.json` with an exact version (`"electron": "33.2.1"`) not a range. Electron major bumps frequently include breaking changes.

## ASAR archives and integrity

Electron apps are packaged into ASAR (Atom Shell Archive) format by default. This bundles your source files into a single archive inside the app.

**ASAR integrity** (available in Electron Forge) adds hash validation to prevent tampering:

```typescript
// forge.config.ts — enable ASAR integrity
const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      integrity: true, // adds block-level hashes to validate archive contents
    },
  },
};
```

Combined with code signing and the `OnlyLoadAppFromAsar` fuse, this prevents an attacker from replacing your app code even if they have write access to the app directory:

```bash
npx @electron/fuses write --app /path/to/YourApp.app \
  OnlyLoadAppFromAsar=on
```

## Clipboard and sensitive data

As of Electron 40, direct `clipboard` access from the renderer is deprecated. Always route through preload:

```typescript
// preload/index.ts
contextBridge.exposeInMainWorld('electronAPI', {
  copyToClipboard: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
});

// main/ipc-handlers.ts
ipcMain.handle('clipboard:write', (_event, text: string) => {
  if (typeof text !== 'string' || text.length > 1_000_000) throw new Error('Invalid');
  clipboard.writeText(text);
});
ipcMain.handle('clipboard:read', () => clipboard.readText());
```

For sensitive data (passwords, tokens): use `safeStorage` API to encrypt before writing to disk:

```typescript
import { safeStorage } from 'electron';

// Encrypt
const encrypted = safeStorage.encryptString('my-secret-token');
// Store encrypted buffer to disk...

// Decrypt
const decrypted = safeStorage.decryptString(encrypted);
```

## Utility processes

For CPU-intensive work (file processing, compression, crypto), use Electron's `utilityProcess` instead of blocking the main process:

```typescript
import { utilityProcess } from 'electron';

const child = utilityProcess.fork(path.join(__dirname, 'heavy-task.js'));

child.postMessage({ type: 'process-file', path: '/data/large.csv' });
child.on('message', (result) => {
  console.log('Task complete:', result);
});
```

This runs in a separate Node.js process with full Node.js API access but isolated from the main process. Preferred over `child_process.fork()` because it integrates with Electron's process lifecycle and crash reporting.

## Quick reference — which API belongs where

| API | Available in | Notes |
|-----|-------------|-------|
| `app`, `BrowserWindow`, `ipcMain`, `Menu`, `Tray`, `dialog`, `nativeTheme`, `autoUpdater`, `safeStorage`, `utilityProcess` | Main process only | Core Electron APIs |
| `ipcRenderer`, `contextBridge` | Preload only | Bridge between main and renderer |
| `webFrame` | Renderer only | Control renderer zoom, spell check |
| DOM APIs, `fetch`, Web APIs | Renderer only | Standard web platform |
| `require('node:fs')`, `require('node:path')`, etc. | Main + preload (if not sandboxed) | Node.js built-ins |
| `process.platform`, `process.arch` | Main + preload | System info |
| `shell.openExternal` | Main only | Open URLs in default browser — validate input |
| `clipboard` | Main (preferred since v40) | Deprecated in renderer — use IPC |

---

## Skill sources and refresh guide

This skill was generated on **2026-03-21** from the following sources. When refreshing this skill, re-crawl each source and diff against the current content to find new patterns, breaking changes, deprecations, or security recommendations.

### Primary sources

| Source | URL | What to extract |
|--------|-----|-----------------|
| Electron official docs — Introduction | https://www.electronjs.org/docs/latest/ | New getting-started patterns, tooling changes |
| Electron official docs — Process Model | https://www.electronjs.org/docs/latest/tutorial/process-model | Process architecture changes, new process types |
| Electron official docs — Context Isolation | https://www.electronjs.org/docs/latest/tutorial/context-isolation | contextBridge API updates, migration patterns |
| Electron official docs — IPC | https://www.electronjs.org/docs/latest/tutorial/ipc | New IPC patterns, deprecated patterns |
| Electron official docs — Security Checklist | https://www.electronjs.org/docs/latest/tutorial/security | New security recommendations (items 1-20+) |
| Electron official docs — Performance | https://www.electronjs.org/docs/latest/tutorial/performance | New optimization techniques, profiling tools |
| Electron official docs — ESM | https://www.electronjs.org/docs/latest/tutorial/esm | ESM support changes, new caveats |
| Electron official docs — Fuses | https://www.electronjs.org/docs/latest/tutorial/fuses | New fuses, changed defaults |
| Electron official docs — Distribution (Forge) | https://www.electronjs.org/docs/latest/tutorial/forge-overview | Forge workflow updates, new makers/publishers |
| Electron official docs — Breaking Changes | https://www.electronjs.org/docs/latest/breaking-changes | **Critical** — new deprecations, removed APIs, default changes |
| Electron official docs — ASAR Integrity | https://www.electronjs.org/docs/latest/tutorial/asar-integrity | Integrity verification updates |
| Electron GitHub repo | https://github.com/electron/electron | New releases, CLAUDE.md conventions, repo structure changes |
| Electron Releases page | https://releases.electronjs.org | Latest stable version, Chromium/Node.js versions shipped |
| Electron Forge docs | https://www.electronforge.io/ | Forge config changes, new plugins |
| electron-builder docs | https://www.electron.build/ | Builder config changes, new targets |

### Secondary sources (check when relevant)

| Source | URL | What to extract |
|--------|-----|-----------------|
| Electron GitHub Issues (label:bug) | https://github.com/electron/electron/issues?q=label%3Abug | Common new bugs, workarounds |
| Electron blog | https://www.electronjs.org/blog | Major announcements, migration guides |
| Playwright Electron docs | https://playwright.dev/docs/api/class-electron | E2E testing API changes |
| electron-updater changelog | https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/CHANGELOG.md | Auto-update behavior changes |

### Refresh process

When updating this skill:

1. **Check the current Electron stable version** at https://releases.electronjs.org — update the "Electron version covered" range in the header.
2. **Read the Breaking Changes page first** — this is the highest-signal source. Any new deprecation or default change should be reflected in the skill immediately.
3. **Re-crawl all primary sources** — look for new sections, changed code examples, new APIs, or removed content.
4. **Check the GitHub repo** for structural changes (new docs pages, updated CLAUDE.md, new API modules).
5. **Update code examples** if any API signatures changed or if better patterns emerged.
6. **Add new pitfalls** if the GitHub issues show recurring new bugs.
7. **Bump the skill version** and **update the date** in the header.
8. **Set the next review date** to 3 months out or to the next expected Electron major release, whichever comes first.

### Version history

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-21 | Initial rewrite from VoltAgent original. Added procedural code patterns, security defaults, IPC patterns, packaging configs, pitfalls, debugging, testing. |
| 2.0 | 2026-03-21 | Added from official docs: IPC sender validation, permission handlers, shell.openExternal safety, navigation restrictions, 4 IPC patterns, Electron Forge config, TypeScript bridge typing, deferred module loading, anti-patterns. Added from GitHub repo: ESM support and caveats, version strategy and breaking changes awareness, ASAR integrity, clipboard migration (v40 deprecation), utilityProcess for CPU work, API location reference table, Electron Fuses. |
