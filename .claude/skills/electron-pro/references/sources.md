# Skill Sources and Refresh Guide

This skill was generated on **2026-03-21** from the following sources. When refreshing this skill, re-crawl each source and diff against the current content to find new patterns, breaking changes, deprecations, or security recommendations.

## Primary sources

| Source | URL | What to extract |
|--------|-----|-----------------|
| Electron official docs — Introduction | https://www.electronjs.org/docs/latest/ | New getting-started patterns, tooling changes |
| Electron official docs — Process Model | https://www.electronjs.org/docs/latest/tutorial/process-model | Process architecture changes, new process types |
| Electron official docs — Context Isolation | https://www.electronjs.org/docs/latest/tutorial/context-isolation | contextBridge API updates, migration patterns |
| Electron official docs — IPC | https://www.electronjs.org/docs/latest/tutorial/ipc | New IPC patterns, deprecated patterns |
| Electron official docs — Security Checklist | https://www.electronjs.org/docs/latest/tutorial/security | New security recommendations (items 1-20+) |
| Electron official docs — Performance | https://www.electronjs.org/docs/latest/tutorial/performance | New optimization techniques, profiling tools |
| Electron official docs — ESM | https://www.electronjs.org/docs/latest/tutorial/esm | ESM support changes, new caveats |
| Electron official docs — Fuses | https://www.electronjs.org/docs/latest/tutorial/fuses | New fuses, changed defaults |
| Electron official docs — Distribution (Forge) | https://www.electronjs.org/docs/latest/tutorial/forge-overview | Forge workflow updates, new makers/publishers |
| Electron official docs — Breaking Changes | https://www.electronjs.org/docs/latest/breaking-changes | **Critical** — new deprecations, removed APIs, default changes |
| Electron official docs — ASAR Integrity | https://www.electronjs.org/docs/latest/tutorial/asar-integrity | Integrity verification updates |
| Electron GitHub repo | https://github.com/electron/electron | New releases, CLAUDE.md conventions, repo structure changes |
| Electron Releases page | https://releases.electronjs.org | Latest stable version, Chromium/Node.js versions shipped |
| Electron Forge docs | https://www.electronforge.io/ | Forge config changes, new plugins |
| electron-builder docs | https://www.electron.build/ | Builder config changes, new targets |

## Secondary sources (check when relevant)

| Source | URL | What to extract |
|--------|-----|-----------------|
| Electron GitHub Issues (label:bug) | https://github.com/electron/electron/issues?q=label%3Abug | Common new bugs, workarounds |
| Electron blog | https://www.electronjs.org/blog | Major announcements, migration guides |
| Playwright Electron docs | https://playwright.dev/docs/api/class-electron | E2E testing API changes |
| electron-updater changelog | https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/CHANGELOG.md | Auto-update behavior changes |

## Refresh process

When updating this skill:

1. **Check the current Electron stable version** at https://releases.electronjs.org — update the "Electron version covered" range in the header.
2. **Read the Breaking Changes page first** — this is the highest-signal source. Any new deprecation or default change should be reflected in the skill immediately.
3. **Re-crawl all primary sources** — look for new sections, changed code examples, new APIs, or removed content.
4. **Check the GitHub repo** for structural changes (new docs pages, updated CLAUDE.md, new API modules).
5. **Update code examples** if any API signatures changed or if better patterns emerged.
6. **Add new pitfalls** if the GitHub issues show recurring new bugs.
7. **Bump the skill version** and **update the date** in the header.
8. **Set the next review date** to 3 months out or to the next expected Electron major release, whichever comes first.

## Version history

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-21 | Initial rewrite from VoltAgent original. Added procedural code patterns, security defaults, IPC patterns, packaging configs, pitfalls, debugging, testing. |
| 2.0 | 2026-03-21 | Added from official docs: IPC sender validation, permission handlers, shell.openExternal safety, navigation restrictions, 4 IPC patterns, Electron Forge config, TypeScript bridge typing, deferred module loading, anti-patterns. Added from GitHub repo: ESM support and caveats, version strategy and breaking changes awareness, ASAR integrity, clipboard migration (v40 deprecation), utilityProcess for CPU work, API location reference table, Electron Fuses. |
