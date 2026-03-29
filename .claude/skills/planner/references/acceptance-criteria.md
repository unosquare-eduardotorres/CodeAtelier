# Acceptance Criteria Patterns

## Given/When/Then (Gherkin) Format

```gherkin
Given [precondition/context]
When [action/trigger]
Then [expected outcome]
```

### Examples

```gherkin
Feature: Grill Track Selection

Scenario: User selects a grill track
  Given the user has an idea with title and description
  And the grill session is in the "selecting" phase
  When the user clicks the "Security" track card
  Then the grill evaluator focuses exclusively on security aspects
  And the score reflects only security completeness
  And 5 security-focused questions are presented

Scenario: Track score persistence
  Given the user has completed 3 iterations on the "Requirements" track
  When the user navigates away and returns to the grill
  Then the previous track score is displayed on the Requirements card
  And the radar chart shows the Requirements axis with the saved score

Scenario: AI suggests next track
  Given the user has completed the "Architecture" track with score 72
  When the evaluation response includes a suggestedNextTrack
  Then the suggested track card shows an orange highlight
  And a tooltip displays the AI's reason for the suggestion
```

## Boundary Analysis Checklist

For every feature, consider these boundaries:

### Input Boundaries
- [ ] Empty/null input
- [ ] Minimum valid input
- [ ] Maximum valid input (length, size, count)
- [ ] Just above maximum (overflow)
- [ ] Special characters (unicode, emoji, HTML, SQL injection attempts)
- [ ] Whitespace-only input

### State Boundaries
- [ ] First use (no prior data)
- [ ] Single item
- [ ] Many items (pagination threshold)
- [ ] Maximum capacity
- [ ] Concurrent modifications
- [ ] Stale data (cache invalidation)

### Time Boundaries
- [ ] Immediate action
- [ ] Timeout threshold
- [ ] Retry after failure
- [ ] Rate limit exceeded
- [ ] Session expiration during operation

### Error Boundaries
- [ ] Network disconnection mid-operation
- [ ] Service unavailable (database, API, Claude CLI)
- [ ] Partial failure (some items succeed, others fail)
- [ ] Corrupted data recovery
- [ ] Permission denied mid-flow

## Definition of Done Template

A feature is "Done" when:
- [ ] All acceptance criteria pass
- [ ] Unit tests cover critical paths
- [ ] E2E test for happy path exists
- [ ] Error states have UI feedback
- [ ] Loading states are implemented
- [ ] Accessibility: keyboard navigable, screen reader labels
- [ ] No TypeScript errors (`npm run typecheck`)
- [ ] No lint warnings (`npm run lint`)
- [ ] Code reviewed by at least one team member
- [ ] Documentation updated if API/interface changed
