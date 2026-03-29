/**
 * Playwright Electron screenshot audit for Agent Studio.
 * Launches the built app and captures every major page/state.
 *
 * Usage:  node scripts/screenshot-audit.mjs
 */
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SCREENSHOTS = path.join(ROOT, 'screenshots')

if (!existsSync(SCREENSHOTS)) mkdirSync(SCREENSHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function snap(page, name, waitMs = 800) {
  await sleep(waitMs)
  const filePath = path.join(SCREENSHOTS, `${name}.png`)
  await page.screenshot({ path: filePath })
  console.log(`  [+] ${name}.png`)
}

async function main() {
  console.log('\n========================================')
  console.log('  Code Atelier — Screenshot Audit')
  console.log('========================================\n')

  // Launch Electron — pass the project root (which has package.json with main: ./out/main/index.js)
  console.log('Launching Electron app...')
  const app = await electron.launch({
    args: [ROOT],
    timeout: 30000,
    cwd: ROOT
  })

  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  console.log('Window loaded. Waiting for React to render...\n')
  await sleep(4000)

  // ─── 1. Initial state (Welcome Modal or Home) ───
  console.log('--- Page 1: Initial Load ---')
  await snap(win, '01-initial-load', 1000)

  // Check if we see the Welcome Modal
  const welcomeVisible = await win.locator('text=Welcome to Code Atelier').count().catch(() => 0)

  if (welcomeVisible > 0) {
    console.log('--- Page 2: Welcome Modal (Step 1) ---')
    await snap(win, '02-welcome-modal-step1')

    // Fill name
    const nameInput = win.locator('input').first()
    if ((await nameInput.count()) > 0) {
      await nameInput.fill('Audit User')
      await sleep(300)
      await snap(win, '03-welcome-modal-filled')
    }

    // Click Next/Continue
    for (const label of ['Next', 'Continue']) {
      const btn = win.locator(`button:has-text("${label}")`).first()
      if ((await btn.count()) > 0) {
        await btn.click()
        await sleep(800)
        await snap(win, '04-welcome-modal-step2')
        break
      }
    }

    // Complete the modal
    for (const label of ['Get Started', 'Done', 'Save', 'Continue', 'Finish']) {
      const btn = win.locator(`button:has-text("${label}")`).first()
      if ((await btn.count()) > 0) {
        await btn.click()
        await sleep(1500)
        break
      }
    }
  }

  // ─── 2. Home / Welcome Screen (no workspace selected) ───
  console.log('--- Page 3: Home Screen ---')
  await snap(win, '05-home-screen', 1500)

  // ─── 3. Try to select a workspace ───
  // Look for any clickable workspace card or Open Folder button
  const openFolderBtn = win.locator('button:has-text("Open Folder"), button:has-text("Open Project"), button:has-text("Select Folder")').first()
  if ((await openFolderBtn.count()) > 0) {
    await snap(win, '06-open-folder-button-visible')
  }

  // Look for existing workspace cards
  const workspaceItems = win.locator('[role="button"], button').filter({ hasText: /workspace|project/i }).first()
  if ((await workspaceItems.count()) > 0) {
    await workspaceItems.click()
    await sleep(2000)
    console.log('--- Page 4: Workspace Selected ---')
    await snap(win, '07-workspace-selected')
  }

  // ─── 4. App Settings Page ───
  console.log('--- Page 5: App Settings ---')
  const settingsBtn = win.locator('button[aria-label="Settings"]').first()
  if ((await settingsBtn.count()) > 0) {
    await settingsBtn.click()
    await sleep(1200)
    await snap(win, '08-app-settings')

    // Scroll settings
    await win.evaluate(() => {
      const el = document.querySelector('[class*="overflow-y"]') || document.querySelector('main')
      if (el) el.scrollTop = 400
    })
    await snap(win, '09-app-settings-scrolled')

    // Scroll more
    await win.evaluate(() => {
      const el = document.querySelector('[class*="overflow-y"]') || document.querySelector('main')
      if (el) el.scrollTop = el.scrollHeight
    })
    await snap(win, '10-app-settings-bottom')

    // Go back
    await win.keyboard.press('Escape')
    await sleep(500)
  }

  // ─── 5. Workspace Settings ───
  console.log('--- Page 6: Workspace Settings ---')
  const wsBtn = win.locator('button[aria-label="Workspace Settings"]').first()
  if ((await wsBtn.count()) > 0) {
    await wsBtn.click()
    await sleep(1200)
    await snap(win, '11-workspace-settings')

    // Click through tabs
    const tabs = ['Agents', 'Skills', 'Team']
    for (let i = 0; i < tabs.length; i++) {
      const tab = win.locator(`button:has-text("${tabs[i]}"), [role="tab"]:has-text("${tabs[i]}")`).first()
      if ((await tab.count()) > 0) {
        await tab.click()
        await sleep(1000)
        await snap(win, `12-ws-${tabs[i].toLowerCase()}-tab`)
      }
    }

    // Close
    await wsBtn.click()
    await sleep(500)
  }

  // ─── 6. Chat Panel (if workspace active) ───
  console.log('--- Page 7: Chat Panel ---')
  await snap(win, '13-chat-panel')

  // ─── 7. New Conversation Modal ───
  console.log('--- Page 8: New Conversation Modal ---')
  await win.keyboard.press('Meta+n')
  await sleep(1000)
  const modalVisible = await win.locator('[role="dialog"]').count().catch(() => 0)
  if (modalVisible > 0) {
    await snap(win, '14-new-conversation-modal')
    await win.keyboard.press('Escape')
    await sleep(500)
  }

  // ─── 8. Agent Monitor Panel ───
  console.log('--- Page 9: Agent Monitor ---')
  const agentBtn = win.locator('button[aria-label*="agent" i], button:has-text("Agents")').first()
  if ((await agentBtn.count()) > 0) {
    await agentBtn.click()
    await sleep(1000)
    await snap(win, '15-agent-monitor-panel')
  }

  // ─── 9. Different viewport sizes ───
  console.log('--- Viewport Tests ---')
  await win.setViewportSize({ width: 1440, height: 900 })
  await sleep(800)
  await snap(win, '16-viewport-1440x900')

  await win.setViewportSize({ width: 1920, height: 1080 })
  await sleep(800)
  await snap(win, '17-viewport-1920x1080')

  await win.setViewportSize({ width: 1024, height: 768 })
  await sleep(800)
  await snap(win, '18-viewport-1024x768')

  console.log('\n========================================')
  console.log('  All screenshots captured!')
  console.log(`  Location: ${SCREENSHOTS}`)
  console.log('========================================\n')

  await app.close()
}

main().catch((err) => {
  console.error('Screenshot audit failed:', err.message)
  process.exit(1)
})
