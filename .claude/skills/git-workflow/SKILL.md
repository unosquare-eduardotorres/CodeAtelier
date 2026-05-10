---
name: git-workflow
description: >
  Git branching strategies, conventional commits, PR workflows, conflict resolution,
  and GitHub Actions patterns for Electron app projects. Use when working with Git
  operations, branching, PRs, merge conflicts, or CI/CD pipeline configuration.
user-invocable: false
---

# Git Workflow Patterns

> **Version**: 1.0
> **Last updated**: 2026-03-21

## Before you start

1. Check current branch: `git branch --show-current`
2. Check remote: `git remote -v`
3. Check for uncommitted changes: `git status`
4. Check recent history: `git log --oneline -10`

## Branching strategy

Use trunk-based development with short-lived feature branches:

```
main (protected, always deployable)
├── feature/add-agent-panel       ← feature work
├── fix/ipc-timeout-error         ← bug fixes
├── chore/update-electron-39      ← maintenance
└── release/v1.2.0                ← release prep (optional)
```

### Branch naming

```
<type>/<short-description>

Types:
  feature/  — new functionality
  fix/      — bug fix
  chore/    — maintenance, deps, config
  refactor/ — code restructure, no behavior change
  docs/     — documentation only
  release/  — release preparation
```

### Rules

- `main` is always protected — no direct pushes
- Feature branches live < 3 days (prefer < 1 day)
- Rebase feature branches on `main` before PR (keep history linear)
- Delete branches after merge

## Conventional commits

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

| Type       | When                                                |
| ---------- | --------------------------------------------------- |
| `feat`     | New feature visible to users                        |
| `fix`      | Bug fix                                             |
| `refactor` | Code change that doesn't fix a bug or add a feature |
| `chore`    | Build, deps, config, tooling                        |
| `docs`     | Documentation only                                  |
| `style`    | Formatting, whitespace (no code change)             |
| `test`     | Adding or fixing tests                              |
| `perf`     | Performance improvement                             |
| `ci`       | CI/CD configuration                                 |

### Scopes (project-specific)

| Scope         | Area                         |
| ------------- | ---------------------------- |
| `main`        | Main process code            |
| `renderer`    | React frontend               |
| `preload`     | Preload bridge               |
| `ipc`         | IPC handlers/channels        |
| `db`          | Database schema/repositories |
| `agents`      | Agent system                 |
| `coordinator` | Orchestrator service         |
| `build`       | Electron-builder, packaging  |

### Examples

```
feat(agents): add specialist skill assignment UI
fix(ipc): handle timeout in coordinator start channel
refactor(db): extract workspace queries to repository
chore(build): upgrade electron to v39.2.6
docs(readme): add development setup instructions
```

### Breaking changes

Use `!` suffix or `BREAKING CHANGE:` footer:

```
feat(ipc)!: rename chat channels to use colon separator

BREAKING CHANGE: IPC channels now use 'chat:send' format instead of 'chat-send'.
Update all ipcRenderer.invoke calls.
```

## Pull request workflow

### PR template

```markdown
## What

Brief description of the change.

## Why

Motivation — link to issue if applicable.

## How

Implementation approach and key decisions.

## Testing

- [ ] Unit tests pass: `npm test`
- [ ] Type check passes: `npm run typecheck`
- [ ] Lint passes: `npm run lint`
- [ ] Manual testing: describe what you tested
```

### PR checklist

Before creating a PR:

1. Rebase on latest `main`: `git fetch origin && git rebase origin/main`
2. Run full check: `npm run typecheck && npm run lint && npm test`
3. Review your own diff: `git diff origin/main...HEAD`
4. Keep PRs focused — one concern per PR
5. Add screenshots for UI changes

### Merge strategy

- **Squash merge** for feature branches (clean history on main)
- **Merge commit** for release branches (preserve release history)
- **Rebase** for single-commit fixes (linear history)

## Conflict resolution

### Common conflict patterns in Electron apps

| File                | Typical conflict                     | Resolution                                           |
| ------------------- | ------------------------------------ | ---------------------------------------------------- |
| `constants.ts`      | Two branches add new IPC channels    | Keep both, maintain alphabetical order               |
| `schema.sql`        | Two branches add tables              | Keep both, check FK dependencies                     |
| `package.json`      | Different dependency versions        | Take higher version, re-run `npm install`            |
| `package-lock.json` | Always conflicts on parallel changes | Accept either side, then `npm install` to regenerate |
| Component files     | Structural changes                   | Manual merge, test thoroughly                        |

### Resolution steps

```bash
# 1. Update main
git fetch origin

# 2. Rebase your branch
git rebase origin/main

# 3. If conflicts, resolve each file
git status                    # see conflicting files
# Edit files, remove conflict markers
git add <resolved-files>
git rebase --continue

# 4. If rebase gets messy, abort and try merge instead
git rebase --abort
git merge origin/main
```

### Lock file conflicts

Never manually resolve `package-lock.json`:

```bash
# Accept either version, then regenerate
git checkout --theirs package-lock.json
npm install
git add package-lock.json
```

## GitHub Actions for Electron

### Basic CI workflow

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test

  build:
    needs: lint-and-test
    strategy:
      matrix:
        os: [macos-latest, windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
```

## Git hooks

### Pre-commit (via simple-git-hooks or husky)

```json
// package.json
{
  "simple-git-hooks": {
    "pre-commit": "npx lint-staged",
    "commit-msg": "npx commitlint --edit $1"
  },
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
    "*.{json,md,yml}": ["prettier --write"]
  }
}
```

### Commitlint config

```javascript
// commitlint.config.js
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      ['main', 'renderer', 'preload', 'ipc', 'db', 'agents', 'coordinator', 'build', 'deps']
    ]
  }
}
```

## Common pitfalls

| Pitfall                            | Fix                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| Force pushing to shared branches   | Never `git push --force` on `main`; use `--force-with-lease` on feature branches |
| Manually editing package-lock.json | Accept one side, run `npm install` to regenerate                                 |
| Large PRs (500+ lines)             | Break into smaller, focused PRs                                                  |
| Committing `.env` or secrets       | Add to `.gitignore` before first commit; use `git-secrets`                       |
| Amending published commits         | Only amend local, unpushed commits                                               |
| Not rebasing before PR             | Always `git rebase origin/main` before opening PR                                |
| Committing `node_modules`          | Ensure `node_modules/` is in `.gitignore`                                        |
| Forgetting to stage specific files | Use `git add <file>` not `git add -A`                                            |
