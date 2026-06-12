# Deviation Rules Reference

## Overview

During BUILD phase execution, the agent will inevitably discover work not
in the original plan. These rules govern automatic decision-making to keep
execution flowing without unnecessary user interruption.

## The Four Rules

### RULE 1: Auto-Fix Bugs

**Trigger**: Code doesn't work as intended
**Examples**:
- Wrong SQL query (SELECT from wrong table)
- Logic error (off-by-one, wrong comparison operator)
- Type error (passing string where number expected)
- Null pointer (accessing property of undefined)
- Missing await on async function

**Action**: Fix inline. Add test if the fix is non-obvious.
**Track**: Log as deviation with files affected.

### RULE 2: Auto-Add Missing Critical Functionality

**Trigger**: Missing standard correctness requirements
**Examples**:
- No error handling on async operations
- No input validation on user-facing endpoints
- No authentication check on protected routes
- No CSRF protection on state-changing endpoints
- No CORS configuration for API
- Missing database transaction on multi-step operations

**Action**: Add the missing functionality. These aren't "features" —
they're baseline correctness requirements.
**Track**: Log as deviation.

### RULE 3: Auto-Fix Blocking Issues

**Trigger**: Something prevents completing the current task
**Examples**:
- Wrong TypeScript types (interface mismatch)
- Broken imports (module not found)
- Missing environment variables
- Build configuration errors
- Missing dependency declarations

**Action**: Fix the minimum needed to unblock.
**Track**: Log as deviation.

### RULE 4: Ask About Architectural Changes

**Trigger**: Change would alter the project's structure significantly
**Examples**:
- Creating new database tables (columns are OK)
- Switching libraries (e.g., Express → Fastify)
- Changing authentication approach
- Breaking API changes (changing response shape)
- Adding new external service dependencies
- Changing data serialization format

**Action**: STOP execution. Report the situation and options.
Wait for user decision before proceeding.

## Priority Order

```
Rule 4 (ask) > Rules 1-3 (auto-fix) > Unsure → Rule 4
```

When in doubt whether something is Rule 1-3 or Rule 4,
treat it as Rule 4 and ask.

## Scope Boundaries

**IN SCOPE** for auto-fix:
- Issues DIRECTLY caused by current task's changes
- Issues in files the current task modifies
- Build errors that prevent verification

**OUT OF SCOPE** for auto-fix:
- Pre-existing issues in untouched files
- Performance optimizations not in the task
- Code style improvements not in the task
- Refactoring opportunities

For out-of-scope issues: log them in the deviation report and continue.

## Excluded: Package Manager Failures

If `npm install`, `pip install`, `cargo add`, etc. fails:
- Do NOT substitute a similarly-named alternative package
- Do NOT try to work around with a different library
- Report the failure and stop

Package choices are architectural decisions (Rule 4).

## Deviation Report Format

```json
{
  "rule": 1,
  "type": "bug_fix",
  "description": "Fixed null check in user.service.ts — userId could be undefined when called from batch endpoint",
  "files": ["src/services/user.service.ts"],
  "testAdded": true,
  "severity": "medium"
}
```
