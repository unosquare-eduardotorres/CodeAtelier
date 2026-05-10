# Electron Testing Reference

Electron apps have three process contexts, each needing a different test strategy:
**Main process** (Node.js), **Renderer process** (browser), and **Preload scripts** (bridge).

## Architecture-Aware Testing

```
┌─────────────────────────────────────────────────┐
│ Main Process (Node.js)                          │
│  ├── App lifecycle, menus, tray, native APIs    │
│  ├── IPC handlers (ipcMain.handle)              │
│  └── File system, OS integration                │
│       → Test with: Vitest/Jest (unit)           │
│       → Test with: Playwright Electron (E2E)    │
├─────────────────────────────────────────────────┤
│ Preload Scripts                                 │
│  ├── contextBridge.exposeInMainWorld             │
│  └── IPC bridging (ipcRenderer.invoke)          │
│       → Test with: Vitest (unit, mock electron) │
├─────────────────────────────────────────────────┤
│ Renderer Process (Chromium)                     │
│  ├── UI components (React, Angular, Vue, etc.)  │
│  └── Window-level logic                         │
│       → Test with: Vitest + Testing Library     │
│       → Test with: Playwright Electron (E2E)    │
└─────────────────────────────────────────────────┘
```

## Main Process Unit Tests

Mock Electron APIs since they're not available in a test runner:

```typescript
// src/main/file-handler.ts
import { dialog } from 'electron'

export async function openFile() {
  const result = await dialog.showOpenDialog({ properties: ['openFile'] })
  if (result.canceled) return null
  return readFileSync(result.filePaths[0], 'utf-8')
}
```

```typescript
// src/main/__tests__/file-handler.test.ts
import { vi, describe, it, expect } from 'vitest'

// Mock electron before importing the module
vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn()
  }
}))

import { dialog } from 'electron'
import { openFile } from '../file-handler'

describe('[unit] openFile', () => {
  it('returns file contents when user selects a file', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: ['/tmp/test.txt']
    })
    // Also mock fs.readFileSync as needed

    const result = await openFile()
    expect(result).toBeDefined()
  })

  it('returns null when dialog is canceled', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: true,
      filePaths: []
    })

    expect(await openFile()).toBeNull()
  })
})
```

## IPC Handler Tests

```typescript
// src/main/ipc-handlers.ts
export function registerHandlers(ipcMain: Electron.IpcMain) {
  ipcMain.handle('get-app-version', () => app.getVersion())
  ipcMain.handle('save-data', async (_event, data: string) => {
    await writeFile('/data/store.json', data)
    return { success: true }
  })
}
```

```typescript
// Test IPC handlers as plain functions
describe('[unit] IPC handlers', () => {
  it('save-data writes to file', async () => {
    const writeMock = vi.fn().mockResolvedValue(undefined)
    vi.mock('fs/promises', () => ({ writeFile: writeMock }))

    // Call the handler directly instead of through IPC
    const result = await saveDataHandler({} as any, '{"key":"value"}')

    expect(result).toEqual({ success: true })
    expect(writeMock).toHaveBeenCalledWith('/data/store.json', '{"key":"value"}')
  })
})
```

## Preload Script Tests

```typescript
// src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => ipcRenderer.invoke('get-app-version'),
  saveData: (data: string) => ipcRenderer.invoke('save-data', data)
})
```

```typescript
// Mock both contextBridge and ipcRenderer
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn()
  },
  ipcRenderer: {
    invoke: vi.fn()
  }
}))

describe('[unit] preload', () => {
  it('exposes electronAPI to renderer', async () => {
    await import('../preload')

    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      'electronAPI',
      expect.objectContaining({
        getVersion: expect.any(Function),
        saveData: expect.any(Function)
      })
    )
  })
})
```

## Renderer Process Tests

Test renderer UI components the same way you'd test a web app. Use the appropriate
framework reference (`references/react.md`, `references/angular.md`, etc.).

The key difference: mock `window.electronAPI` (the preload bridge):

```typescript
// Mock the preload API
beforeEach(() => {
  window.electronAPI = {
    getVersion: vi.fn().mockResolvedValue('1.0.0'),
    saveData: vi.fn().mockResolvedValue({ success: true })
  }
})
```

## E2E Tests with Playwright (Electron)

```bash
npm install -D @playwright/test electron
```

```typescript
// e2e/app.spec.ts
import { test, expect, _electron as electron } from '@playwright/test'

let electronApp: Awaited<ReturnType<typeof electron.launch>>

test.beforeAll(async () => {
  electronApp = await electron.launch({
    args: ['.'], // path to your main entry
    env: { NODE_ENV: 'test' }
  })
})

test.afterAll(async () => {
  await electronApp.close()
})

test('app window opens with correct title', async () => {
  const window = await electronApp.firstWindow()
  const title = await window.title()
  expect(title).toBe('My App')
})

test('user can save and load data', async () => {
  const window = await electronApp.firstWindow()

  await window.getByLabel('Note').fill('Hello World')
  await window.getByRole('button', { name: 'Save' }).click()

  // Verify save feedback
  await expect(window.getByText('Saved!')).toBeVisible()

  // Reload and verify persistence
  await window.reload()
  await expect(window.getByLabel('Note')).toHaveValue('Hello World')
})

test('can evaluate in main process', async () => {
  const version = await electronApp.evaluate(async ({ app }) => {
    return app.getVersion()
  })
  expect(version).toMatch(/^\d+\.\d+\.\d+$/)
})
```

## Running

```bash
# Unit tests (main + preload + renderer)
npx vitest run

# E2E with Playwright
npx playwright test --config=e2e/playwright.config.ts

# Build first, then E2E (CI pattern)
npm run build && npx playwright test
```

## Key Principles for Electron Tests

1. **Mock `electron` module in unit tests** — it's not available outside Electron runtime.
2. **Test IPC handlers as plain functions** — extract logic from ipcMain.handle into testable functions.
3. **Separate main, preload, and renderer tests** — each has different available APIs.
4. **Use Playwright `_electron`** for E2E — it launches the real app and controls it.
5. **Test the preload bridge contract** — verify `contextBridge.exposeInMainWorld` calls match what renderer expects.
