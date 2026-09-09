---
target: blueprint detail view (completion/error surface)
method: focused operate/layout/distill review (single agent, mechanical --scope layout scan clean)
related: 2026-09-09T22-22-35Z__src-renderer.md
date: 2026-09-09
---
# Blueprint Detail View — Focused Review

Verdict: the data volume is legitimate for an Operate surface; the problems are
(1) no hierarchy among ~19 top-level blocks (+~59 phase sub-blocks),
(2) the same facts stated 3–5x (verify verdict x5, duration x4, task counts x4),
(3) two incompatible phase-navigation models over identical content (accordion vs pills, already diverged on code-review),
(4) an 828-line orchestrator that is a pile of inline conditionals, not a layout.

## Re-architecture (summary)

Target tree: DetailHeader / OutcomePanel (6 banners -> 1 verdict banner + 1 primary action + expandable evidence) /
PhaseEvidence (adopt the pill tabs; ONE phase->component router; BuildDeliverable split into evidence + task-actions;
VerifyDeliverable split into verdict + depth) / HandoffCard / TranscriptSection / FileViewerDrawer.

Extract detail/primitives.tsx: Banner (replaces 8 copies), ClampMarkdown (3 -> 1), verdictTone (4 -> 1),
SectionHeading, one severity scale (critical/high/medium/low). Move failed-run derivation into phase-summaries.ts
as getFailureStory(bp, lastError).

Progressive disclosure: completed run default ~6 blocks (one viewport; Verify pre-selected, verdict + modified files only);
failed run ~4 blocks (failed phase pre-selected, banner and evidence complement instead of duplicate); audit-depth
sections (coverage, key links, diagrams, story mapping, narratives) behind <details> groups.

Full report: see session transcript. Key evidence: BlueprintDetailView.tsx:305-760 (block lattice), :511-705 (195-line
failed IIFE), :415-440 + :368-391 (duplicate export button pairs), PhaseJourneyItem.tsx:71-99 vs
BlueprintDeliverablesView.tsx:158-185 (diverged routers), VerifyDeliverable.tsx:312-716 (16 sub-blocks).

---

## Execution record (2026-09-09, later)

Re-architecture landed per proposal:
- detail/primitives.tsx (Banner, ClampMarkdown, verdictTone, SectionHeading)
- getFailureStory() + failedPhaseLabel() in phase-summaries.ts (pure, tested)
- detail/OutcomePanel.tsx — 6 banners → 1 verdict + 1 primary action + collapsible
  evidence; export/follow-up pair now exists exactly once; JiraSyncNote folded in
- detail/PhaseEvidence.tsx — pill tabs + shared deliverables/PhaseDeliverableRouter.tsx
  (code-review phase now renders rich in BOTH views; PhaseJourney/Item deleted)
- BuildDeliverable readOnly (mutations live only in the live execution view)
- VerifyDeliverable sections 3–7 behind one disclosure (opens on non-pass verdicts)
- BlueprintDetailView 829 → ~250 lines; TranscriptSection extracted; page title h2,
  DeliverableHeader demoted to h3; BlueprintFindingsCard severity tokens
Gates: typecheck ✓, eslint 0 new ✓, token lint 708→696 ✓, detector on blueprints/ = 0
findings, unit suite 13,334 pass (2 known standalone-green ordering flakes).
