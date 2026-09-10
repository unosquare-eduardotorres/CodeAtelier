---
target: visual audit (18 screenshots attempted, 3 valid)
method: CDP capture of the live app + vision sub-agent (operate.md + critique heuristics)
date: 2026-09-10
---
# Visual audit — pass 1 (valid surfaces only)

Capture harness: scripts/capture-screenshots.mjs (direct CDP, bypasses the
electron-live fixture — that fixture never yields an app page; separate open issue).

INVALID DATA: 15 of 18 captures rendered one screen (first pass: the new-chat
form; second pass with the sidebar-tab fix: the Ideas page). Tab clicks silently
no-op in the driven session — the swallow-all catch hides whether the element
was missing or covered. FIX NEXT: port SettingsNav.navigateToSettingsTab's
proven logic into the capture script, assert the target surface's testid before
each shot, then re-run the vision audit on all 15.

## Findings on the 3 valid surfaces
- [P1] New-chat form confirms the #1 power-user complaint visually: Title is
  the first REQUIRED field with counter "0/120" above everything the user
  wants to type. (02-new-chat.png)
- [P1] Mode = Build selected while helper text still describes Plan mode —
  helper copy not bound to control state (operate.md state bug).
- [P1] Red "46" bug badge is the loudest element on the home screen with no
  visible destination or explanation. (00-app-home.png)
- [P2] Seven stacked form sections before the single primary action — no
  progressive disclosure; 11px placeholder/counter text below legible floor.
- [P2] Sidebar empty state is prose pointing at a "+" icon elsewhere (~11px
  muted) — needs the shared empty-state component with an inline action.
- [P2] Two card grammars (workspace picker vs tone cards) visually identical
  while doing different jobs (navigate vs set-value).
- STRENGTHS: one-violet-accent palette discipline (squint test lands on the
  primary action every time); the form's micro-copy (examples, "(optional)",
  "uses workspace default if unset") is the app's teaching-voice template;
  workspace card anatomy is the most finished component grammar.

## Nielsen (visual only, 3 surfaces)
Visibility of status 1/4 · Consistency 2/4 · Recognition 2/4 · Minimalist 3/4 · Error recovery 1/4 (absence of evidence)
