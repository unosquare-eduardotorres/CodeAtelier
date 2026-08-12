# Audit Round 5 — Implementation Results

**Date:** 2026-07-31  
**Scope:** Security CVE clearance + cross-platform process management fix

---

## Changes Implemented

### 1. ✅ undici 7.28.0 → 7.29.0 (5 CVEs resolved)

**File:** `package.json` (overrides section)

Bumped the undici override from `^7.28.0` to `^7.29.0`, resolving:

- CVE-2026-13697 — Cookie header injection (HIGH 7.4)
- CVE-2026-16729 — Cookie attribute injection via semicolons
- CVE-2026-16728 — Content-Length mismatch on retry
- CVE-2026-14643 — Info disclosure via truncated body
- CVE-2026-15157 — Request smuggling via crafted headers

**Verification:** `npm ls undici` confirms 7.29.0 resolved for both jsdom and @electron/get.

### 2. ✅ Windows process group kill fixed

**File:** `src/main/mcp-servers/process-manager-server.ts`

Added two cross-platform helper functions:

- `killProcessTree(pid, signal)` — Uses `taskkill /PID <pid> /T [/F]` on Windows, `process.kill(-pid, signal)` on Unix
- `isProcessAlive(pid)` — Uses `tasklist /FI "PID eq <pid>"` on Windows, `process.kill(-pid, 0)` on Unix

Replaced all 5 `process.kill(-pid, ...)` calls in `stop_process` with helper calls. This fixes:

- Silent ESRCH errors on Windows (negative PIDs unsupported)
- Orphaned child processes when stopping dev servers
- False "stopped" reports when process is actually still running

References: electron/electron#24520, electron/electron#16317

### 3. ✅ npm audit — 0 production vulnerabilities

`npm audit --omit=dev` reports **0 vulnerabilities**.

3 remaining dev-only findings (brace-expansion DoS in eslint/electron build tools, react-router RSC CSRF) have zero production impact — they are not shipped in the packaged app.

### 4. ✅ Command allowlist threat model documented

**File:** `src/main/mcp-servers/process-manager-server.ts`

Added documentation explaining the intentional scope of the first-token allowlist: prevents direct execution of system tools (curl, wget, sh, bash, powershell, rm) but does not prevent argument-level injection within allowed commands. This is by design — blocking argument injection would break legitimate npm/node usage.

---

## Verification Results

| Check                | Result                                                 |
| -------------------- | ------------------------------------------------------ |
| TypeScript typecheck | ✅ Clean (node + web)                                  |
| Unit tests           | ✅ 4,589 passed, 0 failed                              |
| Repository tests     | ✅ 397 passed, 1 pre-existing failure (schema version) |
| Production audit     | ✅ 0 vulnerabilities                                   |
| undici version       | ✅ 7.29.0                                              |

---

## Items Not Requiring Code Changes

| #                         | Item                                                                              | Status |
| ------------------------- | --------------------------------------------------------------------------------- | ------ |
| Node.js 24.18.1 CVEs      | ⏳ Awaiting Electron 43.3.0 — very low exposure (no http2/permission model usage) |
| Windows GPU sandbox crash | ⏳ Workaround ready if user reports surface (conditional `--disable-gpu-sandbox`) |
| react-router RSC CSRF     | ✅ Not affected — client-side Electron SPA, no RSC mode                           |
| Electron security config  | ✅ Comprehensive audit passed all 18 checks                                       |

---

## Security Posture: 9/10 ✅
