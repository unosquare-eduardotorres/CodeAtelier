# Advanced Electron Patterns

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

**ESM preload critical caveats:**
- Sandboxed preloads CANNOT use ESM imports at all — must use CJS or a bundler
- ESM preload scripts MUST have `.mjs` extension (package.json `"type": "module"` is ignored)
- Dynamic `import()` in preload requires `contextIsolation: true`
- ESM loads asynchronously — use `await` before `app.ready` to prevent race conditions

**Migration gotcha**: if you're migrating from transpiled CJS (Babel/TypeScript converting `import` to `require`), be aware that native ESM loads asynchronously. Code that relied on synchronous `require()` timing may break. Always `await` dynamic imports before `app.ready`.

## Electron version strategy

Electron ships a new major version every 8 weeks, aligned with Chromium releases. Each major version includes a new Chromium, a new Node.js, and potentially breaking API changes.

**Support policy**: the latest 3 major versions receive security patches. Older versions are EOL.

**Before upgrading**, always check the breaking changes doc: https://www.electronjs.org/docs/latest/breaking-changes

Key recent breaking changes to watch for:
- **v40**: `clipboard` API deprecated in renderer — move to preload + contextBridge
- **v41**: PDFs no longer create separate WebContents — use frame tree instead
- **v39**: ASAR Integrity graduates to stable for runtime tamper detection
- **v41**: ASAR Integrity digest for macOS, MSIX auto-updating, improved Wayland support
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

### utilityProcess options
```typescript
const child = utilityProcess.fork(modulePath, args, {
  serviceName: 'my-heavy-task',  // Shows in app.getAppMetrics()
  stdio: 'pipe',                 // Enable stdout/stderr capture
  env: { ...process.env },       // Custom environment
  cwd: workspacePath,            // Working directory
});
```

**Why utilityProcess over child_process.fork():**
- Tracked by `app.getAppMetrics()` — visible in process monitoring
- Integrates with Electron's crash reporting
- Supports MessagePort for structured communication
- Managed by Electron's process lifecycle

**Communication pattern:**
```typescript
// Main process
child.postMessage({ type: 'task', data: payload });
child.on('message', (result) => { /* handle */ });

// Utility process (in modulePath)
process.parentPort.on('message', (e) => {
  const { type, data } = e.data;
  // ... process
  process.parentPort.postMessage({ type: 'result', data: output });
});
```

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
