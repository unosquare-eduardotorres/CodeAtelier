# Errors & Resolutions

> Auto-maintained by Agent Studio. Errors encountered and how they were resolved.

---

### [ERROR] Pre-existing typecheck warnings after prompt optimization

> 2026-03-30

After applying Wave 4 performance optimizations (S1-S6), typecheck revealed a pre-existing unused variable warning:
`src/main/services/specialist-pool.service.ts(46,7): error TS6133: 'SPECIALIST_TIMEOUT_MS' is declared but its value is never read.`

**Resolution:** Not caused by our changes — pre-existing. The constant was likely used by the old CLI spawn timeout logic and became dead code after SDK migration. Safe to remove in a future cleanup pass.

---

### [ERROR] GENERALIST_BASE_PROMPT compression — team edit failed silently

> 2026-03-30

During Wave 4 implementation, the Generalist-Prompt-Compression team reported task #109 as "completed" but the file remained unchanged. The Edit tool likely failed due to escaped backtick characters in the template literal confusing the string matching.

**Resolution:** Applied the GENERALIST_BASE_PROMPT compression manually after verifying the team's output was not persisted. Verified with `npm run typecheck` — 0 new errors.

---

### [ERROR] TypeScript: Message.content -> Message.contentMd

> 2026-03-22

Brain service used `msg.content` but the Message interface uses `msg.contentMd`. Also used `msg.role === 'assistant'` but valid roles are `'user' | 'coordinator' | 'specialist' | 'generalist'`.

**Resolution:** Changed to `msg.contentMd` and `msg.role === 'coordinator' || msg.role === 'generalist'`. Verified with `npm run typecheck`.

---
