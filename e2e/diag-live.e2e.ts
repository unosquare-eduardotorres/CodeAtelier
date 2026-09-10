import { mkdirSync } from 'fs'
import { join } from 'path'
import { test } from './helpers/electron-fixture'

test('diagnose live page', async ({ page }) => {
  test.setTimeout(120_000)
  const out = join(process.cwd(), '.impeccable', 'screenshots')
  mkdirSync(out, { recursive: true })
  // Long unconditional settle — window creation under CDP may be slow.
  for (const waitMs of [15_000, 30_000, 45_000]) {
    await page.waitForTimeout(waitMs === 15_000 ? 15_000 : 15_000)
    const browser = page.context().browser()
    const ctxs = browser?.contexts() ?? []
    for (let ci = 0; ci < ctxs.length; ci++) {
      const pages = ctxs[ci].pages()
      for (let pi = 0; pi < pages.length; pi++) {
        const p = pages[pi]
        console.log(`@${waitMs} CTX${ci}/P${pi}: ${p.url()}`)
        if (p.url().includes('index.html')) {
          await p.bringToFront().catch(() => undefined)
          await p.waitForTimeout(1_500)
          await p.screenshot({ path: join(out, 'diag-real-app.png') })
          console.log(`CAPTURED at ${waitMs}`)
          return
        }
      }
    }
  }
})
