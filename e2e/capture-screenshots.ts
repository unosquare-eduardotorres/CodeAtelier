/**
 * UX Audit Screenshot Capture — Raw CDP approach
 *
 * Launches Electron, connects via Chrome DevTools Protocol WebSocket,
 * and captures screenshots using Page.captureScreenshot.
 *
 * This bypasses Playwright's connectOverCDP which is incompatible with Electron 40.
 *
 * Usage:
 *   npx tsx e2e/capture-screenshots.ts
 */
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { resolve, join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import { WebSocket } from 'ws'

const SCREENSHOT_DIR = resolve(__dirname, 'screenshots')
const ELECTRON_BIN = resolve(
  __dirname,
  '../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
)
const MAIN_ENTRY = resolve(__dirname, '../out/main/index.js')
const BOOTSTRAP = resolve(__dirname, 'helpers/electron-bootstrap.js')
const CDP_PORT = 19222

// ── CDP Client ────────────────────────────────────────────────────
let ws: WebSocket
let msgId = 0
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

function cdpSend(method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }
    }, 15000)
  })
}

function connectCDP(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url)
    ws.on('open', () => resolve())
    ws.on('error', (e) => reject(e))
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)!
        pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message))
        else p.resolve(msg.result)
      }
    })
  })
}

// ── Screenshot helper ─────────────────────────────────────────────
async function snap(name: string): Promise<void> {
  const result = await cdpSend('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const buffer = Buffer.from(result.data, 'base64')
  writeFileSync(join(SCREENSHOT_DIR, `${name}.png`), buffer)
  console.log(`  📸 ${name}.png (${(buffer.length / 1024).toFixed(0)}KB)`)
}

// ── Navigation helpers ────────────────────────────────────────────
async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Click element by aria-label, returns true if clicked */
async function clickLabel(label: string): Promise<boolean> {
  try {
    const { result } = await cdpSend('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('[aria-label="${label}"]');
        if (el) { el.click(); return true; }
        return false;
      })()`,
      returnByValue: true
    })
    await sleep(600)
    return result.value === true
  } catch {
    return false
  }
}

/** Click element matching a text pattern */
async function clickText(text: string): Promise<boolean> {
  try {
    const { result } = await cdpSend('Runtime.evaluate', {
      expression: `(() => {
        const els = document.querySelectorAll('button, [role="button"], a, [class*="cursor-pointer"]');
        for (const el of els) {
          if (el.textContent && el.textContent.trim().match(/${text}/i) && el.offsetParent !== null) {
            el.click();
            return true;
          }
        }
        return false;
      })()`,
      returnByValue: true
    })
    await sleep(600)
    return result.value === true
  } catch {
    return false
  }
}

/** Check if an element with given selector is visible */
async function isVisible(selector: string): Promise<boolean> {
  try {
    const { result } = await cdpSend('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('${selector}');
        return el !== null && el.offsetParent !== null;
      })()`,
      returnByValue: true
    })
    return result.value === true
  } catch {
    return false
  }
}

/** Type text into focused input */
async function typeText(text: string): Promise<void> {
  await cdpSend('Runtime.evaluate', {
    expression: `(() => {
      const input = document.querySelector('input');
      if (input) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeInputValueSetter) nativeInputValueSetter.call(input, '${text}');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`,
    returnByValue: true
  })
}

/** Press a keyboard key */
async function pressKey(key: string, modifiers = 0): Promise<void> {
  await cdpSend('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    modifiers,
    windowsVirtualKeyCode: key === 'Escape' ? 27 : key.charCodeAt(0)
  })
  await cdpSend('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    modifiers,
    windowsVirtualKeyCode: key === 'Escape' ? 27 : key.charCodeAt(0)
  })
}

// ── Wait for CDP ──────────────────────────────────────────────────
async function waitForCDP(port: number, timeoutMs = 25000): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = (await resp.json()) as Array<{
        type: string
        webSocketDebuggerUrl: string
      }>
      const page = targets.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      // Not ready
    }
    await sleep(500)
  }
  throw new Error(`CDP not available after ${timeoutMs}ms`)
}

// ── Main ──────────────────────────────────────────────────────────
async function main(): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  console.log('🚀 Launching Electron app...')

  // Launch Electron
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== 'ELECTRON_RUN_AS_NODE' && v !== undefined) env[k] = v
  }
  env.E2E_CDP_PORT = String(CDP_PORT)

  let electronProcess: ChildProcess | null = null

  try {
    electronProcess = spawn(ELECTRON_BIN, ['-r', BOOTSTRAP, MAIN_ENTRY], {
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    electronProcess.stderr?.on('data', (d) => {
      const msg = d.toString().trim()
      if (msg && !msg.includes('DevTools listening')) {
        console.log(`  [electron] ${msg.substring(0, 200)}`)
      }
    })

    // Wait for CDP page target
    const pageWsUrl = await waitForCDP(CDP_PORT)
    console.log('✅ Electron launched, CDP page available')

    // Connect to page via CDP WebSocket
    await connectCDP(pageWsUrl)
    console.log('✅ Connected to page via CDP')

    // Enable required CDP domains
    await cdpSend('Page.enable')
    await cdpSend('Runtime.enable')
    await cdpSend('DOM.enable')

    // Wait for initial render
    await sleep(3000)

    // ── 1. Initial screen ──────────────────────────────────────
    await snap('01-initial-screen')

    // Check for Welcome Modal
    const hasWelcome = await isVisible('[role="dialog"]')
    if (hasWelcome) {
      await snap('01a-welcome-modal-step1')

      // Step 1: Fill name
      await typeText('Test User')
      await sleep(500)

      // Click "Continue" button (step 1 → step 2)
      await cdpSend('Runtime.evaluate', {
        expression: `(() => {
          const btns = [...document.querySelectorAll('button')];
          const continueBtn = btns.find(b => b.textContent?.trim() === 'Continue');
          if (continueBtn) { continueBtn.click(); return 'clicked Continue'; }
          return 'Continue not found';
        })()`,
        returnByValue: true
      })
      await sleep(1500)

      // Step 2: Avatar selection
      await snap('01b-welcome-modal-step2')

      // Select first avatar
      await cdpSend('Runtime.evaluate', {
        expression: `(() => {
          const btns = [...document.querySelectorAll('button')];
          const avatarBtn = btns.find(b => b.querySelector('img'));
          if (avatarBtn) { avatarBtn.click(); return 'clicked avatar'; }
          return 'no avatar btn';
        })()`,
        returnByValue: true
      })
      await sleep(500)

      // Click "Get Started" button (completes welcome)
      await cdpSend('Runtime.evaluate', {
        expression: `(() => {
          const btns = [...document.querySelectorAll('button')];
          const btn = btns.find(b => b.textContent?.trim() === 'Get Started');
          if (btn) { btn.click(); return 'clicked Get Started'; }
          return 'Get Started not found: ' + btns.map(b => b.textContent?.trim()).join(', ');
        })()`,
        returnByValue: true
      })
      await sleep(3000) // Wait for profile save and re-render
    }

    // ── 2. Home Screen ─────────────────────────────────────────
    await snap('02-home-screen')

    // ── 3. App Settings ────────────────────────────────────────
    if (await clickLabel('Settings')) {
      await sleep(800)
      await snap('03-app-settings')
      await clickLabel('Settings') // Toggle back
      await sleep(500)
    }

    // ── 4. Try to select a workspace ───────────────────────────
    let hasWorkspace = false
    // Click any card/workspace element on the home screen
    const clickedWs = await cdpSend('Runtime.evaluate', {
      expression: `(() => {
        // Look for workspace cards (group class, hover effects, cards)
        const cards = document.querySelectorAll('.group, [class*="hover:bg-"], [class*="cursor-pointer"]');
        for (const c of cards) {
          if (c.offsetParent !== null && c.closest('[role="dialog"]') === null) {
            c.click();
            return true;
          }
        }
        return false;
      })()`,
      returnByValue: true
    })
    if (clickedWs.result?.value) {
      await sleep(1500)
      hasWorkspace = true
    }

    // ── 5-6. Chat Panel & Sidebar ──────────────────────────────
    await snap('04-chat-panel')
    await snap('05-chat-sidebar')

    // ── 7. Agent Monitor Panel ─────────────────────────────────
    if (await clickLabel('Show agent panel')) {
      await sleep(800)
      await snap('06-agent-monitor')
      await clickLabel('Hide agent panel')
      await sleep(400)
    }

    // ── 9. Workspace Settings — all tabs ───────────────────────
    if (hasWorkspace && (await clickLabel('Workspace Settings'))) {
      await sleep(800)

      const tabs = [
        { name: 'Workspace', file: '08-ws-general' },
        { name: 'Models', file: '09-ws-models' },
        { name: 'Repository', file: '10-ws-repository' },
        { name: 'Team', file: '11-ws-team' },
        { name: 'Ideas', file: '12-ws-ideas' },
        { name: 'Memory', file: '13-ws-memory' },
        { name: 'Documents', file: '14-ws-documents' },
        { name: 'Tokens', file: '15-ws-tokens' }
      ]

      for (const tab of tabs) {
        await clickText(`^${tab.name}$`)
        await sleep(600)
        await snap(tab.file)
      }

      await clickLabel('Workspace Settings')
      await sleep(500)
    }

    // ── 10. New Conversation Modal ─────────────────────────────
    if (hasWorkspace) {
      // Meta+N (Cmd+N on Mac)
      await pressKey('n', 4) // 4 = Meta modifier
      await sleep(800)
      await snap('16-new-conversation-modal')
      await pressKey('Escape')
      await sleep(400)
    }

    // ── 11. Full layout with all panels ────────────────────────
    await clickLabel('Show agent panel')
    await sleep(800)
    await snap('17-full-layout-all-panels')

    // ── 12. Home (no workspace) ────────────────────────────────
    await clickLabel('Home')
    await sleep(800)
    await snap('18-home-no-workspace')

    console.log('\n✅ All screenshots captured in e2e/screenshots/')
  } finally {
    // Cleanup
    if (ws) ws.close()
    if (electronProcess && !electronProcess.killed) {
      electronProcess.kill('SIGTERM')
      await sleep(2000)
      if (!electronProcess.killed) electronProcess.kill('SIGKILL')
    }
  }
}

main().catch((err) => {
  console.error('❌ Screenshot capture failed:', err.message)
  process.exit(1)
})
