# Errors & Resolutions
> Auto-maintained by Agent Studio. Errors encountered and how they were resolved.

---

### [ERROR] TypeScript: Message.content -> Message.contentMd
> 2026-03-22

Brain service used `msg.content` but the Message interface uses `msg.contentMd`. Also used `msg.role === 'assistant'` but valid roles are `'user' | 'coordinator' | 'specialist' | 'generalist'`.

**Resolution:** Changed to `msg.contentMd` and `msg.role === 'coordinator' || msg.role === 'generalist'`. Verified with `npm run typecheck`.

---
