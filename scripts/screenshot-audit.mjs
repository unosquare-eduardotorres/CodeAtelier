/**
 * Playwright screenshot audit script for Agent Studio.
 *
 * Launches the Electron app via electron-vite dev, waits for the renderer
 * to be ready, then captures screenshots of every major page/state.
 *
 * Usage:  node scripts/screenshot-audit.mjs
 */
import { _electron as electron } from 'playwright'
import { execSync, spawn } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SCREENSHOTS = path.join(ROOT, 'screenshots')

if (!existsSync(SCREENSHOTS)) mkdirSync(SCREENSHOTS, { recursive: true })

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function screenshot(page, name, waitMs = 500) {
  await sleep(waitMs)
  const filePath = path.join(SCREENSHOTS, `${name}.png`)
  await page.screenshot({ path: filePath, fullPage: false })
  console.log(`  -> ${name}.png`)
}

async function main() {
  console.log('\n=== Agent Studio Screenshot Audit ===\n')

  // Build the renderer first so we have something to load
  console.log('1. Building renderer for dev...')

  // Launch electron-vite in dev mode
  console.log('2. Starting electron-vite dev...')
  const devProcess = spawn('npx', ['electron-vite', 'dev'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development' }
  })

  // Wait for vite to be ready
  let viteReady = false
  const readyPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 60000)
    const handler = (data) => {
      const text = data.toString()
      if (text.includes('Electron') || text.includes('ready') || text.includes('localhost')) {
        viteReady = true
        clearTimeout(timeout)
        resolve(true)
      }
    }
    devProcess.stdout.on('data', handler)
    devProcess.stderr.on('data', handler)
  })

  const ready = await readyPromise
  if (!ready) {
    console.error('Timed out waiting for electron-vite dev')
    devProcess.kill()
    process.exit(1)
  }

  // Give the app a few seconds to fully initialize
  console.log('3. Waiting for app to initialize...')
  await sleep(5000)

  // Now connect to the Electron app using Playwright
  console.log('4. Connecting to Electron via Playwright...\n')

  let app
  try {
    app = await electron.launch({
      executablePath: path.join(ROOT, 'node_modules', '.bin', 'electron'),
      args: [path.join(ROOT, 'out', 'main', 'index.js')],
      timeout: 30000
    })
  } catch (e) {
    // If out/main doesn't exist, try launching via electron-vite directly
    console.log('   Direct launch failed, trying alternative approach...')
    // Kill the dev process, we will do a build + launch instead
    devProcess.kill()

    console.log('   Building project...')
    execSync('npx electron-vite build', { cwd: ROOT, stdio: 'inherit' })

    app = await electron.launch({
      executablePath: path.join(ROOT, 'node_modules', '.bin', 'electron'),
      args: [path.join(ROOT, 'out', 'main', 'index.js')],
      timeout: 30000
    })
  }

  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await sleep(3000) // Let React fully render

  console.log('Capturing screenshots...\n')

  // ── Page 1: Welcome Modal (first-launch state) or Welcome Screen ──
  await screenshot(window, '01-initial-load', 2000)

  // Check what state we're in
  const hasWelcomeModal = await window.locator('text=Welcome').count()
  if (hasWelcomeModal > 0) {
    await screenshot(window, '02-welcome-modal', 500)

    // Fill in the welcome modal to get past it
    const nameInput = window.locator('input[type="text"]').first()
    if (await nameInput.count()) {
      await nameInput.fill('Audit User')
      await sleep(300)
      await screenshot(window, '03-welcome-modal-filled', 500)

      // Try to click "Next" or "Continue"
      const nextBtn = window.locator('button:has-text("Next")').first()
      if (await nextBtn.count()) {
        await nextBtn.click()
        await sleep(500)
        await screenshot(window, '04-welcome-modal-step2', 500)
      }

      // Try to complete it
      const completeBtn = window
        .locator('button:has-text("Get Started"), button:has-text("Continue"), button:has-text("Done"), button:has-text("Save")')
        .first()
      if (await completeBtn.count()) {
        await completeBtn.click()
        await sleep(1000)
      }
    }
  }

  // ── Page 2: Home / Welcome Screen (no workspace) ──
  await screenshot(window, '05-home-welcome-screen', 1000)

  // Try to open a workspace (click first one if any exist)
  const workspaceCard = window.locator('[class*="workspace"], [class*="card"]').first()
  if (await workspaceCard.count()) {
    await workspaceCard.click()
    await sleep(1500)
    await screenshot(window, '06-workspace-selected', 500)
  }

  // ── Page 3: Try "Open Folder" or "Add Workspace" to get into workspace state ──
  const openBtn = window
    .locator(
      'button:has-text("Open"), button:has-text("Add"), button:has-text("New Workspace"), button:has-text("Select")'
    )
    .first()
  if (await openBtn.count()) {
    await screenshot(window, '07-pre-workspace-buttons', 300)
  }

  // ── Page 4: Chat panel (if workspace is active) ──
  const chatArea = window.locator('[class*="chat"], [class*="Chat"]').first()
  if (await chatArea.count()) {
    await screenshot(window, '08-chat-panel', 500)
  }

  // ── Page 5: Settings Page ──
  // Click the settings/sliders button in the title bar
  const settingsBtn = window.locator('button[aria-label="Settings"]').first()
  if (await settingsBtn.count()) {
    await settingsBtn.click()
    await sleep(1000)
    await screenshot(window, '09-settings-page', 500)

    // Scroll down to see more settings
    await window.evaluate(() => {
      const main = document.querySelector('main') || document.querySelector('[class*="settings"]')
      if (main) main.scrollTop = main.scrollHeight / 2
    })
    await screenshot(window, '10-settings-page-scrolled', 500)

    // Go back
    const backBtn = window
      .locator('button:has-text("Back"), button[aria-label="Back"]')
      .first()
    if (await backBtn.count()) {
      await backBtn.click()
      await sleep(500)
    } else {
      // Press Escape to go back
      await window.keyboard.press('Escape')
      await sleep(500)
    }
  }

  // ── Page 6: Workspace Settings ──
  const wsSettingsBtn = window.locator('button[aria-label="Workspace Settings"]').first()
  if (await wsSettingsBtn.count()) {
    await wsSettingsBtn.click()
    await sleep(1000)
    await screenshot(window, '11-workspace-settings', 500)

    // Click through workspace settings tabs
    const tabs = ['Agents', 'Skills', 'Team', 'Memory', 'Dream']
    for (const tabName of tabs) {
      const tab = window.locator(`text="${tabName}"`).first()
      if (await tab.count()) {
        await tab.click()
        await sleep(800)
        await screenshot(window, `12-ws-settings-${tabName.toLowerCase()}`, 300)
      }
    }

    // Close workspace settings
    await window.keyboard.press('Escape')
    await sleep(500)
  }

  // ── Page 7: Agent Monitor Panel ──
  const agentPanelBtn = window.locator('button:has-text("Agents")').first()
  if (await agentPanelBtn.count()) {
    await agentPanelBtn.click()
    await sleep(800)
    await screenshot(window, '13-agent-monitor-panel', 500)
  }

  // ── Page 8: New Conversation Modal ──
  // Trigger via keyboard shortcut Cmd+N
  await window.keyboard.press('Meta+n')
  await sleep(800)
  await screenshot(window, '14-new-conversation-modal', 500)
  await window.keyboard.press('Escape')
  await sleep(300)

  // ── Final: Full-app overview ──
  await screenshot(window, '15-final-overview', 500)

  // Set a large viewport to capture at 1440px
  await window.setViewportSize({ width: 1440, height: 900 })
  await sleep(500)
  await screenshot(window, '16-viewport-1440', 500)

  // And 1920px
  await window.setViewportSize({ width: 1920, height: 1080 })
  await sleep(500)
  await screenshot(window, '17-viewport-1920', 500)

  console.log('\n=== All screenshots captured ===')
  console.log(`Location: ${SCREENSHOTS}\n`)

  // Cleanup
  await app.close()
  devProcess.kill()
}

main().catch((err) => {
  console.error('Screenshot audit failed:', err)
  process.exit(1)
})
