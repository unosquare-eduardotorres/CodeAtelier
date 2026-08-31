# Streaming Remediation — Manual Dev-Run Smoke Checklist

Repeatable verification script for the streaming remediation work (F5/F6/F7/F9/F10, N2/N3, Phase B lane `finalize()`). Automated coverage lives in the unit suite; this checklist covers what only a live run can show.

**When to run:** after any change to `stream-segment-accumulator.ts`, `createStreamingStore.ts`, `blueprint-stream.store.ts`, `blueprint.store.ts` (lane/wave handlers), `StreamingTranscript.tsx`, or `BlueprintChatView.tsx`.

---

## 1. Setup

```bash
npm run dev
```

Create a blueprint whose BUILD phase spans **≥2 waves**. Craft tasks that emit:

- **Fenced code blocks** — ```` ```md ```` samples containing `## ` headings inside the fence (F5: no split may fire mid-fence).
- **JSON-ish tagged blocks** — content that `stripBlueprintBlocks` / grill transforms would strip (F10: no orphaned ``` or JSON tails in chat).
- **1200+ char paragraphs** — exercises the size-cap split trigger (`shouldCommitForSize`) and the segment hard cap.

## 2. Observe during BUILD

| # | Check | Pass criterion |
|---|-------|----------------|
| 1 | Segment splits vs fences | No segment split lands inside a fence (never two broken fences) |
| 2 | Headings inside fences | A `## ` inside a fenced sample does **not** start a new bubble |
| 3 | Tool attachment | Tools stay attached to in-fence text (not detached into the next segment) |
| 4 | F10 transform | No JSON tails or orphaned ``` render in the chat transcript |
| 5 | Lane cards across waves | Completed lane cards collapse and re-expand with **content intact** — regression watch for Phase B `finalize()` |
| 6 | F6/F7 post-completion errors | No duplicate phase-complete transitions after a post-completion error. Verify via logs: `Post-settlement throw ignored` warns **once**, no second `phaseComplete` |
| 7 | N2 identity | After a wave completes and new waves stream, no stale/duplicated segment bubbles (keys must not collide across the committed boundary) |

## 3. Memory (F9 acceptance)

- Open devtools → Memory tab (or Activity Monitor on macOS).
- Take a heap snapshot at wave 1 completion; take another at wave 3+ completion.
- **Pass:** heap is stable across waves — completed lanes hold only their `finalSnapshot` (flat content + tools), not the full `segments` array. A monotonic climb proportional to completed-lane count × segment count indicates `finalize()` is not firing (check that `onBlueprintWaveTaskComplete` → `finalizeLane` runs in the renderer log).

## 4. CI guard (regression check for silent truncation)

Full-suite output **must** contain the sentinel:

```
[run-tests] all N test modules loaded (0 load failure(s))
```

Its absence means the run was silently truncated (a test file called `summaryAsync()`/`process.exit` mid-suite). `npm run test:unit` must end `0 failed`.

---

## Failure triage

- **Lane content blank after completion** → `finalSnapshot` missing: check `finalizeLane` wiring in `blueprint.store.ts` and the `LaneStreamContent` fallback path.
- **Duplicate bubbles after wave transitions** → N2 regression: segment keys must derive from `segment.seq`, never the array index.
- **Broken fences mid-stream** → F5 regression: all three split triggers must check `inCodeFence`.
- **Second `phaseComplete` after an error** → F6/F7 regression: the post-settlement throw guard must swallow exactly once.
