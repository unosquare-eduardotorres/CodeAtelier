Run a technical design audit across five dimensions.

## Diagnostic Scan

### 1. Accessibility (A11y)

Check WCAG contrast ratios, focus states, semantic markup, keyboard paths, and labels.

### 2. Performance

Check render cost, image weight, animation expense, and bundle impact.

### 3. Theming

Check token usage, hardcoded values, and dark/light parity.

### 4. Responsive Design

Check breakpoints, overflow, touch targets, and small-viewport behaviour.

### 5. Implementation Integrity (CRITICAL)

Check for dead styles, unreachable states, and stubbed or faked UI.

## Generate Report

Write the report to `.impeccable/audit/<date>.md`.

### Audit Health Score

Score each dimension 0-4 and present them in a table.

### Implementation Integrity Verdict

State whether the UI is real or partially faked.

### Detailed Findings by Severity

Group findings under P0/P1/P2/P3 headings.

## Recommended Actions

Offer the user a numbered list of follow-up commands to run.
