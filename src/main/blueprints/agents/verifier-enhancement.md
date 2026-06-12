# Verifier Enhancement — GSD Core Integration

## Adversarial Stance

**Assume the goal is NOT achieved until you have evidence proving it is.**

Do not trust:
- File existence alone (could be stubs)
- Import statements alone (could be unused)
- Test existence alone (could be trivial/passing-by-default)
- Variable declarations alone (could be unused)

Trust only: data flowing through verified wiring.

## 4-Level Artifact Verification (Detailed)

### Level 1 — EXISTS
Simply check the file is present at the expected path:
```bash
[ -f "path/to/file" ] && echo "FOUND" || echo "MISSING"
```

### Level 2 — SUBSTANTIVE
Check if the file contains real implementation:
- Line count > minimum expected (a React component should be > 10 lines)
- No stub patterns:
  - `return null` / `return undefined` as the only return
  - `return {}` / `return []` as the only return
  - `() => {}` or `function() {}` empty bodies
  - `throw new Error('Not implemented')`
  - `// TODO` as the only logic
- No placeholder text:
  - "not implemented", "coming soon", "placeholder"
  - "Lorem ipsum", "Example text"

### Level 3 — WIRED
Check if the artifact is connected to the system:
```bash
# Import check — is it imported by other files?
grep -r "import.*ComponentName" src/ --include="*.ts" --include="*.tsx" | wc -l

# Usage check — is it actually called/rendered (beyond imports)?
grep -r "ComponentName" src/ --include="*.ts" --include="*.tsx" | grep -v "import" | wc -l
```

Interpret results:
- **WIRED**: Imported AND used (both counts > 0)
- **ORPHANED**: Exists but not imported (import count = 0)
- **PARTIAL**: Imported but not used beyond import (usage count = 0)

### Level 4 — DATA FLOWING
Verify real data flows through the wiring:
- Trace the data variable from its source (DB, API, state) to its destination (render, response, storage)
- Flag: static returns with no DB query (fake backend)
- Flag: props declared but hardcoded `{}` at call site (fake frontend)
- Flag: state variable exists but never rendered (dead state)
- Flag: API endpoint exists but returns mock data

## Key Link Verification Patterns

### Component → API
1. Component calls a fetch/API function
2. The function makes an actual HTTP request (not a mock)
3. The request URL matches a real route

### API → Database
1. Route handler calls a service/repository
2. Service/repository executes a real query
3. Query references actual table/collection names

### Form → Handler
1. Form has an onSubmit handler
2. Handler calls a submission function
3. Function processes the form data (not just logs it)

### State → Render
1. State variable is set from real data (API response, user input)
2. State is used in JSX/template rendering
3. Changing the state would change the rendered output

## Stub Detection Patterns

### React Component Stubs
- `return <div />` or `return null`
- `return <p>Coming soon</p>`
- Component with no props that should have them
- useEffect with empty dependency array that should fetch data

### API Route Stubs
- Handler returns hardcoded response
- Handler doesn't call any service
- Missing error handling (bare `res.json()`)

### Wiring Red Flags
- Import exists but imported symbol unused
- Props interface defined but all props optional with no defaults
- Route registered but handler is `(req, res) => res.json({})`

## Human Verification Items

These CANNOT be verified by code analysis — flag them explicitly:
- **Visual**: Does the UI look correct? (layout, styling, responsiveness)
- **Flow**: Does the multi-step user flow work end-to-end?
- **Real-time**: Do WebSocket/streaming features work?
- **External**: Do third-party API integrations work with real credentials?
- **Performance**: Does the app meet response time targets under load?

## Status Determination Decision Tree

```
1. Any MISSING artifacts?
   YES → gaps_found (critical)
   
2. Any STUB artifacts (Level 2 fail)?
   YES → gaps_found (critical)

3. Any ORPHANED artifacts (Level 3 fail)?
   YES → gaps_found (high — code exists but isn't used)

4. Any HOLLOW key links (Level 4 fail)?
   YES → gaps_found (high — wiring exists but no data flows)

5. Critical anti-patterns found?
   YES → gaps_found (medium-high depending on pattern)

6. Human verification items exist?
   YES → human_needed (pass but flag for manual review)

7. All checks pass?
   YES → passed ✓
```
