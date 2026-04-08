# Planner Skill — Requirements Analysis & Planning

## Purpose

Full-lifecycle requirements analysis and planning. Transforms vague ideas into structured, actionable specifications with clear acceptance criteria, edge case coverage, and execution plans.

## Core Competencies

### Requirements Analysis

- **User Story Writing**: Follow INVEST criteria (Independent, Negotiable, Valuable, Estimable, Small, Testable)
- **Acceptance Criteria**: Use Given/When/Then (Gherkin) format for testable criteria
- **Edge Case Identification**: Systematically explore boundaries, error states, concurrent operations, empty/null states
- **Stakeholder Mapping**: Identify all affected user roles, systems, and downstream consumers
- **Scope Definition**: Explicit in-scope/out-of-scope boundaries with rationale

### Planning Patterns

- **Work Breakdown Structure**: Decompose features into implementable tasks (max 4h each)
- **Dependency Analysis**: Map task dependencies, identify critical path, flag blockers
- **Effort Estimation**: T-shirt sizing (S/M/L/XL) with calibration against historical tasks
- **Risk Assessment**: Identify technical risks, unknowns, and mitigation strategies
- **Phased Delivery**: Split large features into incrementally deliverable phases

### Quality Gates

- Every user story has at least 3 acceptance criteria
- Every feature has error/failure scenarios documented
- Every requirement has a "Definition of Done" checklist
- Edge cases are explicitly listed (not left to implementation)
- Non-functional requirements (performance, security, accessibility) are addressed

## Evaluation Criteria (for Grill Sessions)

When evaluating requirements completeness, score based on:

1. **User Stories (20%)**: Are all user roles identified? Are stories in proper format? Do they express value?
2. **Acceptance Criteria (25%)**: Are criteria testable? Do they cover happy path AND error paths? Given/When/Then format?
3. **Edge Cases (20%)**: Are boundary conditions identified? Concurrent operations? Empty/null states? Rate limits?
4. **Scope Clarity (15%)**: Are boundaries explicit? Are assumptions documented? Are out-of-scope items listed?
5. **Stakeholder Needs (20%)**: Are all affected parties identified? Are conflicting needs resolved? Are priorities clear?

## Anti-Patterns to Flag

- "The system should handle errors gracefully" (vague — specify which errors and how)
- Missing non-functional requirements (performance targets, accessibility level, browser support)
- Implicit assumptions not documented
- No error/failure scenarios described
- Missing data flow or state transition descriptions
