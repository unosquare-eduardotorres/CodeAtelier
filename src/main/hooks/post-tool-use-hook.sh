#!/usr/bin/env bash
# post-tool-use-hook.sh — Claude CLI post-tool-use hook
#
# Called after every tool invocation completes.
# Receives JSON on stdin: { tool_name, tool_input, tool_output, tool_error }
# Must output JSON: { "decision": "proceed"|"inject", "message": "..." }
#
# Implements:
#   1. Quality gate detection (test/lint/build pass/fail)
#   2. Persistence / anti-abandonment (detects give-up language)
#   3. Error pattern detection and corrective guidance

set -euo pipefail

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || echo "")
TOOL_OUTPUT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_output','')[:5000])" 2>/dev/null || echo "")
TOOL_ERROR=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_error','')[:2000])" 2>/dev/null || echo "")

# ── Quality Gate Detection ──
# Detect test/lint/build results from Bash tool output
if [ "$TOOL_NAME" = "Bash" ]; then
  # Test failures — inject corrective guidance
  if echo "$TOOL_OUTPUT" | grep -qiE '(FAIL|failed|failing)\s+(test|spec|suite)|\d+\s+failing|\d+\s+failed'; then
    if ! echo "$TOOL_OUTPUT" | grep -qi 'all.*pass'; then
      echo "{\"decision\": \"inject\", \"message\": \"[QUALITY GATE] Tests are failing. You MUST fix the failing tests before proceeding. Do not skip or ignore test failures. Review the error output above carefully and fix the root cause.\"}"
      exit 0
    fi
  fi

  # TypeScript compilation errors
  if echo "$TOOL_OUTPUT" | grep -qE 'error TS[0-9]+:|Found [0-9]+ error'; then
    echo "{\"decision\": \"inject\", \"message\": \"[QUALITY GATE] TypeScript compilation errors detected. Fix all type errors before proceeding. Do not use @ts-ignore or type assertions to hide errors.\"}"
    exit 0
  fi

  # ESLint errors (not warnings)
  if echo "$TOOL_OUTPUT" | grep -qE '[0-9]+ error|✖ [0-9]+ problem.*[0-9]+ error'; then
    if ! echo "$TOOL_OUTPUT" | grep -q '0 error'; then
      echo "{\"decision\": \"inject\", \"message\": \"[QUALITY GATE] Lint errors detected. Fix lint errors before proceeding. Do not disable lint rules to bypass errors.\"}"
      exit 0
    fi
  fi

  # Build failures
  if echo "$TOOL_OUTPUT" | grep -qiE 'build failed|build error|compilation failed|error during build'; then
    echo "{\"decision\": \"inject\", \"message\": \"[QUALITY GATE] Build failed. Investigate and fix the build error before continuing with other changes.\"}"
    exit 0
  fi
fi

# ── ESLint MCP Tool Detection ──
# Detect eslint_check tool results with errors
if [ "$TOOL_NAME" = "mcp__code-analysis__eslint_check" ]; then
  if echo "$TOOL_OUTPUT" | grep -qE '"errorCount"\s*:\s*[1-9]|\*\*[1-9][0-9]*\*\* errors'; then
    echo "{\"decision\": \"inject\", \"message\": \"[QUALITY GATE] ESLint errors found. Run eslint_fix on the affected files, then re-run eslint_check to confirm zero errors before proceeding.\"}"
    exit 0
  fi
fi

# ── Persistence / Anti-abandonment Detection ──
# Check tool output for abandonment language (applies to any tool that produces text)
COMBINED_OUTPUT="$TOOL_OUTPUT $TOOL_ERROR"

ABANDONMENT_DETECTED=false

# Check for give-up phrases in tool output
if echo "$COMBINED_OUTPUT" | grep -qiE \
  'I cannot complete this|I am unable to|this is beyond my|I give up|I.m stuck|you should try|you.ll need to manually|I cannot figure out|this requires manual|I recommend you do this yourself|unfortunately.{0,20}(cannot|unable|impossible)|not possible for me to'; then
  ABANDONMENT_DETECTED=true
fi

if [ "$ABANDONMENT_DETECTED" = true ]; then
  echo "{\"decision\": \"inject\", \"message\": \"[PERSISTENCE] Do NOT give up or defer to the user. You are a capable specialist. Try a different approach: 1) Re-read the error messages carefully, 2) Search for similar patterns in the codebase, 3) Try a simpler implementation first, 4) Break the problem into smaller steps. You MUST attempt at least 3 different approaches before concluding something is impossible.\"}"
  exit 0
fi

# ── Default: Proceed normally ──
echo "{\"decision\": \"proceed\"}"
