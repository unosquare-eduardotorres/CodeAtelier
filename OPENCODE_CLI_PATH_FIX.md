# OpenCode CLI Path Issue - Comprehensive Solution

**Problem**: "OpenCode server failed to start: spawn opencode ENOENT"

**Your CLI is installed**: `/opt/homebrew/bin/opencode` (version 1.17.9)

## Root Cause

Electron packaged apps run with a truncated `PATH` environment variable.
When `@opencode-ai/sdk` tries to `spawn('opencode', ...)`, Node.js can't find it.

## Solution: Augment PATH Early in electron main/index.ts

Add this code to `src/main/index.ts` **before** `app.whenReady()`:

```typescript
// src/main/index.ts - add near the top with other imports
import { join } from 'node:path'

// AUGMENT PATH to include Homebrew and npm global bin directories
// This is essential for child_process.spawn() to find opencode CLI
const HOME = process.env.HOME || ''
const HOME Burnett Paths = {
  darwin: [
    '/opt/homebrew/bin',        // Apple Silicon Homebrew
    '/usr/local/bin',           // Intel Mac Homebrew
    join(HOME, '.npm-global', 'bin'),  // npm global
  ],
  win32: [
    join(HOME, 'AppData', 'Roaming', 'npm'),  // Windows npm global
  ],
  linux: [
    '/snap/bin',
    '/usr/local/bin',
    join(HOME, '.local', 'bin'),
    join(HOME, '.npm-global', 'bin'),
  ],
}

const PLATFORM_PATHS = HOME Burnett Paths[process.platform as keyof typeof HOME Burnett Paths] || []

for (const binPath of PLATFORM_PATHS) {
  if (!process.env.PATH?.includes(binPath)) {
    process.env.PATH = `${binPath}${process.env.PATH ? ':' + process.env.PATH : ''}`
  }
}

// Optional: Log for debugging (remove in production)
log.info(`[Path Augmentation] Enhanced PATH with: ${PLATFORM_PATHS.filter(p => !process.env.PATH?.includes(p)).length} paths`)
```

## Complete Fixes Implemented

### 1. checkCliAvailable() - Validates CLI installation

- Checks if `opencode` binary is available before attempting to spawn
- Provides helpful installation instructions

### 2. Enhanced Error Messages - Better UX

- Detects `ENOENT` errors specifically
- Shows clear installation commands

### 3. PATH Augmentation (CRITICAL) - Ensures Electron can find CLI

- Adds Homebrew paths to process.env.PATH
- Must be done **before** any child process spawns

## Files We Modified

1. **`src/main/services/opencode-executor.ts`** - Added `checkCliAvailable()`
2. **`src/main/services/agent-session.service.ts`** - Enhanced error messaging
3. **`src/main/services/__tests__/opencode-executor-integration.test.ts`** - Added CLI tests
4. **`src/main/services/__tests__/opencode-cli-check.test.ts`** - New unit test file
5. **`src/shared/opencode-check.ts`** - CLI check utility module

## Verification Command

After adding PATH augmentation to main/index.ts:

```bash
# In app devtools console, test:
const { spawnSync } = require('child_process')
const r = spawnSync('opencode', ['--version'])
console.log('Version:', r.stdout.toString())
console.log('Error:', r.error?.message)
console.log('PATH contains /opt/homebrew/bin:', process.env.PATH.includes('/opt/homebrew/bin'))
```

## Expected Result

After fix: No more "spawn opencode ENOENT" error. Server starts normally.
