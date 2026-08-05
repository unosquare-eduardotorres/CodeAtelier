/**
 * Shared configuration for the Feed Brain / Deep Scan ingestion pipeline.
 *
 * Extracted from memory-bootstrap.service.ts so the planner, the worker and
 * the phase executors can share one source of truth.
 */

import type { BootstrapPhaseLabel } from '../../../shared/types'

/** Directories to skip during discovery */
export const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', 'coverage',
  '.next', '.nuxt', '.cache', '__pycache__', '.tox', '.venv',
  'vendor', 'target', 'bin', 'obj', '.gradle', '.idea',
  '.vscode', '.vs'
])

/** Max files to read per phase for safety */
export const MAX_ARCHITECTURE_FILES = 40
export const MAX_CHUNKS_PER_FILE = 25
export const MAX_HOTSPOT_FACTS = 15
export const MAX_COCHANGE_RESULTS = 15
export const MAX_COMMIT_SUBJECTS = 50

/** Discovery caps for scattered documentation in deep legacy trees */
export const MAX_SCATTERED_DOCS = 500
export const MAX_SCATTERED_DOC_DEPTH = 4

/**
 * Files shorter than this carry no extractable prose — a stub README or an
 * index page of links. Filtering them at plan time is free and keeps the
 * item total honest.
 */
export const MIN_DOC_CHARS = 400

/** Doc patterns for the Docs phase */
export const DOC_PATTERNS = [
  'README.md', 'README.txt', 'README.rst', 'README',
  'CLAUDE.md', 'AGENTS.md',
  'ARCHITECTURE.md', 'ARCHITECTURE.txt',
  'CONTRIBUTING.md', 'CONTRIBUTING.txt',
  'CHANGELOG.md', 'CHANGELOG.txt',
  'SECURITY.md', 'LICENSE.md'
]

/** Globs for doc directories */
export const DOC_DIRS = [
  'docs', 'doc', 'documentation', '.github',
  // Common documentation locations beyond the basics
  'wiki', 'guides', 'specs', 'design',
  'api-docs', 'api', 'reference',
  'architecture', 'decisions', 'adr',
  'manuals', 'handbooks', 'howto',
  'notes', 'knowledge-base'
]

/** Manifest files for the Stack phase */
export const MANIFEST_FILES = [
  'package.json', 'tsconfig.json', 'tsconfig.base.json',
  'requirements.txt', 'pyproject.toml', 'setup.py', 'setup.cfg',
  'go.mod', 'go.sum',
  'Cargo.toml',
  'Gemfile',
  'pom.xml', 'build.gradle', 'build.gradle.kts',
  'electron-builder.yml', 'electron-builder.json5',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  '.github/workflows/*.yml', '.github/workflows/*.yaml',
  'Makefile', 'justfile'
]

/**
 * Documents that are legally or mechanically generated — they burn LLM calls
 * and produce no memories worth keeping.
 */
export const SKIP_DOC_NAMES = [
  /^license(\.|$)/i,
  /^licence(\.|$)/i,
  /^code[-_]of[-_]conduct/i,
  /^third[-_]party/i,
  /^notice(\.|$)/i,
  /\.min\.(md|txt)$/i
]

// ── Phase definitions ────────────────────────────────────────────────────────

export const FULL_PHASES: BootstrapPhaseLabel[] = [
  'preflight', 'docs', 'stack', 'architecture', 'history', 'structure', 'finalize'
]

export const DEEP_SCAN_PHASES: BootstrapPhaseLabel[] = [
  'preflight', 'docs', 'stack', 'architecture', 'history', 'agent-exploration', 'finalize'
]

/**
 * Drain order. `claimNextItem` sorts by priority ascending, so these bases
 * both order the phases and leave room for within-phase ranking (e.g. README
 * before a scattered note). Cheap, high-signal work runs first so that
 * pausing after one minute still leaves the user better off.
 */
export const PHASE_BASE_PRIORITY: Record<string, number> = {
  stack: 0,
  docs: 1000,
  architecture: 2000,
  history: 3000,
  structure: 4000,
  'agent-exploration': 5000
}

/** Within-phase rank for documents. Lower drains first. */
export const DOC_PRIORITY_INSTRUCTION = 5 // agent rule files: written for an agent, highest signal
export const DOC_PRIORITY_TOP = 10       // README / ARCHITECTURE / CLAUDE.md / ADRs
export const DOC_PRIORITY_DOCS_DIR = 50  // anything under a recognised docs dir
export const DOC_PRIORITY_SCATTERED = 100

/**
 * Rule files earn a far lower size floor than prose docs. A ten-line
 * `.cursor/rules/api.mdc` stating one convention is exactly the kind of fact
 * worth keeping, whereas a ten-line README is a stub.
 */
export const MIN_INSTRUCTION_CHARS = 80

/** Filenames whose content is worth reading before anything else. */
export const HIGH_VALUE_DOC_RE =
  /^(readme|architecture|claude|agents|contributing|adr[-_]?\d*|\d+[-_].*)\.(md|mdx|txt|rst|adoc)$|^readme$/i

/** Default number of documents extracted in parallel during a drain. */
export const DEFAULT_BOOTSTRAP_CONCURRENCY = 3
export const MIN_BOOTSTRAP_CONCURRENCY = 1
export const MAX_BOOTSTRAP_CONCURRENCY = 6
