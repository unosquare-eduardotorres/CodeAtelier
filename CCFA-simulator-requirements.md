# High-Level Requirements — CCFA Exam Simulator

**Document type:** High-Level Requirements (HLR)
**Status:** Draft v1
**Purpose:** Input document for spec-driven development flow

---

## 1. Overview

Build an exam simulator for the Anthropic **Claude Certified Architect – Foundations (CCA-F)** certification. The simulator lets a single user study for the real exam by taking realistic timed practice exams, drilling individual domains, and reviewing their mistakes over time.

## 2. Problem statement

Studying for the CCA-F today means reading docs and hoping. There is no way to rehearse the actual exam experience — timed pressure, scenario-based questions, domain-weighted coverage — or to know which domains are weak until exam day.

## 3. Target user

A single developer studying for the CCA-F exam. No multi-user support, no accounts, no collaboration. The app runs locally on their machine.

## 4. Exam fidelity requirements

The simulated exam must match the real exam's published format:

| Attribute | Value |
|---|---|
| Questions per exam | 60 |
| Time limit | 120 minutes |
| Question type | Scenario-based, multiple choice, single correct answer |
| Passing score | 720 / 1000 (scaled) |

Question distribution per exam must follow the official domain weights:

| Domain | Weight |
|---|---|
| 1. Agentic Architecture and Orchestration | 27% |
| 2. Tool Design and MCP Integration | 18% |
| 3. Claude Code Configuration and Workflows | 20% |
| 4. Prompt Engineering and Structured Output | 20% |
| 5. Context Management and Reliability | 15% |

Questions must be **scenario-based** (a realistic production situation requiring an architectural judgment call), with one correct answer and three plausible distractors — matching the real exam's style. The real exam draws scenarios from recurring archetypes (Customer Support Resolution Agent, Multi-Agent Research System, Developer Productivity Tools, Code Generation / CI/CD, Structured Data Extraction); generated questions should reuse these archetypes.

## 5. Content source material

The question bank is derived from five domain study documents provided by the user (currently at `~/Downloads/CCAF/domain1.md` … `domain5.md`). Each document defines the domain's **task statements** — the exhaustive list of testable concepts — plus known exam traps, anti-patterns, practice scenarios, and the domain's internal question distribution:

| Source doc | Domain | Task statements | Suggested per-domain quiz size |
|---|---|---|---|
| domain1.md | Agentic Architecture & Orchestration (27%) | 7 (1.1–1.7) | 10 questions |
| domain2.md | Tool Design & MCP Integration (18%) | 5 (2.1–2.5) | 7 questions |
| domain3.md | Claude Code Configuration & Workflows (20%) | 6 (3.1–3.6) | 8 questions |
| domain4.md | Prompt Engineering & Structured Output (20%) | 6 (4.1–4.6) | 8 questions |
| domain5.md | Context Management & Reliability (15%) | 6 (5.1–5.6) | 6 questions |

That is 30 task statements total. These documents are the **authoritative content spec**: every question in the bank must map to one task statement, and every task statement must be covered by at least 3 questions. The documented exam traps (e.g., "prompt-based guidance offered as an answer for a high-stakes enforcement scenario — reject it") should drive distractor design.

## 6. Functional requirements

### FR-1: Question bank
- The app ships with a local question bank; each question has: scenario text, 4 answer options, the correct answer, an explanation of why the correct answer wins **and why each distractor is wrong**, a domain tag (1–5), a task-statement tag (e.g., `1.4`), and optionally the scenario archetype and the exam trap it exercises.
- The question bank must be stored in a human-editable format so new questions can be added without code changes.
- Minimum viable bank size: 120 questions (enough for two non-overlapping full exams), with every task statement covered by ≥ 3 questions.

### FR-2: Full exam mode
- Generates a 60-question exam sampled from the bank according to the domain weights above.
- Countdown timer (120 min) always visible; the exam auto-submits when time expires.
- User can navigate between questions, flag questions for review, and see an overview of answered/unanswered/flagged before submitting.
- No feedback (correct/incorrect) is shown during the exam.

### FR-3: Practice mode
- User picks one or more domains — or individual task statements within a domain — and a question count.
- A one-click "domain quiz" preset per domain uses the suggested per-domain quiz size and task-statement distribution from the source documents (e.g., Domain 1: 10 questions weighted across 1.1–1.7 as specified in domain1.md).
- Immediate feedback after each answer: correct/incorrect plus the explanation.
- Untimed.

### FR-4: Scoring and results
- After a full exam: scaled score (out of 1000), pass/fail against 720, and a per-domain breakdown (percent correct per domain).
- Domain quizzes report against the source documents' readiness thresholds (e.g., Domain 1: 8+/10 = ready; Domain 2: 6+/7; Domain 3: 7+/8).
- Results screen highlights the weakest domains **and task statements** and recommends what to drill next.

### FR-5: Review mode
- After any exam or practice session, the user can step through every question they got wrong, seeing their answer, the correct answer, and the explanation.
- Previously missed questions can be re-drilled as a "mistakes only" practice session.

### FR-6: Progress tracking
- Exam and practice history is persisted locally across sessions.
- A simple dashboard shows score trend over time and accuracy trend per domain and per task statement, so the user can tell when they are consistently above passing level and which of the 30 task statements remain weak.

## 7. Non-functional requirements

- **Local-first:** all data (question bank, history) lives on the user's machine. No backend, no accounts, no network dependency at runtime.
- **Fast:** starting an exam or moving between questions must feel instant (< 200 ms perceived).
- **Resilient:** if the app closes mid-exam, the in-progress exam (answers + remaining time) is recoverable on next launch.
- **Readable:** scenario questions are long-form text; typography and layout must be comfortable for sustained reading over a 2-hour session.

## 8. Out of scope (v1)

- Generating new questions with an LLM **at runtime** (a one-time LLM-assisted authoring pass from the source documents is expected — see section 9)
- An interactive AI tutor/chat mode (the source documents are instructor prompts; v1 uses them only as question-bank source material)
- Importing/exporting question banks from third-party sources
- Multi-user support, cloud sync, leaderboards
- Coverage of other Anthropic certifications
- Mobile support

## 9. Question bank authoring (one-time, build-time)

The initial bank is produced by a one-time LLM-assisted authoring pass over the five source documents. Requirements for that pass:

- Every question maps to exactly one task statement; coverage per section 5.
- Practice scenarios already written into the source documents (e.g., domain1.md's "agent terminates prematurely on `response.content[0].type == 'text'`" case) must be converted into bank questions — they are the highest-fidelity items available.
- Distractors must be *plausible* — drawn from the documented anti-patterns and traps, not obviously wrong filler.
- Explanations must include the reasoning style of the source docs: why the right answer wins and why each distractor fails.
- Authored output lands in the human-editable bank format (FR-1) and is reviewed by the user before being marked exam-ready.

## 10. Open questions (for the spec/design phase)

1. Platform: web app, desktop app, or CLI? (No constraint from the user — recommend based on effort vs. the "readable, 2-hour session" requirement.)
2. How should scaled scoring (raw correct → /1000) be modeled, given Anthropic does not publish its scaling formula?
3. Should the five source documents be bundled into the app repo (frozen copies) or referenced from `~/Downloads/CCAF/`? (Recommend bundling frozen copies for reproducibility.)

## 11. Acceptance criteria (v1 done means)

- [ ] A user can complete a full 60-question, 120-minute timed exam whose domain mix matches the official weights within ±1 question per domain.
- [ ] Auto-submit fires at 0:00 and produces a results screen with scaled score, pass/fail, and per-domain breakdown.
- [ ] A user can run a practice session on a single chosen domain or task statement with instant feedback and explanations.
- [ ] Every one of the 30 task statements from the source documents has ≥ 3 questions in the shipped bank, and each question carries a valid task-statement tag.
- [ ] Domain quiz presets exist for all five domains and report readiness against the source documents' thresholds.
- [ ] Every wrong answer from any session is reviewable afterward with its explanation, and can be re-drilled.
- [ ] Closing and reopening the app mid-exam restores the exam exactly where it left off.
- [ ] History persists across app restarts and the dashboard shows at least score-over-time and accuracy-per-domain.

---

## Sources

- Exam format and domain weights: Anthropic CCA-F published exam guide, as summarized by tutorialsdojo.com, claudecertifications.com, and dev.to (verified July 2026).
- Domain content, task statements, exam traps, scenario archetypes, and readiness thresholds: user-provided study documents `~/Downloads/CCAF/domain1.md` – `domain5.md` (authoritative for question-bank content).
