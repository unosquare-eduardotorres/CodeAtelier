Review all staged and unstaged changes, then create a well-structured commit.

Steps:

1. Run `git status` and `git diff` to understand what changed
2. Run `git log --oneline -5` to match the repository's commit message style
3. Stage relevant files (avoid secrets, large binaries, .env files)
4. Write a concise commit message:
   - First line: imperative mood, under 72 chars (e.g., "Add user authentication middleware")
   - Body (if needed): explain WHY, not WHAT
   - Use conventional commit prefixes when the project uses them (feat:, fix:, refactor:, docs:, chore:)
5. Create the commit

Do NOT push — only commit locally.
