---
name: ipc-patterns
description: >
  Agent Studio IPC patterns: typed channels, preload bridge, streaming events,
  error handling, validateSender. Trigger: IPC handler, preload bridge, window.api,
  ipcMain.handle, ipcRenderer.invoke, streaming chunks, renderer-main communication.
user-invocable: false
---

# IPC Patterns for Agent Studio

> **Version**: 1.1
> **Last updated**: 2026-03-22
> **Target**: Electron 39 + better-sqlite3 + React 19

## Channel Definition

All channels defined in `src/shared/constants.ts` (IPC_CHANNELS object) using `'domain:action'` naming:

```typescript
export const IPC_CHANNELS = {
  WORKSPACE_LIST: 'workspace:list',
  CHAT_SEND_MESSAGE: 'chat:sendMessage',
  AGENT_STATUS: 'agent:status'
  // ...
} as const
```

Type contracts in `src/shared/types.ts`:

- `IpcChannels` — maps channel names to `{ params: [...]; return: Type }` for request/response
- `IpcEvents` — maps channel names to `{ payload: Type }` for push events (main → renderer)

## Request/Response Pattern (Renderer → Main)

The full chain:

```
Renderer component
  → window.api.methodName(args)          # typed wrapper
    → preload: ipcRenderer.invoke(channel, args)   # bridge
      → main: ipcMain.handle(channel, handler)     # business logic
        → returns Promise<result> or throws Error
```

### Main process handler template

```typescript
// src/main/ipc/domain.ipc.ts
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate'

export function registerDomainHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.DOMAIN_ACTION, async (event: IpcMainInvokeEvent, arg1: string) => {
    validateSender(event)

    // Manual input validation — no validation library
    if (!arg1 || typeof arg1 !== 'string') {
      throw new Error('arg1 is required and must be a string')
    }

    // Business logic...
    return result
  })
}
```

### Preload bridge template

```typescript
// src/preload/index.ts
const api = {
  // Request/response — uses invoke (async, two-way)
  domainAction: (arg1: string) => ipcRenderer.invoke(IPC_CHANNELS.DOMAIN_ACTION, arg1),

  // Event listener — returns cleanup function
  onDomainEvent: (callback: (data: EventPayload) => void) => {
    const handler = (_event: IpcRendererEvent, data: EventPayload) => callback(data)
    ipcRenderer.on(IPC_CHANNELS.DOMAIN_EVENT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DOMAIN_EVENT, handler)
  }
}
```

### Renderer usage template

```typescript
// In React component
useEffect(() => {
  const cleanup = window.api.onDomainEvent((data) => {
    // Handle event...
  })
  return cleanup // ALWAYS return cleanup in useEffect
}, [])

// For request/response
const handleAction = async () => {
  try {
    const result = await window.api.domainAction(arg1)
    // Handle result...
  } catch (error) {
    // Handle error — thrown from ipcMain.handle propagates here
  }
}
```

## Streaming Pattern (Main → Renderer)

Used for chat messages, agent status updates, and other real-time data.

### Flow

```
Main process (service)
  → mainWindow.webContents.send(channel, data)    # push event
    → preload: ipcRenderer.on(channel, handler)   # listener
      → renderer: window.api.onEventName(callback) # cleanup-return pattern
```

### Chunk payload conventions

```typescript
// Chat message streaming
interface MessageChunk {
  conversationId: string
  chunk: string
  role: 'assistant' | 'user'
  toolActivity?: string // Tool use activity description
  compactNeeded?: boolean // Signal UI to suggest compaction
}

// Chat message complete
interface MessageComplete {
  conversationId: string
  messageId: string
}
```

### Critical rules

1. **Always send `CHAT_MESSAGE_COMPLETE`** even on error — the UI needs it to exit loading state
2. **Error chunks** are sent via `CHAT_MESSAGE_CHUNK` with error text, then `CHAT_MESSAGE_COMPLETE`
3. **Cleanup is mandatory** — every `window.api.on*` call returns a cleanup function; always use it in `useEffect` return

## Serialization Constraints

IPC uses the HTML Structured Clone Algorithm. Plan data structures accordingly.

**Cannot be sent over IPC:**

- Functions, Promises, Symbols
- WeakMaps, WeakSets
- DOM objects (Element, Location, DOMMatrix, ImageBitmap, File)
- Node.js C++ backed objects (process.env members, Stream instances)
- Electron C++ backed objects (WebContents, BrowserWindow, WebFrame)

**Error serialization limitation:** Errors thrown in `ipcMain.handle()` are serialized — only `error.message` transfers to renderer. Full stack traces and custom properties are lost. If you need structured error info, catch and re-throw with a message string:

```typescript
// ❌ Custom error properties lost in serialization
throw Object.assign(new Error('fail'), { code: 'INVALID_INPUT', details: {...} });

// ✅ Encode error info in the message string
throw new Error(JSON.stringify({ code: 'INVALID_INPUT', message: 'fail', details: {...} }));

// ✅ Or return error objects instead of throwing
return { success: false, error: { code: 'INVALID_INPUT', message: 'fail' } };
```

## Error Handling

### IPC handler errors

```typescript
// Throw Error → propagates as rejected invoke promise to renderer
ipcMain.handle(channel, async (event, ...args) => {
  validateSender(event)
  if (!valid) throw new Error('Validation failed') // Renderer catches this
  // ...
})
```

### Streaming errors

```typescript
// In service: send error chunk, then always complete
try {
  // ... process
} catch (error) {
  mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
    conversationId,
    chunk: `Error: ${error.message}`,
    role: 'assistant'
  })
} finally {
  // ALWAYS send complete — UI depends on this to exit loading state
  mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
    conversationId,
    messageId
  })
}
```

### Service-level errors

- Wrap DB operations in try/catch
- Use `log.error()` for logging (electron-log)
- Emit error events to renderer
- Update agent/task status to 'failed' or 'error'

## Security

### validateSender

Every IPC handler must call `validateSender(event)` as its first line:

```typescript
function validateSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame.url
  // Allow file:// (production) and http://localhost (dev)
  if (!url.startsWith('file://') && !url.startsWith('http://localhost')) {
    throw new Error('Unauthorized IPC sender')
  }
}
```

### Never expose raw ipcRenderer

```typescript
// ❌ NEVER — allows renderer to call ANY channel
contextBridge.exposeInMainWorld('ipc', ipcRenderer)

// ✅ ALWAYS — explicit, typed wrapper methods
contextBridge.exposeInMainWorld('api', {
  specificMethod: (arg) => ipcRenderer.invoke('specific:channel', arg)
})
```

### Never leak event.sender via callback exposure

```typescript
// ❌ DANGEROUS — leaks ipcRenderer event object to renderer
contextBridge.exposeInMainWorld('api', {
  onUpdate: (callback) => ipcRenderer.on('update', callback)
  // callback receives (event, ...args) — event.sender gives access to webContents
})

// ✅ SAFE — strip the event, pass only data
contextBridge.exposeInMainWorld('api', {
  onUpdate: (callback) => {
    const handler = (_event, ...args) => callback(...args)
    ipcRenderer.on('update', handler)
    return () => ipcRenderer.removeListener('update', handler)
  }
})
```

### All preload methods use invoke (async, two-way)

- Never use `send` / `sendSync` for request-response
- `send` is only used internally for fire-and-forget (rare)

## Common Patterns

### Adding a new IPC channel

1. Add channel constant to `src/shared/constants.ts` (`IPC_CHANNELS`)
2. Add type contract to `src/shared/types.ts` (`IpcChannels` or `IpcEvents`)
3. Add handler in `src/main/ipc/domain.ipc.ts` with `validateSender` + input validation
4. Register handler in `src/main/ipc/index.ts` barrel
5. Add preload method in `src/preload/index.ts`
6. Add type to `src/preload/index.d.ts`
7. Use in renderer via `window.api.methodName()`

## MessagePort Communication (Advanced)

For direct renderer↔renderer or renderer↔worker communication without routing through main:

### Setup (main process)

```typescript
import { MessageChannelMain } from 'electron'

const { port1, port2 } = new MessageChannelMain()
// Transfer ports via postMessage — NOT via send/invoke
win1.webContents.postMessage('port', null, [port1])
win2.webContents.postMessage('port', null, [port2])
```

### Key rules

- Ports transfer ONLY via `postMessage()` — `send()` and `invoke()` cannot transfer MessagePorts
- In main process, call `port.start()` before messages flow (MessagePortMain queues until started)
- Electron adds a `close` event (not in web standard) — fired when other end disconnects or is garbage-collected
- Use `ipcRenderer.postMessage(channel, message, [transfer])` to send ports from renderer to main

### Frame-targeted messaging

For multi-frame architectures (iframes, webviews), target specific frames:

```typescript
// Main process — send to a specific frame, not the whole renderer
contents.sendToFrame(frameId, 'channel-name', data)
```

### Deprecated patterns to avoid

- `AGENT_IDS` and `AGENT_META` in constants.ts are `@deprecated` — use DB specialists instead
- Do not add new references to these deprecated constants
