---
name: ui-ux-pro-max
description: >
  UI/UX design intelligence: 50+ styles, 161 palettes, 57 font pairings, 25 chart
  types across React, Next.js, Vue, Svelte, SwiftUI, Flutter, Tailwind, shadcn/ui.
  Trigger: UI design, color system, accessibility, animation, typography, layout,
  component styling, glassmorphism, dark mode, responsive design, UX review.
---

# UI/UX Pro Max - Design Intelligence

Comprehensive design guide for web and mobile applications. Contains 50+ styles, 161 color palettes, 57 font pairings, 161 product types with reasoning rules, 99 UX guidelines, and 25 chart types across 10 technology stacks. Searchable database with priority-based recommendations.

## When to Apply

This Skill should be used when the task involves **UI structure, visual design decisions, interaction patterns, or user experience quality control**.

### Must Use

- Designing new pages (Landing Page, Dashboard, Admin, SaaS, Mobile App)
- Creating or refactoring UI components (buttons, modals, forms, tables, charts, etc.)
- Choosing color schemes, typography systems, spacing standards, or layout systems
- Reviewing UI code for user experience, accessibility, or visual consistency
- Implementing navigation structures, animations, or responsive behavior

### Skip

- Pure backend logic, API/database design, DevOps, non-visual automation

**Decision criteria**: If the task will change how a feature **looks, feels, moves, or is interacted with**, this Skill should be used.

## Rule Categories by Priority

| Priority | Category            | Impact   | Key Checks (Must Have)                                                |
| -------- | ------------------- | -------- | --------------------------------------------------------------------- |
| 1        | Accessibility       | CRITICAL | Contrast 4.5:1, Alt text, Keyboard nav, Aria-labels                   |
| 2        | Touch & Interaction | CRITICAL | Min size 44x44px, 8px+ spacing, Loading feedback                      |
| 3        | Performance         | HIGH     | WebP/AVIF, Lazy loading, Reserve space (CLS < 0.1)                    |
| 4        | Style Selection     | HIGH     | Match product type, Consistency, SVG icons (no emoji)                 |
| 5        | Layout & Responsive | HIGH     | Mobile-first breakpoints, Viewport meta, No horizontal scroll         |
| 6        | Typography & Color  | MEDIUM   | Base 16px, Line-height 1.5, Semantic color tokens                     |
| 7        | Animation           | MEDIUM   | Duration 150-300ms, Motion conveys meaning, Spatial continuity        |
| 8        | Forms & Feedback    | MEDIUM   | Visible labels, Error near field, Progressive disclosure              |
| 9        | Navigation Patterns | HIGH     | Predictable back, Bottom nav <=5, Deep linking                        |
| 10       | Charts & Data       | LOW      | Legends, Tooltips, Accessible colors                                  |

> **Detailed rules for each category**: See `references/quick-reference.md`

## Workflow

1. **Analyze requirements** — extract product type, audience, style keywords, stack
2. **Generate design system** (REQUIRED):
   ```bash
   python3 skills/ui-ux-pro-max/scripts/search.py "<query>" --design-system [-p "Project Name"]
   ```
3. **Supplement with domain searches** as needed:
   ```bash
   python3 skills/ui-ux-pro-max/scripts/search.py "<keyword>" --domain <domain>
   ```
4. **Stack guidelines**: `--stack react-native` for implementation-specific patterns

> **Full workflow details, search domains, and examples**: See `references/workflow-search.md`

## Pre-Delivery Quick Check

Before delivering UI code, run through CRITICAL + HIGH priority categories (§1-§5) from `references/quick-reference.md`, then verify:

- No emojis as icons, consistent icon family, semantic theme tokens
- Touch targets >=44pt, pressed feedback, gesture regions clear
- Text contrast >=4.5:1 in both light/dark mode
- Safe areas respected, 4/8dp spacing rhythm maintained
- Accessibility labels, reduced motion support

> **Full pre-delivery checklist and common professional UI rules**: See `references/common-rules-checklist.md`
