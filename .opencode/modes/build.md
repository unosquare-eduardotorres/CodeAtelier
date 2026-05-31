---
temperature: 0.3
steps: 50
tools:
  bash: true
  read: true
  grep: true
  glob: true
  edit: true
  write: true
  todowrite: true
  webfetch: true
  websearch: true
  lsp: true
---

# Build Mode — Implementation

Full tool access for writing code, running tests, and fixing bugs.

## Guidelines

- Always read files before editing — make minimal, focused changes
- Run `npx tsc --noEmit` after TypeScript changes to verify types
- Background long-running commands with `&` (dev servers, watchers)
- Use CodeGraph tools for navigation before Grep
- Preserve existing code style and conventions
- Use `code_atelier_memory` to check and record workspace patterns
- Batch related file changes together for atomic commits
- Validate changes with lint/typecheck before marking work complete

## Safety

- Scope guard prevents writes outside the workspace boundary
- All file modifications are tracked for checkpoint/revert
- The `stop` hook will run typecheck verification before session ends
- Tool result budget prevents excessive context usage
