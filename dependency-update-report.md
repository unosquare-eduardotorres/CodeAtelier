# 📦 Dependency Update Report — Code Atelier

**Date:** 2026-07-24 | **Node.js:** v25.9.0 | **Electron:** 43.2.0

---

## ✅ Completed Updates

### Phase 1 — Tier 0: npm update (within semver range)

| Package                | Before  | After   | Type                         |
| ---------------------- | ------- | ------- | ---------------------------- |
| `react`                | 19.2.7  | 19.2.8  | Patch — bug fixes            |
| `@opencode-ai/sdk`     | 1.17.9  | 1.18.4  | Minor — new features & fixes |
| `@iconify-json/lucide` | 1.2.117 | 1.2.118 | Patch — new icons            |

**Result:** ✅ Zero code changes, all tests pass.

---

### Phase 2 — Tier 1: Version range bumps (17 packages)

#### Security & Stability

| Package            | Before  | After   | Gain                                 |
| ------------------ | ------- | ------- | ------------------------------------ |
| `electron-updater` | ^6.8.3  | ^6.8.9  | Auto-update reliability, macOS fixes |
| `@electron/fuses`  | ^2.1.2  | ^2.1.3  | Fuse-flipping patch                  |
| `ws`               | ^8.20.0 | ^8.21.1 | WebSocket security/perf fixes        |
| `jsdom`            | ^29.0.1 | ^29.1.1 | DOM spec compliance                  |

#### Developer Experience

| Package        | Before  | After    | Gain                             |
| -------------- | ------- | -------- | -------------------------------- |
| `prettier`     | ^3.7.4  | ^3.9.6   | Better formatting for new syntax |
| `tsx`          | ^4.21.0 | ^4.23.1  | Faster test runner, TS compat    |
| `simple-git`   | ^3.33.0 | ^3.36.0  | Git operation improvements       |
| `c8`           | ^11.0.0 | ^12.0.0  | Major bump (Node ≥20.19, met ✅) |
| `@types/react` | ^19.2.7 | ^19.2.17 | Better type coverage             |

#### UI Improvements

| Package                       | Before   | After    | Gain                               |
| ----------------------------- | -------- | -------- | ---------------------------------- |
| `lucide-react`                | ^1.17.0  | ^1.26.0  | ~90 new icons, tree-shaking        |
| `mermaid`                     | ^11.13.0 | ^11.16.0 | New diagram types, rendering fixes |
| `react-router-dom`            | ^7.13.1  | ^7.18.1  | Performance improvements           |
| `@tanstack/react-virtual`     | ^3.14.3  | ^3.14.8  | Scroll virtualization fixes        |
| `react-diff-viewer-continued` | ^4.2.0   | ^4.4.0   | Diff rendering improvements        |
| `tailwindcss`                 | ^4.3.0   | ^4.3.3   | Patch fixes                        |
| `@tailwindcss/vite`           | ^4.3.1   | ^4.3.3   | Patch fixes                        |
| `zustand`                     | ^5.0.12  | ^5.0.14  | State management patches           |

**Result:** ✅ All 4561 unit tests pass, both typechecks clean, electron-vite build succeeds.

---

### Phase 3 — TypeScript 7.0.2 (Go-Native Compiler)

**Setup:** Side-by-side installation:

- `typescript@6.0.3` — retained for ESLint/typescript-eslint JS API compatibility
- `typescript-native` (alias for `typescript@7.0.2`) — Go-native compiler for typechecking

**Performance Impact:**

| Config                      | TS6 Time | TS7 Time | Speedup  |
| --------------------------- | -------- | -------- | -------- |
| `tsconfig.node.json`        | 0.992s   | 0.214s   | **4.6x** |
| `tsconfig.web.json`         | 4.488s   | 0.479s   | **9.4x** |
| `npm run typecheck` (total) | ~5.5s    | **1.6s** | **3.4x** |

**Changes Made:**

- Added `"typescript-native": "npm:typescript@^7.0.2"` to devDependencies
- Updated `typecheck:node` and `typecheck:web` scripts to use `node_modules/typescript-native/bin/tsc`
- No tsconfig changes required (existing `bundler` moduleResolution, `esnext` target, explicit `types` are all TS7-compatible)

**Result:** ✅ All tests pass, ESLint works with TS6 API, electron-vite build succeeds.

---

## ⏸️ Deferred Updates

### Phase 4 — ESLint 10: Blocked

**Status:** ⛔ Blocked by `eslint-plugin-react@7.37.5`

- `eslint-plugin-react` only supports `eslint ^9.7` (no `^10` in peerDeps)
- All other plugins support ESLint 10: `react-hooks`, `react-refresh`, `typescript-eslint`, electron-toolkit configs
- **Action:** Monitor `eslint-plugin-react` releases for ESLint 10 support

### Phase 5 — Electron 43: ✅ Completed

Upgraded from Electron 42.7.0 → 43.2.0 (Chromium 150, Node.js 24.17).

- Updated `package.json`: `"electron": "43.2.0"`
- Updated `electron-builder.yml`: `electronVersion: 43.2.0`
- Updated `scripts/BUILD-MAC-RECIPE.md`: Electron version table row
- None of Electron 43's 6 breaking changes affect this codebase
- All 4570 unit tests pass, 397/398 repo tests pass (1 pre-existing failure)
- electron-vite build succeeds
- Gains: faster startup (V8 bytecode caching, Node.js startup snapshot, ThinLTO), Chromium 150 security patches, correct preload stack traces

### Other Deferred

| Item                  | Reason                                            |
| --------------------- | ------------------------------------------------- |
| **Vite 8**            | `electron-vite@6.0.0` still in beta               |
| **react-dropzone 19** | 4 major versions behind, needs usage audit        |
| **@types/node**       | Bump to ^25 to match Node runtime (currently ^22) |

---

## Verification Summary

| Check                       | Result                                                        |
| --------------------------- | ------------------------------------------------------------- |
| Unit tests (run-tests.ts)   | ✅ 4561 passed, 0 failed                                      |
| Repo tests (run-tests.ts)   | ✅ 397 passed, 1 failed (pre-existing)                        |
| TypeScript typecheck (node) | ✅ Clean (0.214s with TS7)                                    |
| TypeScript typecheck (web)  | ✅ Clean (0.479s with TS7)                                    |
| ESLint                      | ✅ Works with TS6 API                                         |
| electron-vite build         | ✅ Succeeds (12.57s)                                          |
| npm audit                   | 3 moderate vulnerabilities (pre-existing, in transitive deps) |

---

## Total Changes

- **21 packages updated** (3 Tier 0 + 17 Tier 1 + Electron 43)
- **1 package added** (`typescript-native` for TS7 Go compiler)
- **2 npm scripts modified** (typecheck:node, typecheck:web)
- **3 files updated for Electron 43** (package.json, electron-builder.yml, BUILD-MAC-RECIPE.md)
- **0 source code changes**
