#!/usr/bin/env bash
# pre-tool-use-hook.sh — Claude CLI pre-tool-use hook
#
# Called before every tool invocation in build mode.
# Receives JSON on stdin: { tool_name, tool_input }
# Must output JSON: { "decision": "allow"|"block", "reason": "..." }
#
# Implements:
#   1. Dangerous command blocking (rm -rf /, force push main, sudo, etc.)
#   2. Scope validation (optional — checks AGENT_SCOPE env var)

set -euo pipefail

# Read the full JSON payload from stdin
INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || echo "")
TOOL_INPUT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('tool_input',{})))" 2>/dev/null || echo "{}")

# ── Dangerous Command Patterns ──
# Only check Bash tool invocations for dangerous commands
if [ "$TOOL_NAME" = "Bash" ]; then
  COMMAND=$(echo "$TOOL_INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('command',''))" 2>/dev/null || echo "")

  # Pattern list: destructive or dangerous shell commands
  DANGEROUS_PATTERNS=(
    'rm -rf /'
    'rm -rf /*'
    'rm -rf ~'
    'rm -rf $HOME'
    'git push --force main'
    'git push --force master'
    'git push --force origin main'
    'git push --force origin master'
    'git push -f origin main'
    'git push -f origin master'
    'sudo '
    'mkfs.'
    'dd if='
    ':(){:|:&};:'
    'chmod -R 777 /'
    'chmod -R 777 /*'
    'DROP DATABASE'
    'DROP TABLE'
    'TRUNCATE TABLE'
    '| bash'
    '| sh'
    'curl.*| bash'
    'curl.*| sh'
    'wget.*| bash'
    'wget.*| sh'
    'eval "$(curl'
    'eval "$(wget'
    '> /dev/sda'
    'npm publish'
    'npx publish'
  )

  for pattern in "${DANGEROUS_PATTERNS[@]}"; do
    if echo "$COMMAND" | grep -qi "$pattern"; then
      echo "{\"decision\": \"block\", \"reason\": \"Blocked dangerous command pattern: $pattern. This command could cause irreversible damage. If you need to perform this action, ask the user for explicit confirmation.\"}"
      exit 0
    fi
  done

  # Block piped downloads (curl|bash, wget|sh patterns)
  if echo "$COMMAND" | grep -qEi '(curl|wget)\s+.*\|\s*(ba)?sh'; then
    echo "{\"decision\": \"block\", \"reason\": \"Blocked piped download-and-execute pattern. Downloading and executing remote scripts is not permitted.\"}"
    exit 0
  fi
fi

# ── Scope Validation (optional) ──
# If AGENT_SCOPE is set (comma-separated list of allowed path prefixes),
# validate Write/Edit tool file paths against it
if [ -n "${AGENT_SCOPE:-}" ]; then
  if [ "$TOOL_NAME" = "Write" ] || [ "$TOOL_NAME" = "Edit" ]; then
    FILE_PATH=$(echo "$TOOL_INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('file_path',''))" 2>/dev/null || echo "")

    if [ -n "$FILE_PATH" ]; then
      ALLOWED=false
      IFS=',' read -ra SCOPE_DIRS <<< "$AGENT_SCOPE"
      for scope_dir in "${SCOPE_DIRS[@]}"; do
        scope_dir=$(echo "$scope_dir" | xargs) # trim whitespace
        if [[ "$FILE_PATH" == "$scope_dir"* ]]; then
          ALLOWED=true
          break
        fi
      done

      if [ "$ALLOWED" = false ]; then
        echo "{\"decision\": \"block\", \"reason\": \"File '$FILE_PATH' is outside the allowed scope for this task. Allowed paths: $AGENT_SCOPE\"}"
        exit 0
      fi
    fi
  fi
fi

# ── Default: Allow ──
echo "{\"decision\": \"allow\"}"
