# Electron Security Hardening Checklist

## BrowserWindow Configuration

```typescript
const mainWindow = new BrowserWindow({
  webPreferences: {
    contextIsolation: true,      // MANDATORY — isolates preload from renderer
    nodeIntegration: false,      // MANDATORY — no Node.js in renderer
    sandbox: true,               // RECOMMENDED — OS-level sandboxing
    webSecurity: true,           // MANDATORY — enforce same-origin policy
    allowRunningInsecureContent: false, // MANDATORY
    enableBlinkFeatures: '',     // Don't enable experimental features
    webviewTag: false,           // Disable <webview> unless explicitly needed
    preload: path.join(__dirname, 'preload.js') // Typed bridge only
  }
})
```

## Content Security Policy

### Production CSP
```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
font-src 'self';
connect-src 'self';
media-src 'none';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
```

### Setting CSP in Electron
```typescript
session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
  callback({
    responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': [CSP_POLICY]
    }
  })
})
```

## Preload Security Pattern

```typescript
// GOOD — typed, minimal API surface
contextBridge.exposeInMainWorld('api', {
  invoke: (channel: string, ...args: unknown[]) => {
    const validChannels = ['chat:send', 'workspace:list', ...]
    if (!validChannels.includes(channel)) throw new Error('Invalid channel')
    return ipcRenderer.invoke(channel, ...args)
  }
})

// BAD — exposes raw IPC (never do this)
contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: ipcRenderer // DANGEROUS — full access to all channels
})
```

## IPC Handler Validation

```typescript
// Every handler MUST validate sender
ipcMain.handle('chat:send', async (event, payload) => {
  validateSender(event) // Throws if not from expected renderer

  // Validate input types
  if (typeof payload?.message !== 'string') throw new Error('Invalid message')
  if (payload.message.length > 100_000) throw new Error('Message too long')

  // Process...
})
```

## File System Security

```typescript
// GOOD — resolve and validate
const safePath = path.resolve(workspacePath, userInput)
if (!safePath.startsWith(workspacePath)) {
  throw new Error('Path traversal detected')
}

// BAD — direct concatenation
const unsafePath = workspacePath + '/' + userInput // PATH TRAVERSAL RISK
```

## External URL Validation

```typescript
// GOOD — allowlist domains
const ALLOWED_DOMAINS = ['github.com', 'docs.anthropic.com']
function openExternal(url: string): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') throw new Error('HTTPS only')
  if (!ALLOWED_DOMAINS.some(d => parsed.hostname.endsWith(d))) {
    throw new Error('Domain not allowed')
  }
  shell.openExternal(url)
}

// BAD — open anything
shell.openExternal(userProvidedUrl) // DANGEROUS
```

## Electron Fuses

Set at build time to prevent runtime security toggles:
```
@electron/fuses set:
  RunAsNode=off              # Prevent ELECTRON_RUN_AS_NODE
  EnableCookieEncryption=on  # Encrypt cookies at rest
  EnableNodeOptionsEnv=off   # Prevent NODE_OPTIONS injection
  EnableNodeCliInspect=off   # Prevent --inspect debugging
  EnableEmbeddedAsarIntegrityValidation=on  # Verify ASAR integrity
  OnlyLoadAppFromAsar=on     # Prevent loading from filesystem
```

## Auto-Update Security

- Use HTTPS for update server
- Verify code signatures before installing updates
- Use `electron-updater` with signature verification enabled
- Pin update server certificate if possible
- Log all update events for audit trail
