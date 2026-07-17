# macOS DMG Build Recipe

> **Target audience:** Developers and LLM agents building the signed DMG.
> **TLDR:** The build script is destructive. Follow this recipe exactly. Read the trap map.

## Prerequisites

- macOS with Xcode command-line tools
- Apple Developer ID certificate in Keychain
- Notarization credentials stored: `xcrun notarytool store-credentials code-atelier`
- Node.js 24+ and npm 11+
- `NODE_ENV` must NOT be `production` (or use `--include=dev` everywhere)
  - Check: `echo $NODE_ENV` — if `production`, the restore trap's `npm install` will silently skip devDependencies
  - Fix: `unset NODE_ENV` before building, or ensure all `npm install` calls use `--include=dev`

## Pre-Flight Checks (MANDATORY)

```bash
# All must pass before you start:
npm run typecheck:node 2>&1 | grep -c "error TS"    # Must be 0
npm run typecheck:web 2>&1 | grep -c "error TS"     # Must be 0
grep '"dependencies"' package.json                    # Must show 1 match
cp package.json package.json.safe                     # Safety backup
```

## Option A: Use the Script (Recommended)

```bash
npm run build:mac
```

Then verify restore worked:
```bash
grep '"dependencies"' package.json    # Must show 1 match
npm run typecheck:node 2>&1 | grep -c "error TS"  # Must be 0
```

## Option B: Manual Step-by-Step

```bash
# Step 1: Build
npm run build

# Step 2: Prune
npm prune --omit=dev

# Step 2b: Rebuild native modules
npx --yes @electron/rebuild --version 42.4.1 --module-dir . --types prod --force

# Step 2c: Strip dev files
rm -rf node_modules/electron
find node_modules -name '*.map' -type f -delete
find node_modules \( -name '*.d.ts' -o -name '*.d.mts' \) -type f -delete
find node_modules -type l ! -exec test -e {} \; -delete 2>/dev/null

# Step 2d: Isolate deps
cp package.json package.json.original
node -e "
const pkg = JSON.parse(require('fs').readFileSync('package.json','utf8'));
delete pkg.dependencies;
delete pkg.optionalDependencies;
require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));
"

# Step 3: Package
unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD
export APPLE_KEYCHAIN_PROFILE="${APPLE_KEYCHAIN_PROFILE:-code-atelier}"
NODE_OPTIONS="--max-old-space-size=16384" npx electron-builder --mac

# RESTORE (always, even on failure)
mv package.json.original package.json 2>/dev/null
cp package.json.safe package.json
rm -rf node_modules
npm install --include=dev
rm package.json.safe

# VERIFY
grep '"dependencies"' package.json
npm run typecheck:node 2>&1 | grep -c "error TS"
```

## Emergency Recovery

```bash
# package.json missing dependencies:
git show HEAD~1:package.json > package.json   # or: git checkout main -- package.json

# node_modules broken (missing .d.ts files):
# DIAGNOSE FIRST:
echo $NODE_ENV                                        # production? That's the cause
npm config get omit                                   # dev? That's the cause
find node_modules/electron-log -name '*.d.ts' | wc -l # 0? Confirms .d.ts stripped

# If .d.ts files are missing (NODE_ENV=production caused silent dev-dep omission):
rm -rf node_modules
npm install --include=dev                             # --include=dev is critical!

# Type errors appeared after build (but .d.ts files ARE present):
# These are LATENT BUGS, not new — fix the code, don't reinstall
```

## Key Constants

| Item | Value |
|---|---|
| Electron version | `42.4.1` |
| electron-builder | `26.15.3` |
| Node heap | `16384` MB |
| Signing identity | `Developer ID Application: UNOSQUARE LLC (PZY6PW4386)` |
| Keychain profile | `code-atelier` |
| Native module | `better-sqlite3` (only one) |
| DMG output | `dist/code-atelier-{version}.dmg` (~170 MB) |
| DMG window | 660×400 (120px icons) |

## Timing

| Phase | Duration |
|---|---|
| Typecheck + electron-vite build | ~30s |
| Prune + rebuild + strip | ~20s |
| Packaging | ~30s |
| Code signing | ~15s |
| **Notarization (Apple upload + processing)** | **5–8 min** |
| DMG + ZIP creation | ~30s |
| Restore (npm install --include=dev) | ~30s |
| **Total** | **~12–15 min** |

CI/automation timeouts must be >15 minutes.

## Why It Breaks: The Trap Map

The EXIT trap in `build-mac.sh` ALWAYS runs `rm -rf node_modules && npm install --include=dev`.

**Failure mode 1 — OOM:** electron-builder exceeds 16GB heap → trap fires → clean install exposes latent type errors that were hidden by stale `.d.ts` files.

**Failure mode 2 — Lost package.json:** Trap is interrupted → `package.json` stays without `dependencies` → next `npm install` installs nothing.

**Failure mode 3 — LLM panic reinstall:** An LLM sees type errors, runs `rm -rf node_modules && npm install` thinking it'll fix things → same clean install, same exposed latent bugs, infinite loop.

**The golden rule:** If typecheck shows errors after build:mac that weren't there before, the errors are REAL BUGS that were previously hidden. Fix the code, don't reinstall.
