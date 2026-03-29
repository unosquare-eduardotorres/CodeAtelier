# Release Automation Patterns

## Semantic Versioning

Follow [semver.org](https://semver.org):
- **MAJOR** (1.0.0 → 2.0.0): Breaking changes — incompatible API changes
- **MINOR** (1.0.0 → 1.1.0): New features — backward compatible additions
- **PATCH** (1.0.0 → 1.0.1): Bug fixes — backward compatible fixes

### Pre-release Versions
- Alpha: `1.2.0-alpha.1` — internal testing
- Beta: `1.2.0-beta.1` — external beta testers
- RC: `1.2.0-rc.1` — release candidate, final testing

## Conventional Commits

Format: `<type>(<scope>): <description>`

| Type | Triggers | Description |
|------|----------|-------------|
| `feat` | MINOR bump | New feature |
| `fix` | PATCH bump | Bug fix |
| `perf` | PATCH bump | Performance improvement |
| `refactor` | — | Code refactoring (no behavior change) |
| `docs` | — | Documentation only |
| `style` | — | Formatting, no code change |
| `test` | — | Adding/updating tests |
| `chore` | — | Build, CI, tooling changes |
| `BREAKING CHANGE` | MAJOR bump | Footer or `!` after type |

### Examples
```
feat(grill): add domain-specific track selection
fix(ipc): validate sender in grill evaluation handler
feat(radar)!: replace single score with multi-track radar chart
```

## Changelog Generation

### Auto-generated from Conventional Commits
```
## [1.5.0] - 2026-03-28

### Features
- **grill**: Add domain-specific track selection (#142)
- **radar**: Multi-track radar chart visualization (#143)

### Bug Fixes
- **ipc**: Validate sender in grill evaluation handler (#141)

### Breaking Changes
- **radar**: Replace single ScoreGauge with GrillRadarChart for multi-track view
```

### Tools
- `conventional-changelog-cli` — Generate changelogs from git history
- `standard-version` — Bump version + generate changelog + git tag
- `semantic-release` — Fully automated (analyze commits → bump → changelog → publish)

## Electron Release Channels

### Channel Strategy
```
main branch → beta channel → auto-update to beta users
release tag → stable channel → auto-update to all users
```

### electron-updater Configuration
```yaml
# electron-builder.yml
publish:
  - provider: github
    owner: your-org
    repo: agent-studio
    releaseType: release  # or 'prerelease' for beta
```

### Update Flow
1. CI builds and signs the app
2. CI uploads to GitHub Release (draft)
3. Maintainer reviews and publishes release
4. `electron-updater` checks for updates on app launch
5. Downloads update in background
6. Prompts user to restart (or auto-restart)

## Version Bump Script

```bash
#!/bin/bash
# bump-version.sh — used in CI
BUMP_TYPE=${1:-patch}  # major | minor | patch

# Update package.json version
npm version $BUMP_TYPE --no-git-tag-version

# Read new version
VERSION=$(node -p "require('./package.json').version")

# Generate changelog
npx conventional-changelog -p angular -i CHANGELOG.md -s

# Commit and tag
git add package.json CHANGELOG.md
git commit -m "chore(release): v$VERSION"
git tag "v$VERSION"
git push origin main --tags
```

## Release Checklist

- [ ] All CI checks pass on main
- [ ] Version bumped via conventional commits
- [ ] Changelog reviewed and accurate
- [ ] Code signing certificates valid (not expired)
- [ ] Notarization successful (macOS)
- [ ] Installers tested on all target platforms
- [ ] Auto-update tested (beta → stable promotion)
- [ ] Release notes written for end users
- [ ] Previous version available for rollback
