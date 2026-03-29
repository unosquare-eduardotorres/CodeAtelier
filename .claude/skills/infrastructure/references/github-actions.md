# GitHub Actions Patterns

## Electron CI/CD Workflow Template

```yaml
name: Build & Release

on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint-and-typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: 'npm'
      - run: npm ci
      - run: npm test

  build:
    needs: [lint-and-typecheck, test]
    strategy:
      fail-fast: true
      matrix:
        include:
          - os: macos-latest
            build-cmd: npm run build:mac
          - os: windows-latest
            build-cmd: npm run build:win
          - os: ubuntu-latest
            build-cmd: npm run build:linux
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: 'npm'
      - run: npm ci
      - name: Build
        run: ${{ matrix.build-cmd }}
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # macOS signing
          CSC_LINK: ${{ secrets.MAC_CERTIFICATE }}
          CSC_KEY_PASSWORD: ${{ secrets.MAC_CERTIFICATE_PASSWORD }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
      - uses: actions/upload-artifact@v4
        with:
          name: dist-${{ matrix.os }}
          path: dist/
          retention-days: 7

  release:
    if: startsWith(github.ref, 'refs/tags/v')
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
      - uses: softprops/action-gh-release@v2
        with:
          files: dist-*/**
          generate_release_notes: true
```

## Caching Best Practices

```yaml
# Cache node_modules
- uses: actions/setup-node@v4
  with:
    cache: 'npm'  # Built-in npm caching

# Cache Electron binaries (saves ~100MB download)
- uses: actions/cache@v4
  with:
    path: ~/.cache/electron
    key: electron-${{ runner.os }}-${{ hashFiles('package-lock.json') }}

# Cache build outputs for incremental builds
- uses: actions/cache@v4
  with:
    path: |
      out/
      .vite/
    key: build-${{ runner.os }}-${{ hashFiles('src/**', 'package-lock.json') }}
```

## Reusable Workflow Pattern

```yaml
# .github/workflows/reusable-build.yml
name: Reusable Build
on:
  workflow_call:
    inputs:
      os:
        required: true
        type: string
    secrets:
      CSC_LINK:
        required: false

jobs:
  build:
    runs-on: ${{ inputs.os }}
    steps:
      - uses: actions/checkout@v4
      # ... build steps
```

## Concurrency & Deduplication

```yaml
# Cancel previous runs for the same PR/branch
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

## Security for Workflows

- Never expose secrets in logs: use `::add-mask::` for dynamic secrets
- Use `permissions:` to limit GITHUB_TOKEN scope
- Pin action versions to SHA, not tags: `actions/checkout@abc123`
- Use GitHub Environments for production deployments (require approval)
- Audit third-party actions before use
