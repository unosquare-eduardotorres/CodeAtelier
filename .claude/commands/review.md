Review the current changes for quality, bugs, and convention compliance.

Steps:

1. Run `git diff` to see all unstaged changes, and `git diff --cached` for staged changes
2. For each changed file, check:
   - **Correctness**: Are there logic bugs, off-by-one errors, or missing error handling?
   - **Types**: Are TypeScript types correct and complete? Any `any` that should be typed?
   - **Conventions**: Does it follow the project's CLAUDE.md conventions?
   - **Security**: Any hardcoded secrets, unsafe user input handling, or XSS vectors?
   - **Performance**: Any obvious N+1 queries, unnecessary re-renders, or memory leaks?
3. Summarize findings as:
   - 🔴 **Must fix** — bugs, security issues, broken functionality
   - 🟡 **Should fix** — convention violations, missing types, poor error handling
   - 🟢 **Nice to have** — style improvements, minor refactors
4. If everything looks good, say so briefly

Be specific — reference file names and line numbers. Don't speculate about things you haven't checked.
