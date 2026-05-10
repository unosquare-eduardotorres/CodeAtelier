# Infrastructure Skill — CI/CD & Deployment Patterns

## Purpose

CI/CD pipeline design, deployment automation, monitoring, and release management for desktop and cloud applications. Specializes in GitHub Actions, Electron packaging, and cross-platform distribution.

## Core Competencies

### CI/CD Pipeline Design

- **Pipeline Stages**: lint → typecheck → test → build → package → sign → publish
- **Parallel Execution**: Run lint, typecheck, and test in parallel; build after all pass
- **Caching Strategy**: Cache `node_modules` (npm/pnpm), Electron binaries, build artifacts
- **Build Matrix**: Cross-platform builds (Windows, macOS, Linux) in parallel
- **Fail Fast**: Cancel remaining jobs on first failure
- **Branch Protection**: Require CI pass + review before merge to main

### GitHub Actions Patterns

- **Reusable Workflows**: Extract common patterns into `.github/workflows/reusable-*.yml`
- **Composite Actions**: Share steps across workflows via `.github/actions/*/action.yml`
- **Environment Secrets**: Use GitHub Environments for production secrets (code signing certs)
- **Concurrency Groups**: Prevent duplicate runs on same branch
- **Artifact Upload**: Share build outputs between jobs
- **Matrix Strategy**: `{ os: [ubuntu-latest, macos-latest, windows-latest] }`

### Electron Packaging & Distribution

- **electron-builder**: Cross-platform packaging (DMG, NSIS, AppImage, Snap)
- **Code Signing**: macOS (Developer ID), Windows (Authenticode), auto-sign in CI
- **Notarization**: macOS notarization via `notarytool` (required for Gatekeeper)
- **Auto-Update**: `electron-updater` with GitHub Releases or custom update server
- **ASAR**: Pack app resources, enable integrity validation
- **Universal Builds**: macOS universal binary (x64 + arm64)

### Deployment Strategies

- **Staged Rollout**: Release to beta channel → staging → production
- **Canary Releases**: Small percentage of users get new version first
- **Feature Flags**: Enable/disable features without redeployment
- **Rollback Plan**: Keep previous version artifacts, one-click rollback
- **Blue-Green (for cloud services)**: Zero-downtime deployment with traffic switching

### Monitoring & Observability

- **Crash Reporting**: Electron `crashReporter`, Sentry/Bugsnag integration
- **Analytics**: Opt-in usage telemetry (respect privacy)
- **Health Checks**: Auto-update server availability, API endpoint monitoring
- **Log Aggregation**: electron-log file rotation, optional cloud forwarding
- **Performance Metrics**: App startup time, memory usage, IPC latency

### Release Automation

- **Semantic Versioning**: Major.Minor.Patch with conventional commits
- **Changelog Generation**: Auto-generate from commit messages (conventional-changelog)
- **GitHub Releases**: Auto-create with release notes, attach binaries
- **Version Bumping**: Automated via CI (semantic-release or custom scripts)
- **Release Branches**: `release/v1.x` for maintenance, `main` for latest

## Evaluation Criteria (for Grill Sessions)

When evaluating infrastructure readiness, score based on:

1. **CI/CD Pipeline (25%)**: Are all stages defined? Is caching optimized? Is the pipeline fast and reliable?
2. **Packaging Strategy (20%)**: Are all target platforms covered? Is code signing configured? Are artifacts validated?
3. **Deployment Plan (20%)**: Is there a staged rollout? Is rollback supported? Are feature flags planned?
4. **Monitoring (20%)**: Is crash reporting configured? Are health checks defined? Is logging structured?
5. **Release Automation (15%)**: Is versioning automated? Are changelogs generated? Are releases scripted?

## Anti-Patterns to Flag

- Manual release process (should be fully automated)
- No caching in CI (slow builds waste developer time)
- Missing code signing (users get scary warnings)
- No rollback strategy (stuck with broken releases)
- Secrets hardcoded in workflow files (use GitHub Secrets/Environments)
- No build matrix (only testing on one OS)
- Missing health checks for deployed services
