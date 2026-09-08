### Purpose

Evaluate the design as a design director would, then synthesize a critique.

### Hard Invariants

Never invent product truth. Never soften a real problem to be polite.

### Setup

Run `.claude/skills/impeccable/scripts/impeccable context` before anything else.

### Assessment Orchestration

Delegate Assessment A and Assessment B to separate sub-agents. They must not see
each other's output.

### Assessment A: Design Review

Read relevant source files and visually inspect the live page.

Evaluate:
- **Design specificity**: could an unrelated product use this unchanged?
- **Cognitive load**: consult the Cognitive Load Assessment section below.
- **Nielsen heuristics**: score all 10 heuristics 0-4.

### Assessment B: Detector + Browser Evidence

Run the bundled detector and browser visualization evidence.

CLI scan:

```bash
.claude/skills/impeccable/scripts/impeccable detect --json [target]
```

Then start `impeccable live-server --background` and inject `detect.js` into the page.

### Generate Combined Critique Report

Synthesize both assessments into a single report.

#### Report header provenance

The report's first line MUST declare how the assessments were run.

#### Design Health Score

Present a table of scores.

### Deliver the Report

Present the full structured critique in chat.

### Persist the Snapshot

Write the snapshot to `.impeccable/critique/<date>.md`.

### Ask the User

Ask which issues to address first.

### Recommended Actions

Offer a numbered list of follow-up commands.

## Reference Material

Everything below is reference knowledge, not procedure.

### Cognitive Load Assessment

Cognitive load is the mental effort required to use an interface.

#### Three Types of Cognitive Load

##### Intrinsic Load: The Task Itself

The inherent complexity of what the user is trying to do.

##### Extraneous Load: Bad Design

Effort wasted on deciphering the interface rather than doing the task.

#### Cognitive Load Checklist

- More than four visible options at a single decision point.
- Information the user must carry from one screen to the next.

### Heuristics Scoring Guide

#### Nielsen's 10 Heuristics

##### 1. Visibility of System Status

The system should always keep users informed about what is going on.

##### 2. Match Between System and Real World

Speak the users' language.

#### Issue Severity (P0-P3)

P0 blocks the primary task. P3 is a polish nit.

### Persona-Based Design Testing

#### 1. Impatient Power User: "Alex"

Scans, never reads, expects keyboard shortcuts.

#### 2. Confused First-Timer: "Jordan"

Needs orientation and reassurance.
