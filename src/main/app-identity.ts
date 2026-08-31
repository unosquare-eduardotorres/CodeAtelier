/**
 * App identity — resolves the userData directory, and must be imported before
 * anything else in the main process.
 *
 * WHY THIS FILE EXISTS
 *
 * Electron derives `userData` from `app.getName()`, and caches it the first
 * time anything asks for it. The name itself is resolved differently per
 * platform and per build:
 *
 *   - macOS packaged  → CFBundleName from Info.plist  → "Code Atelier"
 *   - Windows/Linux   → package.json `productName` ?? `name` → "code-atelier"
 *   - dev             → package.json `name`, or "Electron" when that is not
 *                       resolvable from the launch cwd
 *
 * `app.setName()` used to be called partway down index.ts, *after* the logger
 * and DB modules were imported. Whichever ran first won: if an import touched
 * `app.getPath('userData')` before the rename, the store landed under the old
 * name; if not, it landed under the new one. Adding or reordering a single
 * import at the top of index.ts was enough to flip the directory — and a flip
 * presents to the user as a factory-fresh app: no workspaces, no blueprints,
 * and no Jira/GitHub credentials, because those are encrypted blobs inside the
 * database that just went out of scope.
 *
 * Four stores accumulated this way in practice: "Code Atelier", "code-atelier",
 * "Electron" and the pre-rename "agent-studio".
 *
 * Setting the name here — in a module with no dependencies, imported on the
 * first line of index.ts — makes the choice deterministic and independent of
 * import order.
 */

import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Store name for released builds. This must never change again: renaming it
 * strands every existing installation's data, which is how the "agent-studio"
 * directory was orphaned.
 */
const PACKAGED_NAME = 'Code Atelier'

/**
 * Dev runs keep a separate store on purpose — a debugging session must not be
 * able to corrupt or migrate the database someone relies on day to day.
 */
const DEV_NAME = 'code-atelier'

/** Store names earlier builds resolved to, most recent first. */
const LEGACY_NAMES = ['code-atelier', 'Electron', 'agent-studio']

/** Database filename inside a store — the marker for "this directory has data". */
const DB_FILE = 'code-atelier.db'

// Must happen before any module resolves a userData-derived path.
app.setName(app.isPackaged ? PACKAGED_NAME : DEV_NAME)

/**
 * Debugging switch: run dev under the PACKAGED identity so it can decrypt
 * credentials the deployed app encrypted (safeStorage keys are per-app-name)
 * and read the real store. Requires the user to approve a keychain access
 * prompt the first time (different binary, same keychain entry).
 */
if (!app.isPackaged && process.env.DEV_USE_PACKAGED_IDENTITY === '1') {
  app.setName(PACKAGED_NAME)
}

/**
 * E2E isolation: when the test fixture points the app at a throwaway store,
 * redirect userData BEFORE anything resolves a path from it. Model-driven E2E
 * (shim or live) creates workspaces/blueprints over IPC — without this they
 * land in the developer's real profile, and the assertions read it back.
 * Plain UI e2e runs don't set the variable and keep the real profile.
 */
if (process.env.E2E_USER_DATA) {
  app.setPath('userData', process.env.E2E_USER_DATA)
}

/**
 * Point at an older store when the canonical one is empty.
 *
 * Pinning the name is what stops future flips, but for anyone whose data
 * currently sits under a legacy name the pin would itself read as one last
 * wipe. This redirects instead of moving bytes: nothing is copied, nothing is
 * deleted, and a 900 MB database is not touched during startup.
 *
 * Deliberately conservative — it only acts when the answer is unambiguous:
 *   - packaged builds only (a dev run must never adopt the shipped store)
 *   - only when the canonical store holds no database
 *   - only when exactly one legacy store holds one
 *
 * With two or more candidates there is no safe way to guess which one the user
 * considers current, so it leaves them alone and logs instead.
 */
function adoptLegacyStore(): void {
  if (!app.isPackaged) return

  const canonical = app.getPath('userData')
  if (existsSync(join(canonical, DB_FILE))) return

  const appData = app.getPath('appData')
  const candidates = LEGACY_NAMES.map((name) => join(appData, name)).filter(
    (dir) => dir !== canonical && existsSync(join(dir, DB_FILE))
  )

  if (candidates.length === 0) return
  if (candidates.length > 1) {
    console.warn(
      `[app-identity] ${candidates.length} legacy stores hold a database ` +
        `(${candidates.join(', ')}). Staying on ${canonical} — pick one manually.`
    )
    return
  }

  app.setPath('userData', candidates[0])
  console.warn(`[app-identity] Adopted legacy store ${candidates[0]} (canonical was empty)`)
}

adoptLegacyStore()
