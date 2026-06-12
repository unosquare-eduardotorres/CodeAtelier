# Verification Patterns Reference

## Common Verification Commands

### File Existence
```bash
[ -f "path/to/file" ] && echo "FOUND" || echo "MISSING"
```

### Line Count Check (substantive vs stub)
```bash
wc -l path/to/file
# < 10 lines for a component = likely stub
# < 5 lines for a service = likely stub
```

### Import/Usage Check
```bash
# Who imports this file?
grep -r "import.*ModuleName" src/ --include="*.ts" --include="*.tsx" | wc -l

# Who uses this symbol (beyond imports)?
grep -r "ModuleName" src/ --include="*.ts" --include="*.tsx" | grep -v "import" | wc -l
```

### Stub Pattern Detection
```bash
# Empty returns
grep -n "return null\|return {}\|return \[\]\|return undefined" path/to/file

# TODO/FIXME markers
grep -rn "TODO\|FIXME\|HACK\|XXX\|not implemented" src/ --include="*.ts" --include="*.tsx"

# Empty function bodies
grep -n "=> {}" path/to/file
grep -n "function.*{$" path/to/file
```

### Test Validity Check
```bash
# Tests that always pass (no assertions)
grep -L "assert\|expect\|should\|toBe\|toEqual\|toHave" tests/**/*.test.ts

# Tests with only one assertion (potentially trivial)
grep -c "expect\|assert" tests/**/*.test.ts
```

## Verification Thresholds

| Artifact Type | Min Lines | Must Import | Must Be Imported |
|---------------|-----------|-------------|------------------|
| React Component | 15 | React | Yes (by page/parent) |
| API Route | 10 | Service/Handler | Yes (by router) |
| Service | 20 | Repository/DB | Yes (by route/handler) |
| Repository | 15 | DB client | Yes (by service) |
| Type/Interface | 5 | - | Yes (by implementation) |
| Test File | 10 | Module under test | No |
| Config File | 3 | - | Yes (by app entry) |

## Data Flow Patterns

### Backend Data Flow
```
Client Request → Route → Controller → Service → Repository → Database
                                                              ↓
Client Response ← Route ← Controller ← Service ← Repository ← Query Result
```

### Frontend Data Flow
```
User Action → Event Handler → API Call → State Update → Re-render
                                                          ↓
                                                      DOM Update → User Sees Change
```

### Full Stack Trace
```
User clicks button
  → onClick handler fires
    → fetch('/api/resource')
      → Express route handler
        → service.getResource()
          → repository.findById()
            → SELECT * FROM resources WHERE id = ?
          ← [row data]
        ← resource object
      ← JSON response
    ← parsed JSON
  → setState(data)
→ Component re-renders with data
```
