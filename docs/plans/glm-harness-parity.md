# GLM / OpenCode harness — defect brief

**Status:** findings verified against source + runtime evidence, 2026-09-08.
**Evidence base:** `~/Library/Logs/Code Atelier/main.log` (8.2 MB, through 2026-09-08 08:34,
4 370 `[opencode]` lines, 81 server starts, provider `glm` @ `api.z.ai`),
`main.old.log` (20 MB), and `code-atelier.db` (`blueprint_tasks`).

> **Headline correction.** The originating analysis blamed a 25-turn cap starving GLM of
> tool calls. That is not what is failing. `maxTurns reached` occurs **zero times** in
> 28 MB of logs. The turn cap has never once fired. The real cost centre is the
> **480-second mid-turn stall retry**, which consumed the full 3-retry budget on
> **24 turns** and exhausted outright **15 times** in a single day.

---

## Evidence table

| Signal | Count | Source |
|---|---|---|
| `maxTurns reached (n/m)` | **0** | both logs |
| Turn ended, `transientRetries=0` | 202 | main.log |
| Turn ended, `transientRetries=1` | 10 | main.log |
| Turn ended, `transientRetries=2` | 3 | main.log |
| Turn ended, `transientRetries=3` (budget spent) | **24** | main.log |
| `retries exhausted` | **15** | main.log |
| `Mid-turn stall … (attempt 1/3)` | 32 | main.log |
| `… (attempt 2/3)` | 21 | main.log |
| `… (attempt 3/3)` | 24 | main.log |
| `… (attempt 4/3)` — impossible value | **14** | main.log |
| `No-write nudge` | 60 | main.log |

**239 turns ended; 37 (15.5 %) needed at least one retry; 24 (10 %) burned the entire budget.**

---

## D1 — The mid-turn stall retry is the actual failure mode (and it is expensive)

`provider-timeout-tiers.ts:64-70` puts every cloud provider (GLM included) on `REMOTE_TIER`:

```
noActivityMs: 300_000   midTurnStallMs: 480_000   taskWatchdogMs: 540_000   sdkReadMs: 600_000
```

`opencode-executor.ts:1321-1409` handles the fire: abort the zombie prompt, health-probe,
then re-send the prompt through `handleTransientRetry` against a shared 3-retry budget
(`MAX_TRANSIENT_RETRIES = 3`, `:183`).

Observed cadence in the log — one task, three strikes:

```
17:37:38  Mid-turn stall … (attempt 1/3)
17:46:08  Mid-turn stall … (attempt 2/3)     +8m30s
17:55:08  Mid-turn stall … (attempt 3/3)     +9m00s
```

**A single task that exhausts the budget burns ~26 minutes of wall clock before it fails**,
and the whole prompt is re-sent from scratch each time — no resumption of partial work.
This is the "I see this very often, 1 or 2 retries fixes it" symptom: the retry usually
*does* recover (10 turns recovered at 1 retry, 3 at 2), but each recovery costs 8 minutes,
and 24 turns paid the full price and still failed.

**These are not dead servers.** `opencode-executor.ts:1343-1358` (A4 zombie-recovery) probes
`checkHealth()` with a 3 s race on every stall and tears down immediately if unhealthy,
precisely so a dead server cannot burn the full 3×(stall+backoff) cycle. The log shows the
full cycle being burned repeatedly with ~8 30″ between attempts — so the probe passed each
time and the server was alive. These are genuine slow-provider stalls, not the zombie-server
case already fixed. That distinction is what makes the window itself the defect.

**Why it stalls at all:** the window is only re-armed by prompt-activity events, not by
`server.heartbeat` (PARITY FIX (F), `:1304-1310`) — deliberately, so a genuinely dead
provider stream is caught. GLM's server-side buffering produces long silent gaps
(the tier comment at `:57-63` cites 7-8 min healthy turns, 461 s p95) that sit *right at*
the 480 s threshold. The stall window and GLM's real p95 are too close together: a healthy
slow turn and a dead stream are indistinguishable.

**Suggested direction (needs its own verification run):** the window is the tunable, not the
retry count. Either raise `midTurnStallMs` for GLM specifically above its observed p95 with
margin, or make the window adaptive — reset it on *any* token delta rather than only on
prompt-activity events, while keeping a hard ceiling so dead streams still die.
Note the ordering invariant in `provider-timeout-tiers.ts:15`
(`noActivity < midTurnStall < taskWatchdog ≤ sdkRead`) — raising `midTurnStallMs` above
540 s requires moving `taskWatchdogMs` and `sdkReadMs` too, or the watchdog will fail the
task before the retry can fire (that is GAP-A, already fixed once).

## D2 — `attempt 4/3`: the stall log overruns its own budget

`opencode-executor.ts:1332` formats the attempt counter as:

```ts
`(attempt ${transientRetryCount + 1}/${MAX_TRANSIENT_RETRIES})`
```

This is logged **before** `handleTransientRetry` is consulted about exhaustion
(`:1371-1383`). When the budget is already spent, the line prints `attempt 4/3` for a
retry that never happens — 14 times in one day. Worse, those 14 lines arrive in bursts
milliseconds apart (15:26:51.852, .213, .368, 53.556, 55.470, 56.384), not 8 minutes
apart, so the log implies a retry storm that the code does not actually perform.

Low severity as a runtime bug, **high severity as a diagnostic bug**: this is precisely the
log that gets read when someone investigates the stalls, and it misreports both the attempt
count and the cadence. Fix: log the attempt only on the branch that actually retries, or
clamp the displayed value.

## D3 — Cloud providers resolve their turn budget through the *local-LLM* resolver (latent)

Real, but **not currently firing** — recorded so it is not rediscovered as a live bug.

`agent-session.service.ts:2849-2856` sources `contextWindow` from
`resolveLocalContextWindowAsync()`, whose chain is *user override → local backend API →
known local models → `131_072` fallback* (`agent-executor-factory.ts:94-124`). GLM matches
none of the first three, so it takes the fallback. `resolveContextTier` maps `<= 131_072`
to **`medium`** (`context-management.ts:43`), giving `maxTurnsBuild: 25`.

Goal-conditioned sessions then multiply by `GOAL_CONDITION_MAX_TURNS_MULTIPLIER = 4`
(`context-management.ts:119`, `resolveMaxTurns` `:129-137`), so blueprint BUILD actually
gets **100**, interactive chat **25**, CLI **200** (`SESSION_CONSTANTS.CLI_MAX_TURNS`).
The multiplier was added in response to this exact incident — its comment cites
"blueprint 718c (GLM 5.3, medium tier → maxTurnsBuild 25)".

The app already uses a larger figure for GLM in two other places:
`opencode-config-writer.ts:749` writes `provider.contextLimit ?? DEFAULT_CLOUD_CUSTOM_CONTEXT_LIMIT`
(= `GLM_DEFAULT_CONTEXT_LIMIT`, **200 000**, `constants.ts:1000`) into `opencode.json`, and
`blueprint.service.ts:2068-69` uses `getGlmConfig(workspacePath).contextLimit` for the
artifact-budget tier decision. So we tell the OpenCode server 200 K while telling our own
turn budget 131 K.

Feeding that value in yields `resolveContextTier(200_000)` → `large` → `50 × 4 = 200`,
exact parity with the CLI, inventing no new constant.

⚠️ Caveat: 200 000 is itself an assumption, not a published spec — `constants.ts:997-999`
says so explicitly ("Context is an assumption, not a spec. Treat a value discovered from
`/models` as better"). The fix should prefer the discovered `provider.contextLimit` and fall
back to the constant, exactly as the config writer already does.

**Deliberately not fixed in this pass** — it changes the turn budget of every OpenCode
session and deserves its own verification run. It is latent, not active: the cap has never
fired. Test to pin it when it is done:
`resolveMaxTurns({ contextWindow: 200_000, isBuildMode: true, hasGoalCondition: true }) === CLI_MAX_TURNS`.

## D4 — No `glm` case in `buildProviderOptions`

`opencode-agent-writer-builders.ts:66-81` emits a reasoning/effort directive for
`anthropic` (`thinking.budgetTokens` 16 K/32 K), `openai` (`reasoningEffort`), and
`ollama`/`omlx` (`temperature: 0.6`). There is **no `glm` case**, so GLM agent files get
provider defaults for depth of reasoning on every plan and build.

Confirm what OpenCode actually forwards to a Z.ai `@ai-sdk/openai-compatible` provider
before adding a case — an unrecognised key is likely dropped silently, which would make the
change a no-op rather than a fix.

## D5 — Corrections to the record

So the superseded claims are not re-derived by the next analysis:

- **"GLM is capped at 25 tool calls vs Claude's 200."** Wrong twice over. The goal-condition
  multiplier makes blueprint BUILD **100**, and empirically the cap has **never fired at all**.
- **"Claude has a fallback model, GLM has none."** Overstated. `agent-executor-factory.ts:437-445`
  is model-tiered, not provider-wide: fable→`claude-opus-4-8`, opus→`claude-sonnet-5`,
  **sonnet/haiku→`undefined`**. A Claude Sonnet run has no fallback either.
- **"Task T003 is bricked at the attempt ceiling."** False. All 11 `T003` rows in the DB are
  `status='complete'`, max attempts 6. Nothing to unblock. The only row at or over the
  ceiling is **T011, attempts=15**, in blueprint `7624e83f` ("E2e TEsting Part1") — and that
  blueprint is `cancelled`, so it needs no rescue either. Blueprint `2b08bb6e`, cited by
  `blueprint-stop-loss.ts:31-32` as the 29-attempt incident, **is not in this database**;
  that comment refers to a historical incident, not to current data.

## D6 — Still unverified

- Whether `attempts` needs an in-app reset path at all. `blueprint_tasks.attempts` is
  monotonic by design (`blueprint.service.ts:1975`: *"attempts stays monotonic on purpose"*);
  `resetForRetry` (`blueprint.repository.ts:821`) clears only `gates_json` and `escalated_to`.
  `TASK_DISPATCH_ATTEMPT_CEILING = 12` (`blueprint-stop-loss.ts:37`) therefore blocks dispatch
  permanently with no in-app escape. **One task in the entire DB has ever reached it, in a
  cancelled blueprint** — so this is a latent sharp edge, not an active outage. Do not build
  the guarded reset UI until a live blueprint actually hits it.
- Process-manager MCP mount list for GLM sessions — not inspected.
- GLM-specific stream quirks beyond the stall (tool-call framing, partial JSON) — not inspected.

---

## Recommended order

1. **D2** — trivial, and it fixes the instrument used to measure D1.
2. **D1** — the only change that buys real wall-clock time. Needs a dedicated verification run
   against the ordering invariant.
3. **D4** — cheap, but confirm OpenCode forwards the key first.
4. **D3** — real parity fix, own pass, own verification.
5. **D6** — leave alone until evidence arrives.
