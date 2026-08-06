# Context Compaction — Verification Guide

This document covers how to verify the two context-management mechanisms and the
context-usage badge, combining the **automated tests** (deterministic) with a
**manual checklist** for live-LLM behaviours the tests can't reach.

## Background — the two paths

| Path  | Provider                | Mechanism                                                                                                                                                                                                                                      |
| ----- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | Local LLM (Ollama/oMLX) | No SDK resume. Per-turn `enrichLocalLLMContext()` rebuilds context via `LocalContextReconstructor.buildContextFromHistory` (budget = 25% of window). Manual `compact()` is unavailable → emits `compactNeeded { level: 'local-unsupported' }`. |
| **B** | Claude (CLI)            | SDK/CLI auto-compact. Window + firing point are controlled via **process env vars** (the `claude` CLI does **not** read `contextWindowSize`/`autoCompactEnabled` from argv).                                                                   |

## Key fix — context-usage badge over-count

The live badge previously summed `input + cache_read + cache_creation` **across
every agentic round-trip in a single message**. Because each round-trip re-reads
the full cached context, a plan turn with ~10 tool calls reported ~42% of a 1M
window after a single message.

The badge now uses `TokenAccountant.contextWindowTokens` — a **snapshot of the
latest round-trip's prompt size** (the true current occupancy), not the per-turn
sum. (`agent-stream-processor.ts` → `processMetaChunk`; `token-accountant.ts`.)

## Key fix — compaction env wiring

`agent-executor-factory.ts` (`resolveClaudeCompactionEnv`) now sets, per Claude spawn:

- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` = effective window. **1M models set `1000000`**
  — otherwise the CLI uses a smaller model-default window (inflates the badge and
  triggers premature auto-compact).
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80` for ≤200K models, so auto-compact fires at
  ~80% of the usable window (~128–152K) instead of the `usable − 13K` default.
  (Honoured by `claude-code` ≥ 2.1.x.)

---

## Part 1 — Automated tests

```bash
npm run test:unit
```

Run 17 covers:

- **`compaction-thresholds.test.ts`** — `resolveCompactionThresholds`,
  `resolveAppliedThresholds`, the `classifyCompaction` band machine (warning /
  suggest debounce / critical / auto-compact-pending), and
  `resolveClaudeCompactionEnv` / `resolveSdkContextWindowSize`.
- **`local-compaction.test.ts`** — `buildContextFromHistory` budget/priority/null,
  `enrichLocalLLMContext` selection order (S12 → S6 → raw), and `compact()`
  emitting `local-unsupported` for local LLMs.
- **`auto-compact-options.test.ts`** — `buildCLIExecuteOptions` emits
  `autoCompactEnabled`, the right `contextWindowSize`, the 1M beta, and the
  `envOverrides` on both the new-spawn and continueSession paths.

---

## Part 2 — Runtime instrumentation (log greps)

Structured logs were added at each decision point. Tail the app log and grep:

| Grep                                        | Where                                    | Confirms                                                                                         |
| ------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `[compaction:config]`                       | `agent-executor-factory`                 | `model`, `supports1M`, `contextWindowSize`, `autoCompactWindow`, `pctOverride` on each new spawn |
| `[compaction:thresholds]`                   | `agent-stream-processor.checkCompaction` | resolved `suggest` / `auto` thresholds + `isAutoCompactEnabled` every turn                       |
| `[compaction:boundary]`                     | `stream-normalizer`                      | the CLI/SDK auto-compact actually fired (`trigger`, `preTokens`)                                 |
| `[S12:context-reconstructed]`               | `agent-session.enrichLocalLLMContext`    | local-LLM reconstruction used (with length)                                                      |
| `[S6:context-injected]` / `[S6:no-context]` | `agent-session.enrichLocalLLMContext`    | summary fallback / raw-message fallback                                                          |

---

## Part 3 — Manual checklist (live LLM)

### B / Claude 200K (Haiku or Opus ≤4.7)

1. Start a chat; send one plan message. Grep `[compaction:config]`:
   - expect `contextWindowSize=160000`, `autoCompactWindow=200000`, `pctOverride=80`.
2. Confirm the badge is a **single-digit / low %** after one message (not ~40%).
3. Grow the context (many file reads). Expect a `[compaction:boundary]` log around
   **~128–152K** tokens; the badge resets afterward.

### B / Claude 1M (Sonnet or Opus 4.8)

1. Send one plan message. Grep `[compaction:config]`:
   - expect `supports1M=true`, `contextWindowSize=1000000`, `autoCompactWindow=1000000`.
2. Confirm the badge shows a **realistic low %** for one message (the previous
   ~42% over-count is gone).
3. Drive context up; auto-compact (`[compaction:boundary]`) should fire only
   well past ~800K.

### A / Local LLM (Ollama/oMLX, small window)

1. Multi-turn chat. From turn 2 onward expect `[S12:context-reconstructed]` each
   turn, with budget ≈ 25% of the window (e.g. 16000 for a 64K window).
2. If no plan state / summary exists, expect `[S6:no-context]` and the raw message.
3. Trigger a manual compact → expect the `local-unsupported` "Start New
   Conversation" modal (no mid-conversation compaction for local LLMs).

---

## Verification commands

```bash
npm run test:unit        # Run 17 + full harness — all green
npm run typecheck:node   # touched files type-clean
npm run lint             # touched files lint-clean
```
