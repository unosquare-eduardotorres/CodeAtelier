# Diagnosis: OpenCode server dies silently and the app never recovers

**App:** Code Atelier v1.0.105 (packaged, `/Applications/Code Atelier.app`)
**Repo:** `~/Downloads/AgentStudio` @ `b529083e chore(release): v1.0.105` — source matches the shipped build.
**Primary file:** `src/main/services/opencode-executor.ts` (3039 lines)
**Observed:** 2026-09-07, blueprint `blueprint-e2e-testing-pa-7624e83f`, workspace CongruityHR, 3 parallel build tasks (R010/R011/R012), provider `glm/glm-5.3` via z.ai.

---

## 1. Summary

The embedded OpenCode HTTP server (in-process, port 4096) died ~11 seconds after
accepting three prompts. The app never noticed, never restarted it, and **cannot**
restart it — a stale `isStarted = true` boolean permanently poisons the executor.
Every retry and every subsequently started task fails with `TypeError: fetch failed`.
Only a full app relaunch clears the state.

The recovery machinery to handle exactly this already exists in the file and is
**never invoked**.

---

## 2. Evidence

From `~/Library/Logs/Code Atelier/main.log`:

```
13:11:21.559  [opencode] ensureStarted: owner build-R010-1788808280731 acquired (1 active)
13:11:21.976  [opencode] Calling createOpencode with port 4096, timeout 10000ms
13:11:22.308  [opencode] ensureStarted: owner build-R012-1788808282032 acquired (2 active)
13:11:23.278  [opencode] ensureStarted: owner build-R011-1788808283135 acquired (3 active)
13:11:32.590  [opencode] server.connected not received within 10s — proceeding anyway     <-- early warning
13:11:40.216  [opencode] Session ses_...XzkDjqGINsDXbB created — provider=glm/glm-5.3
13:11:40.217  [opencode] Session ses_...PUzyuOFUqB3Mri created — provider=glm/glm-5.3
13:11:40.223  [opencode] Session ses_...eV4sm12lmV6Rbi created — provider=glm/glm-5.3
13:11:44.146  [opencode] Prompt accepted (204)   x3
13:11:55.977  [opencode] Unhandled event type: project.directories.updated   <-- LAST EVENT EVER
   (server dies here; no 'Stopping server', no releaseServer, no crash report)
13:20:05.101  [opencode] Mid-turn stall — no stream activity for 480000ms — attempt 1/3
13:20:35.119  [opencode] Retry prompt error: TypeError: fetch failed
13:28:35.123  [opencode] Mid-turn stall — no stream activity for 480000ms — attempt 2/3
13:29:35.133  [opencode] Retry prompt error: TypeError: fetch failed
```

Not a single stream token was ever produced. Confirmed dead server:

```
$ lsof -nP -iTCP:4096
Code\x20A 28442 ... TCP 127.0.0.1:62150->127.0.0.1:4096 (CLOSED)    # leftover socket only, no LISTEN
$ curl -m 5 http://127.0.0.1:4096/config
curl: (7) Failed to connect to 127.0.0.1 port 4096: Couldn't connect to server
```

Note: OpenCode runs **in-process** inside the Electron main process (`createOpencode`),
not as a child process. `ps | grep opencode` returns nothing even when healthy — do not
use it to check liveness. Probe port 4096.

---

## 3. Root cause

### D1 — The health monitor is dead code (the actual root cause)

`startHealthCheck()` is defined at `opencode-executor.ts:1849` and **is never called
anywhere in production code**. Verified:

```bash
$ grep -rn "startHealthCheck" --include=*.ts src | grep -v __tests__
src/main/services/opencode-executor.ts:1849:  startHealthCheck(...)     # the definition itself, nothing else

$ grep -c "startHealthCheck" /Applications/.../out/main/index.js
1                                                          # only the definition in the shipped bundle
```

The only other references are two assertions in
`__tests__/opencode-executor-deep-phase25.test.ts` that check the method *exists* and
that it *stores a timer reference*. Nothing tests that it runs, so the dead wiring is
invisible to CI.

This is painful because the method already implements the correct fix
(`opencode-executor.ts:1856-1891`): poll `checkHealth()` every
`HEALTH_CHECK_INTERVAL = 30_000` (`:461`), and after 3 consecutive failures call
`forceStop()` then `start(this.lastCwd, this.lastConfig)`. Had it been running, the
server would have been rebuilt roughly 90 seconds after it died, and the blueprint
would have continued on its own.

### D2 — `ensureStarted()` trusts a stale boolean instead of probing

`opencode-executor.ts:571-593`:

```ts
async ensureStarted(cwd, config) {
  const { ownerKey, ...startConfig } = config ?? {}
  if (ownerKey) { this.serverOwners.acquire(ownerKey); ... }
  try {
    if (this.startInFlight) { await this.startInFlight; return }
    if (this.isStarted) return          // <-- :587  no liveness check
    await this.start(cwd, startConfig)
  } catch (err) { ... }
}
```

`isStarted` is set `true` at `:832` and cleared to `false` in exactly one place —
inside `forceStop()` at `:1806`. `stop()` (`:1771`) delegates to `forceStop()` only
when `serverOwners.shouldStop()` (refcount 0).

A silent server death never runs teardown, so the three owners acquired at 13:11 are
**still held** and `isStarted` stays `true` forever. Consequences:

- Every retry POSTs to a dead port.
- Every *newly started* task short-circuits at `:587` and also POSTs to the dead port.
- **Retrying the blueprint from the UI cannot work.** Only relaunching the app helps.

This is the defect that turns a recoverable transient into a permanently wedged process.

### D3 — `resendPrompt()` swallows the failure, so retries burn full stall windows

`opencode-executor.ts:2621-2640`:

```ts
private resendPrompt(sessionId, promptBody, directory): void {
  if (!this.client) { log.warn('Retry skipped — client no longer available'); return }
  this.client.session.promptAsync({ ... })
    .catch((err) => { openCodeLog.error('[opencode] Retry prompt error:', err) })   // :2638
}
```

Fire-and-forget. The `TypeError: fetch failed` is logged and **discarded**; the
function returns `void` synchronously. The caller therefore treats the retry as
successfully dispatched, re-arms the stall watch (`resetStallWatch()`, `:1124`) and
waits another full 480 s for activity that can never arrive.

The retry path cannot distinguish "server is slow" from "server is gone."

### D4 — Time-to-signal is 8 minutes, time-to-failure ~26 minutes

`MID_TURN_STALL_MS = 240_000` (`:431`), but remote providers use
`provider-timeout-tiers.ts:68` → `midTurnStallMs: 480_000`, applied at
`opencode-executor.ts:1639`. With `MAX_TRANSIENT_RETRIES = 3` (`:183`) and
slow-class exponential backoff `SLOW_RETRY_BASE_DELAY_MS = 30_000` (`:193`),
a dead server takes ~26 minutes to surface as a task failure, and the UI shows
nothing at all for the first 8. A dead TCP port is detectable in milliseconds.

### D5 — The executor proceeds against an unconfirmed server

`opencode-executor.ts:849` logs `server.connected not received within 10s — proceeding
anyway` and continues. Three sessions were then created and prompted against a server
that never confirmed it was up. This warning fired here and is a plausible precursor to
the death; at minimum it should gate or health-probe before the first prompt.

---

## 4. Why it died (not established)

Not determined. No crash report, no `Stopping server` log, no unhandled rejection.
Contributing suspects, in order:

1. Three concurrent sessions started within 2 s against one shared in-process server
   with 9 MCP servers mounted (2 remote: `web-search-prime`, `web-reader` on `api.z.ai`).
2. The `server.connected` timeout at 13:11:32 suggests startup was already degraded.
3. Unhandled rejection inside the embedded server taking down its listener while the
   host Electron process survived.

Fixing D1/D2 makes the cause much less important — the app would self-heal. Worth adding
a `process.on('unhandledRejection')` breadcrumb near the server bootstrap to capture it.

---

## 5. Recommended fixes

**Fix 1 (required) — wire up the health monitor.** Call `startHealthCheck()` when the
server starts. Natural site: end of `startOnce()` around `:832` where `isStarted = true`
is set, and ensure `stopHealthCheck()` on teardown (already called in `forceStop()`
at `:1791`). The auto-restart body at `:1877-1888` already does the right thing.

**Fix 2 (required) — make `ensureStarted()` verify liveness.** At `:587`, replace the
bare boolean check with a probe before trusting it:

```ts
if (this.isStarted) {
  const { healthy } = await this.checkHealth()      // :1830, uses session.list()
  if (healthy) return
  openCodeLog.warn('[opencode] isStarted was true but server is unreachable — forcing restart')
  await this.forceStop()                            // clears isStarted + stale client
  // fall through to start()
}
await this.start(cwd, startConfig)
```

Note `checkHealth()` already returns `{healthy:false}` when `!client || !isStarted`, so
only probe inside the `isStarted` branch. Cache the probe for a few seconds so a burst of
concurrent `ensureStarted()` calls does not issue N `session.list()` round-trips; the
existing `startInFlight` promise at `:584` is the right place to serialize the restart.

**Fix 3 (strongly recommended) — stop swallowing retry failures.** Make `resendPrompt()`
return `Promise<boolean>` (or reject) so the stall handler can react. On `fetch failed`,
skip the remaining backoff, mark the server unhealthy, and trigger the Fix-2 restart path
instead of waiting another 480 s.

**Fix 4 — fail fast on a dead port.** Before consuming the stall budget, probe the
server. A refused TCP connect to 4096 should abort the turn in ~1 s with a clear
"OpenCode server died" error rather than after 26 minutes of silence.

**Fix 5 — release owners on confirmed death.** `forceStop()` clears `isStarted` but
leaves `serverOwners` populated. Confirm that a post-restart refcount of 3 stale owners
does not suppress a later legitimate `stop()`.

**Fix 6 — regression test.** Add to `__tests__/opencode-server-lifecycle.test.ts`: start
the executor, kill the server out from under it, call `ensureStarted()` with a new owner,
and assert it restarts rather than returning early. The existing
`opencode-kill-stale-server.test.ts` is the closest neighbour.

---

## 6. Operator workaround (current build)

Quit and relaunch Code Atelier. Nothing else clears `isStarted`. Retrying the blueprint,
starting a new run, or switching workspace will all keep failing with `fetch failed`.
Verify recovery with `lsof -nP -iTCP:4096` showing a `LISTEN` once a run starts.

---

## 7. ADDENDUM — second occurrence: reproducible, and the provider is exonerated

The app was fully quit and relaunched (new pid 54487, `START v1.0.105` at 19:33:02Z).
The blueprint was re-run and **failed identically**. This is not a random crash.

### Reproduction (2 for 2)

| | Run 1 (pid 28442) | Run 2 (pid 54487) |
|---|---|---|
| Prompts accepted (204) ×3 | 13:11:44 | 13:33:47 |
| `server.connected not received within 10s` | 13:11:32 | 13:33:39 |
| Last server event | 13:11:55 | 13:33:57 |
| Server dead | yes | yes |
| Stall detected (+480s) | 13:20:05 | 13:42:07 |
| `TypeError: fetch failed` | 13:20:35 | 13:42:37 |

Both runs: 3 concurrent sessions on `glm/glm-5.3`, same worktree, dead within ~90s.

### Exact time of death, from `vitals.log` (UTC)

```
19:34:43.235Z rss=306MB ... ocSessions=3 childProcs=0 bp=build
19:34:58.239Z rss=250MB ... ocSessions=3 childProcs=0 bp=build     <-- -56MB
19:35:13.242Z rss=226MB ... ocSessions=3 childProcs=0 bp=build     <-- -80MB total, then flat
19:35:28.245Z rss=227MB ... ocSessions=3
19:36:58.262Z rss=229MB ... ocSessions=3
```

The server died between **19:34:43Z and 19:35:13Z** — roughly 60-85 seconds after the
prompts, and immediately after R010 logged `5 tool calls, no writes yet` at 19:34:15Z.
So the agent *was* working normally; the server died mid-tool-loop.

Two things this rules out:

- **Not an OOM / resource exhaustion.** `rss` *fell* 80MB and then sat flat at ~227MB.
  `heapUsed` stayed ~65MB, `childProcs=0` throughout. The host Electron process was and
  remains healthy; only the embedded listener died.
- **Not the provider.** See below.

`ocSessions=3` never decrements, for the rest of the process lifetime. This is direct
runtime confirmation of **D2**: the three owners stay held, `isStarted` stays `true`,
and the executor is permanently wedged.

### GLM / z.ai is healthy — provider is NOT the cause

Tested directly against the exact `baseURL` and key from the generated
`opencode.json` (`https://api.z.ai/api/coding/paas/v4`):

```
GET  /models                     -> 401 (auth required), DNS 0.02s, connect 0.03s   # network fine
POST /chat/completions           -> 200 in 1.33s, valid completion                  # key valid
POST /chat/completions (stream)  -> 200, clean SSE through to data: [DONE]          # streaming fine
```

Non-streaming and streaming both work. The earlier hypothesis that z.ai was flaky is
**wrong** — drop it. The crash is app-side, inside the embedded OpenCode server during
the tool-call loop.

### New lead: what to instrument

The death is mid-tool-loop with no log line, no crash report, and no unhandled-rejection
trace. The embedded server's listener dies while the host process survives — the
signature of an uncaught exception or unhandled rejection on the server's own async
path being swallowed. Priority instrumentation:

1. `process.on('unhandledRejection')` and `process.on('uncaughtException')` breadcrumbs
   around the `createOpencode` bootstrap, logged before anything else can swallow them.
2. A `close`/`error` listener on the returned server handle (`this.server`, set in
   `startOnce()`) — right now nothing observes the listener dying.
3. Log every MCP tool call dispatch/return. 9 MCP servers are mounted per session
   (`opencode.json`), 2 of them remote (`web-search-prime`, `web-reader` on `api.z.ai`);
   the crash lands squarely in that window.

Reduced-concurrency runs (1 track instead of 3) would confirm or rule out the
concurrent-session hypothesis cheaply.

### Separate bug found while testing: GLM reasoning models return empty `content`

The log shows repeated `GLM extraction returned empty text` (`MemoryExtraction`,
`DocWatcher`, 13:35:53 and 13:36:01). My direct API test reproduces the cause exactly:

```json
{"choices":[{"finish_reason":"length","message":{
  "content":"",
  "reasoning_content":"The user is asking me to reply with the single word \"ok\". This is"}}],
 "usage":{"completion_tokens":16,"completion_tokens_details":{"reasoning_tokens":16}}}
```

`glm-5.3` is a reasoning model: with a small `max_tokens`, the entire budget is consumed
by `reasoning_tokens` and `content` comes back as `""` with `finish_reason: "length"`.
The caller treats that as "empty text" and fails.

Fix: budget `max_tokens` to account for reasoning tokens, and/or fall back to
`reasoning_content` when `content` is empty. This is independent of the server crash but
is silently degrading memory extraction on every doc.
