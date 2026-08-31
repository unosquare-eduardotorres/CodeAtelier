# GLM (Z.ai) — Verification Guide

This document consolidates the GLM provider knowledge that is otherwise scattered
across `constants.ts`, `glm-credits.ts`, `model-config.service.ts` and the GLM
test files — combining **automated tests** with a **manual checklist** for
live-Z.ai behaviours the tests can't reach. It mirrors the structure of
`compaction-verification.md`.

## Background — what GLM is here

GLM (Z.ai) is the third `LLMProvider` (`'claude' | 'local-llm' | 'glm'`), routed
through the **OpenCode executor** as an OpenAI-compatible provider. It is billed
in **Coding Plan credits, not USD** — `estimateCostCents` returns 0 for `glm-*`
models and `getWorkspaceCostSummary` returns null for GLM workspaces, so USD
totals are suppressed everywhere.

## Endpoint modes

| Mode         | Base URL                                  | Protocol                    | API key                                                                         |
| ------------ | ----------------------------------------- | --------------------------- | ------------------------------------------------------------------------------- |
| `zai-coding` | `https://api.z.ai/api/coding/paas/v4`     | OpenAI-compatible (default) | Required                                                                        |
| `zai-coding` | `https://api.z.ai/api/anthropic`          | Anthropic-compatible        | Required                                                                        |
| `proxy`      | any local URL (e.g. `http://127.0.0.1:…`) | OpenAI-compatible           | **Optional** — a local proxy commonly injects the `Authorization` header itself |

The three Z.ai protocol URLs live in `GLM_ENDPOINTS` (`src/shared/constants.ts`).
Two rules that bite:

- **Verbatim URLs.** The OpenCode config writer uses the stored base URL exactly
  as given — it never appends `/v1` or any other suffix. A hand-typed
  `…/paas/v4/` with a trailing slash is sent as-is and will 404.
- **Coding Plan ≠ pay-as-you-go.** A Coding Plan key against
  `https://api.z.ai/api/paas/v4` (the URL in Z.ai's public quick-start guide)
  returns **401** — the single most common misconfiguration. `payAsYouGo` is
  listed in `GLM_ENDPOINTS` only so the UI can detect and warn about it.

## Credit model

`credits = (input×in + cachedInput×cached + output×out) / 10_000`, per model
(`GLM_CREDIT_RATES`):

| Model           | input | cachedInput | output |
| --------------- | ----- | ----------- | ------ |
| `glm-5.3`       | 6.9   | 1.7         | 24     |
| `glm-5.3-flash` | 2.3   | 0.56        | 8      |

- **Source of truth for these numbers:** Z.ai Coding Plan pricing —
  <https://docs.z.ai/guides/overview/pricing> (cross-check the plan tiers at
  <https://z.ai/subscribe>). Re-verify both pages when Z.ai revises the plan.
- **Cached vs fresh input:** cached input is ~4× cheaper than fresh, and output
  costs ~3.5× input — so **prompt-prefix stability (cache hit rate) is the
  dominant cost lever**, not message length.
- **Off-peak:** requests outside **Mon–Fri 14:00–18:00 UTC+8** bill at half
  rate (`GLM_OFF_PEAK_MULTIPLIER = 0.5`). The quota meter shows an
  "off-peak (half rate)" badge when active.
- **MCP:** GLM-hosted MCP tool calls charge `GLM_MCP_CREDITS_PER_CALL = 1.2`
  credits per call, independent of tokens.
- **Unknown-model conservatism:** any `glm-*` id (`isGlmModelId` prefix match)
  is kept out of USD costing. An id missing from `GLM_CREDIT_RATES` is never
  priced as Sonnet-by-default — credits estimation treats it conservatively
  rather than silently converting to dollars.
- **Quota windows** (`GLM_PLAN_LIMITS.max`): 28,000 credits / 5 hours,
  140,000 / week. Same source URLs as above.

## Housekeeping on Flash — why

`GLM_SMALL_MODEL_ID = 'glm-5.3-flash'` is the default housekeeping/summarisation
model. Flash bills output at **8 credits per 10K tokens vs GLM-5.3's 24** (3×
cheaper) and input at 2.3 vs 6.9 (3× cheaper). Housekeeping work
(titles, phase summaries, compaction) is high-volume and low-stakes — exactly
the profile where the output multiplier dominates. Reserve GLM-5.3 for turns
the user reads.

## `/goal` — advisory, not enforced

The app builds `/goal <text>` slash commands (`buildGoalCommand`) and forwards
them into the prompt stream for **every** provider, GLM included — there is no
provider-native goal primitive to call. Semantics are **advisory**: the goal
text steers the model's attention for the turn, but neither Z.ai nor the app
enforces it (no platform-level constraint, no completion gate). Verification is
therefore prompt-level only — the unit tests assert the command is built and
forwarded (`executor-deep-phase19.test.ts`); there is no live behaviour to
smoke-test beyond "the goal text appears in the assembled prompt".

## Dev / packaged keychain split ⚠

`glmApiKey` is encrypted with Electron `safeStorage`, which keys material by
**app name**. The dev build and the packaged app have different app names, so a
key saved by `npm run dev` **cannot be decrypted by the packaged app** (and vice
versa) — it looks like a corrupt key, not a keychain mismatch. To share the
packaged identity in dev, run with `DEV_USE_PACKAGED_IDENTITY=1`
(`src/main/app-identity.ts`). `getGlmConfig()` logs a warning naming this cause
when `glmApiKeyEncrypted` is set but decryption yields an empty key — if you see
it, re-enter the key in the build you are running.

---

## Part 1 — Automated tests

```bash
npm run test:unit
```

Covers (among the GLM group):

- **`glm-provider.test.ts`** — quota math (`percentOf5h` / `percentOfWeek` /
  `offPeak`), credit estimation, endpoint defaults.
- **`glm-explicit-provider.test.ts`** — the `providerOverride` path: explicit
  GLM selection on Grill/Council/Audit reaches the generated `opencode.json`
  instead of falling through to the workspace default (Anthropic), and GLM
  workspaces report no dollars in cost summaries.
- **`shadow-routing-settings.test.ts` / `workspace.repository.test.ts`** —
  `glm*` settings keys inherit correctly from parent workspaces into worktree
  shadow rows, and `glmApiKey` round-trips through encryption
  (`encrypt-settings-keys.ts`).

## Part 2 — Live runbook

### Automated live check

```bash
GLM_API_KEY=... npm run verify:glm
```

`scripts/live-glm-verify.ts` reproduces the v1.0.86 stale-`session.idle` race
against the **real** Z.ai API with the real OpenCode executor and opencode CLI
server — no mocks. Exit 0 = the stream completed with text and token counts;
exit 1 = failure details printed. Optional env: `GLM_VERIFY_CWD` to point at a
real workspace directory.

### Manual smoke checklist

1. **Test Connection** — Settings → model config → GLM card: enter a Coding Plan
   key, endpoint `zai-coding`, click Test Connection. Expect: success, and the
   model list populated from `GET {baseUrl}/models` (the hardcoded
   `GLM_MODELS` list is a fallback only).
2. **Quota meter** — same card, Credits section: the 5-hour bar renders
   `percentOf5h`, the caption shows both 5h and weekly numbers, and the
   "off-peak (half rate)" badge appears outside Mon–Fri 14:00–18:00 UTC+8.
   Numbers should move after a live turn.
3. **One Grill run on GLM** — select GLM as the provider for a Grill session on
   a Claude-configured workspace. Expect: the run executes against GLM (no
   Anthropic usage), and the session log shows `provider=glm`. This exercises
   the `providerOverride` path end-to-end.
4. **Keychain split (if keys mysteriously fail)** — run the packaged app after
   saving a key in dev. Expect: the `[glm] glmApiKeyEncrypted is set but
decryption returned an empty key` warning in the main-process log. Fix:
   re-enter the key in the packaged app, or run dev with
   `DEV_USE_PACKAGED_IDENTITY=1`.

## Out of scope (filed separately)

- GLM-hosted Vision / Web-Search / Web-Reader MCP servers (Coding-Plan
  exclusives) — separate feature.
- GLM e2e shim for offline Playwright runs — separate feature.
