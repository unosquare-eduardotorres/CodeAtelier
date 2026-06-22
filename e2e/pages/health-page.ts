/**
 * HealthPage POM — Audit lifecycle interactions.
 *
 * Covers the 4-state health view machine:
 * landing → configure → active → plan
 */
import type { Page, Locator } from '@playwright/test'

export class HealthPage {
  readonly page: Page

  // Health views
  readonly landing: Locator
  readonly configure: Locator
  readonly overview: Locator
  readonly planCard: Locator

  constructor(page: Page) {
    this.page = page
    this.landing = page.locator('[data-testid="health-landing"]')
    this.configure = page.locator('[data-testid="health-configure"]')
    this.overview = page.locator('[data-testid="health-overview"]')
    this.planCard = page.locator('[data-testid="audit-plan-card"]')
  }

  /** Start a new audit from the landing page. */
  async startAudit(mode: 'light' | 'deep' = 'light'): Promise<void> {
    // Click "New Audit" button
    const newAuditBtn = this.page.getByRole('button', { name: /new audit|run audit/i })
    await newAuditBtn.click()
    await this.page.waitForTimeout(500)

    // Select mode if on configure page
    if (mode === 'deep') {
      const deepBtn = this.page.getByRole('button', { name: /deep/i })
      if (await deepBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await deepBtn.click()
        await this.page.waitForTimeout(300)
      }
    }
  }

  /** Click the "Start Audit" button on the configure page. */
  async confirmStart(): Promise<void> {
    const startBtn = this.page.getByRole('button', { name: /start audit|run/i })
    await startBtn.click()
    await this.page.waitForTimeout(500)
  }

  /** Check if an audit is currently running (any track shows "running"). */
  async isRunning(): Promise<boolean> {
    const runningIndicator = this.page.locator('text=running').first()
    return runningIndicator.isVisible({ timeout: 2_000 }).catch(() => false)
  }

  /** Get track card locators in the overview. */
  getTrackCards(): Locator {
    return this.overview.locator('[class*="rounded-xl"]')
  }

  /** Wait for the audit to complete (overview appears). */
  async waitForComplete(timeout = 300_000): Promise<void> {
    await this.overview.waitFor({ state: 'visible', timeout })
  }

  /** Select findings for plan generation. */
  async selectFindings(): Promise<void> {
    const checkboxes = this.page.locator('input[type="checkbox"]')
    const count = await checkboxes.count()
    // Select up to the first 3 findings
    for (let i = 0; i < Math.min(count, 3); i++) {
      await checkboxes.nth(i).check()
    }
    await this.page.waitForTimeout(300)
  }

  /** Click "Generate Plan" after selecting findings. */
  async generatePlan(): Promise<void> {
    const planBtn = this.page.getByRole('button', { name: /generate plan/i })
    await planBtn.click()
    await this.page.waitForTimeout(500)
  }

  /** Get audit history cards on the landing page. */
  getHistoryCards(): Locator {
    return this.landing.locator('[class*="rounded-xl"]')
  }
}
