---
name: electron-pro
description: Use this skill for ANY Electron desktop application work — creating new apps, debugging IPC issues, configuring builds, setting up auto-updates, code signing, native OS integration, or optimizing performance. Trigger whenever the user mentions Electron, BrowserWindow, main process, renderer process, preload scripts, electron-builder, electron-forge, contextBridge, ipcMain/ipcRenderer, desktop app packaging, or cross-platform desktop development. Also trigger for Tauri-to-Electron migration questions, choosing between desktop frameworks, Electron security hardening, IPC patterns, or context isolation questions.
---

# Electron Pro

> **Skill version**: 2.1
> **Last updated**: 2026-03-22
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

### Sandboxed Preload API Availability

When `sandbox: true` (default since Electron 20), preload scripts get a polyfilled subset:

| Available Electron modules | Available Node.js built-ins | Available globals |
|---|---|---|
| `contextBridge` | `events` | `Buffer` |
| `crashReporter` | `timers` | `process` (polyfilled) |
| `ipcRenderer` | `url` | `clearImmediate` |
| `nativeImage` | | `setImmediate` |
| `webFrame` | | |
| `webUtils` | | |

**Cannot use in sandboxed preload:** `fs`, `path`, `child_process`, `crypto`, or any other Node.js module. These must go through IPC to the main process.

**Cannot split preload into multiple files** with `require()` — use a bundler (electron-vite handles this automatically for Agent Studio).

### Additional security hardening

- **Do not enable `allowRunningInsecureContent`** — prevents HTTP resources on HTTPS pages (item #8)
- **Do not enable `experimentalFeatures`** — untested Chromium features (item #9)
- **Do not use `enableBlinkFeatures`** — if a feature isn't default, there's a reason (item #10)
- **Disable `allowpopups` for WebViews** — prevents `window.open()` from webviews (item #11)
- **Validate WebView options before creation** — use `will-attach-webview` event to sanitize WebView configs, delete untrusted preloads, enforce `nodeIntegration: false` (item #12)
- **Consider custom protocols instead of file://** — `file://` has more privileges in Electron than in browsers; use `protocol.handle()` for better control (item #18)

```typescript
// Item #12: Validate webview creation
app.on('web-contents-created', (event, contents) => {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    if (!params.src.startsWith('https://example.com/')) {
      event.preventDefault();
    }
  });
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

## Auto-updates, packaging, and native OS integration

For complete code examples on these topics, see [references/packaging-and-native.md](references/packaging-and-native.md):

- **Auto-updates**: `electron-updater` setup, update server options (GitHub Releases, S3, Hazel)
- **Packaging**: Electron Forge config, electron-builder YAML, code signing checklist (macOS, Windows, Linux)
- **Native OS**: System tray, native menus, deep links/protocol handlers, window state persistence, theme detection

### Performance targets

| Metric | Target | How to measure |
|--------|--------|----------------|
| Cold startup | < 3s | `process.hrtime()` from app ready to first paint |
| Idle memory | < 200MB | Task Manager / Activity Monitor |
| Animation | 60 FPS | DevTools Performance tab |
| Installer size | < 100MB | Check `dist/` output |

**#1 performance rule**: defer heavy module imports. Use `await import('module')` instead of top-level imports for modules not needed at startup.

## Child Process Management for CLI Integration

### Spawning long-lived interactive processes

Use `spawn()` with bidirectional stdio for interactive CLI sessions:

```typescript
import { spawn } from 'child_process';

const proc = spawn('claude', [
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--verbose',
  '--permission-mode', 'plan',
], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});
```

**NDJSON parsing** — buffer stdout and split on newlines, handling partial lines:

```typescript
let buffer = '';
proc.stdout.on('data', (chunk: Buffer) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? ''; // Keep incomplete last line in buffer

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      handleStreamEvent(event);
    } catch { /* skip malformed lines */ }
  }
});

// Flush buffer on exit
proc.on('exit', () => {
  if (buffer.trim()) {
    try { handleStreamEvent(JSON.parse(buffer)); } catch {}
  }
});
```

### Spawning one-shot processes

For non-interactive command execution:

```typescript
const proc = spawn('claude', ['-p', taskDescription, '--output-format', 'stream-json'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

### Graceful shutdown

Always use a two-phase shutdown to avoid orphaned processes:

```typescript
async function stopProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    proc.on('exit', () => {
      // Clear process reference and reset status
      resolve();
    });

    proc.kill('SIGTERM'); // Ask nicely first

    setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL'); // Force after timeout
      }
    }, 5000);
  });
}
```

### Environment hygiene

```typescript
const env = { ...process.env };
delete env.CLAUDECODE; // Avoid nested session errors

// Augment PATH for CLI binary discovery across platforms
const extraPaths = ['/usr/local/bin', '/opt/homebrew/bin', `${os.homedir()}/.local/bin`];
env.PATH = [...extraPaths, env.PATH].join(path.delimiter);
```

## App Lifecycle Quick Reference

### Essential methods
| Method | Purpose |
|--------|---------|
| `app.whenReady()` | Returns Promise — preferred over `app.on('ready')` |
| `app.quit()` | Graceful quit — fires before-quit, will-quit events |
| `app.exit([code])` | Immediate exit — no events, no cleanup |
| `app.requestSingleInstanceLock()` | Enforce single instance — returns false if another exists |
| `app.getPath(name)` | Get special dirs: userData, appData, temp, logs, downloads |
| `app.getAppMetrics()` | Memory/CPU stats for ALL processes — useful for monitoring |
| `app.isPackaged` | Boolean — true in production, false in dev |

### Key lifecycle events (in order)
1. `will-finish-launching` — basic startup (register protocol handlers here)
2. `ready` — Electron initialized, create windows
3. `activate` (macOS) — dock click when no windows open
4. `before-quit` — before windows close (preventDefault to cancel)
5. `will-quit` — all windows closed, about to exit
6. `quit` — final event, app is exiting

### Second instance handling
```typescript
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv, workingDir) => {
    // Focus existing window, handle deep link from argv
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
}
```

### Performance optimization checklist

1. **Module auditing**: Profile module load times with `node --cpu-prof --heap-prof -e "require('module')"`
2. **Menu optimization**: Call `Menu.setApplicationMenu(null)` before `app.on('ready')` to skip default menu construction
3. **Renderer idle work**: Use `requestIdleCallback()` for non-urgent background work
4. **Web Workers**: Deploy for CPU-intensive renderer work (don't block the UI thread)
5. **Remove polyfills**: Know your Chromium version — remove polyfills for natively supported features
6. **Network**: Bundle static assets in the app — don't fetch fonts/images from CDNs at startup

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

## Advanced patterns

For debugging, testing, ESM, fuses, ASAR integrity, clipboard handling, utility processes, version strategy, and the API location reference table, see [references/advanced-patterns.md](references/advanced-patterns.md).

Key points:
- **Debug**: `electron --inspect=9229 .` for main process, `ELECTRON_ENABLE_LOGGING=1` for verbose
- **Test**: Playwright E2E recommended (`@playwright/test` with `_electron`)
- **Fuses**: disable `RunAsNode` and `EnableNodeCliInspectArguments` in production
- **ESM**: supported since v28, preload MUST use `.mjs` extension, `await` dynamic imports before `app.ready`
- **Version pinning**: exact version in `package.json`, never ranges
- **Clipboard**: deprecated in renderer since v40, route through preload IPC
- **Utility processes**: use `utilityProcess.fork()` for CPU-intensive work

---

For skill sources, refresh process, and version history, see [references/sources.md](references/sources.md).
