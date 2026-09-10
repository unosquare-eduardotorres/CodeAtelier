---
target: full-app visual audit (17 valid screenshots of 18 attempted)
method: direct-CDP capture (scripts/capture-screenshots.mjs) + vision sub-agent (operate.md + critique heuristics)
date: 2026-09-10
related: 2026-09-10-visual__pass1-3-valid-surfaces.md
---
# Visual audit — pass 2 (full app)

Capture: 14 of 15 workspace tabs + chat home + welcome + new-chat form, real demo
data, dark theme, 1400x900. The Design tab's nav button was unreachable in the
driven session (harness quirk, documented) — the only missing surface.

## Verdict
"A disciplined shell wrapped around an undisciplined content layer." Identical
topbar/sidebar/status-bar + H1+subtitle grammar on all 14 tabs (excellent), but
below the header the shared vocabulary dissolves.

## Top findings (P1s first)
- [P1] Repository page renders two contradictory truths in one frame: status bar
  "Main ▸ E2E Badge / ⎇ main" vs main panel "Not a Git repository" + red pill +
  "Initialize Git" CTA — and still offers "Review a Pull Request". (10-repository)
- [P1] Jira's default state is an expanded connection panel whose header control
  is "Hide connection" — dismissal as the landing affordance, burying "Browse
  your board". (10-jira)
- [P2] Primary-CTA roulette: same verb, four costumes — green "+ New Audit",
  teal "+ New Blueprint", amber sentence-case "+ Capture Your First Idea",
  purple "New Council Review". One accent for primary actions app-wide; per-tab
  hues belong on icons/status only.
- [P2] Three lifecycle-pill vocabularies for one job: Jira To Do/In Progress/
  Done, Blueprint Draft/Experimental, Tracks Running/Finished.
- [P2] Nav↔title parity breaks: Audit Code→"Workspace Health", Jira→"Jira
  Tickets", LLM Testing→"E2E Model Testing". Topbar's 2nd icon swaps between
  bar-chart and sliders across tabs with no route logic.
- [P2] Council is the strongest single-tab hue drift (purple CTA + chips +
  border) + five saturated advisor chips. Tracks renders a marketplace/store
  grammar found nowhere else ("Track Library", Install, origin tags).
- [P2] Testing's hero fold is a connection-wait spinner card, not tests.
  Code-intelligence's subtitle is documentation posture ("Learn how to use…").
- [P2] Search placement differs: header row (Memory) vs below-header (Blueprints).

## Empty-state report card
A: Ideas, Health · A-: Council · B: Tracks · C+/C: Blueprints, Jira, Code
Intelligence, Repository · C-: Testing. Ideas + Health are best-in-class
("install the mental model before first use").

## Nielsen (visual only)
Visibility 2/4 · Consistency 2/4 · Recognition 3/4 · Minimalist 3/4 · Error recovery 2/4

## Strengths
Shell discipline (uniform anatomy, instant "where am I"), teaching empty states
(the app's strongest design muscle), disciplined neutral layering with density
in the right places.

## Top 5 fixes
1. Lock primary CTA to one hue + one format app-wide
2. Resolve the Repository same-screen contradiction
3. Collapse Jira connection panel by default ("Connect", not "Hide connection")
4. Enforce nav↔title parity + one topbar icon grammar
5. Unify the lifecycle pill; move Testing's connection card out of the fold
