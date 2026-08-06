/**
 * Single source of truth for path exclusion logic shared by BOTH indexers:
 * the code graph (code-graph.service.ts) and the embedding preprocessing
 * pipeline (preprocessing/file-validation.ts).
 *
 * Pure utility — no db/repository imports — so it can be unit tested without
 * triggering the heavy import chain (which requires Vite ?raw transforms).
 */

import path from 'node:path'

/**
 * A Set wrapper whose has() check is case-insensitive.
 *
 * Required for Windows compatibility: NTFS/ReFS are case-insensitive,
 * so a directory named "Packages" must match the exclusion "packages".
 * macOS HFS+ is also case-insensitive by default.
 */
export class CaseInsensitiveSet {
  private readonly lower: Set<string>
  constructor(values: Iterable<string>) {
    this.lower = new Set([...values].map((v) => v.toLowerCase()))
  }
  has(value: string): boolean {
    return this.lower.has(value.toLowerCase())
  }
  [Symbol.iterator](): IterableIterator<string> {
    return this.lower[Symbol.iterator]()
  }
}

/**
 * Directories repomap-mcp prunes internally — mirrored so our walker matches.
 * Uses CaseInsensitiveSet so "Build", "Dist", "Vendor" etc. are excluded on
 * case-insensitive filesystems (Windows NTFS, macOS HFS+).
 *
 * Lives here (not in code-graph.service.ts) so the exclusion preflight can
 * consume it without pulling in the db/repository import chain.
 */
export const REPOMAP_EXCLUDED_DIRS = new CaseInsensitiveSet([
  'node_modules',
  '__pycache__',
  'venv',
  'env',
  '.venv',
  '.env',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'target',
  'vendor',
  '.bundle',
  'coverage',
  '.nyc_output',
  '.tox',
  'egg-info'
])

/**
 * Additional directories to exclude from indexing.
 * Supplements repomap-mcp's EXCLUDED_DIRS with platform-specific build
 * artifacts and vendored dependency trees that aren't reliably in .gitignore.
 *
 * Primarily benefits .NET and C++ repos where bin/obj/packages/Tools dirs
 * contain thousands of compiled or vendored files. Vendored copies are
 * especially damaging because buildEdgesFromTags() emits defs x refs per
 * symbol name — N duplicate copies of a library multiply every common symbol
 * by N, which is how a workspace reached 5.5M edges.
 *
 * Deliberately NOT included: generic names like `lib`, `libs`, `docs`, `src`,
 * `test` — those are commonly first-party and excluding them would hide real
 * code. They live in TIER2_CANDIDATE_DIRS instead and are surfaced by the
 * exclusion preflight for explicit confirmation, which writes the decision to
 * .atelierignore.
 *
 * Case-insensitive: "Packages", "PACKAGES", "packages" all match.
 */
export const ADDITIONAL_EXCLUDED_DIRS = new CaseInsensitiveSet([
  // .NET — NuGet often creates "Packages" (capital P) on disk;
  // the CaseInsensitiveSet ensures all casing variants match.
  'bin',
  'obj',
  'packages',
  '.vs',
  'TestResults',
  'artifacts',
  'publish',
  // C++ / CMake
  'Debug',
  'Release',
  'x64',
  'x86',
  'ARM',
  'ARM64',
  'out',
  // IDE
  '.idea',
  // CI / deploy
  'BuildSystem',
  'Deploy',
  // Vendored third-party trees (NUnit, NuGet caches, bundled tooling)
  'Tools',
  'ThirdParty',
  'third_party',
  'thirdparty',
  'Externals',
  'externals',
  'NuGet',
  '.nuget',
  'Setup',
  // iOS / macOS — CocoaPods vendors full C++/ObjC source trees (boost,
  // ReactNativeDependencies). `Pods/` is `pod install` output: never
  // hand-edited, so it is wrong to index regardless of VCS policy.
  'Pods',
  'Carthage',
  'DerivedData',
  'xcuserdata',
  // Android / JVM
  'captures',
  'gen',
  'Intermediates',
  // Unreal Engine — UBT-generated headers and compiled output
  'Binaries',
  'Intermediate',
  'DerivedDataCache',
  'Saved',
  // Unity — asset/session caches. `Library` is deliberately NOT here:
  // it is a generic name and just as often first-party (see Tier 2).
  'Temp',
  'Logs',
  'Builds',
  'MemoryCaptures',
  // C / C++ / CMake — FetchContent, vcpkg and conan vendor entire upstreams
  'CMakeFiles',
  'cmake-build-debug',
  'cmake-build-release',
  '_deps',
  'vcpkg_installed',
  'conan',
  // Python — installed dependency trees
  'site-packages',
  'eggs',
  'wheels',
  '.eggs',
  // Web (legacy package roots)
  'bower_components',
  'jspm_packages',
  'web_modules',
  // Go (pre-modules vendoring)
  'Godeps',
  // Generated documentation / static output — thousands of files, ~0 tags
  '_site',
  'storybook-static'
])

/**
 * Directory names that are OFTEN vendored dependency trees but just as often
 * first-party code. These are deliberately NOT in ADDITIONAL_EXCLUDED_DIRS —
 * excluding `lib/` or `Library/` by default would silently hide real source.
 *
 * Instead they are surfaced by the exclusion preflight
 * (index-exclusion-preflight.service.ts), which gathers evidence (git status,
 * vendor markers, file mix) and asks the user to confirm.
 */
export const TIER2_CANDIDATE_DIRS = new CaseInsensitiveSet([
  'lib',
  'libs',
  'library',
  'external',
  'deps',
  'dependencies',
  'third-party',
  'plugins',
  'modules',
  'frameworks',
  'common',
  'shared'
])

/** True when a directory name is a Tier-2 confirm-before-excluding candidate. */
export function isTier2CandidateDirName(name: string): boolean {
  return TIER2_CANDIDATE_DIRS.has(name)
}

/**
 * Convert an absolute path to a workspace-relative POSIX path.
 *
 * REQUIRED for Windows correctness. The previous implementation used
 * `abs.replace(workspacePath + '/', '')`, which never matches native Windows
 * backslash paths — so tags and PageRank nodes were silently keyed by ABSOLUTE
 * paths, breaking edge resolution and duplicating nodes across re-index runs.
 */
export function toPosixRel(absPath: string, workspacePath: string): string {
  const rel = path.relative(workspacePath, absPath)
  return rel.split(path.sep).join('/')
}

/**
 * Returns true if the file path contains a directory segment that should
 * be excluded from indexing. Uses path separators to avoid false positives
 * (e.g. a file named "binary-utils.ts" should NOT be excluded by "bin").
 * Handles both forward and backslash separators for Windows compatibility
 * (fs.watch and path.relative use native separators on Windows).
 */
export function isExcludedPath(relPath: string): boolean {
  const segments = relPath.split(/[/\\]/)
  // Check all directory segments (not the filename)
  for (let i = 0; i < segments.length - 1; i++) {
    if (ADDITIONAL_EXCLUDED_DIRS.has(segments[i])) return true
  }
  return false
}

/**
 * Returns true if a single directory NAME should never be descended into.
 * Used by the pruning walker so excluded trees are never traversed at all,
 * rather than walked and then filtered out afterwards.
 */
export function isExcludedDirName(name: string): boolean {
  return ADDITIONAL_EXCLUDED_DIRS.has(name)
}

/**
 * Directory exclusions expressed as globs, for consumers that match on
 * glob patterns rather than path segments (the preprocessing pipeline).
 * Derived from ADDITIONAL_EXCLUDED_DIRS so the two can never drift.
 */
export function excludedDirGlobs(): string[] {
  return [...ADDITIONAL_EXCLUDED_DIRS].map((dir) => `**/${dir}/**`)
}

/**
 * Check if a file path matches any of the skip patterns using simple glob
 * matching. Patterns use ** for any path segment(s) and * for any non-/ chars.
 *
 * Moved here from preprocessing/file-validation.ts so both indexers and the
 * .atelierignore loader share one matcher implementation.
 */
export function matchesSkipPattern(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  for (const pattern of patterns) {
    // Convert glob to regex using placeholder to avoid double-replacement
    const regexStr = pattern
      .replace(/\*\*/g, '\0GLOBSTAR\0') // placeholder for **
      .replace(/\*/g, '[^/]*') // * → non-slash chars
      .replace(/\./g, '\\.') // escape dots
      .replace(/\0GLOBSTAR\0\//g, '(?:.+/)?') // **/ → optional prefix ending in /
      .replace(/\/\0GLOBSTAR\0/g, '(?:/.+)?') // /** → optional suffix starting with /
      .replace(/\0GLOBSTAR\0/g, '.*') // ** standalone → anything
    if (new RegExp(`^${regexStr}$`).test(normalized)) {
      return true
    }
  }
  return false
}

/**
 * Hard intake guards. There was previously NO file-size cap at all, so
 * multi-megabyte generated files were read and handed to tree-sitter.
 */
export const MAX_INDEXABLE_FILE_BYTES = 1_000_000 // 1 MB

/**
 * Generated documentation (NUnit's HTML output, doxygen, javadoc) is the
 * dominant bloat source in vendored .NET trees: thousands of files that yield
 * ~0 tags. Markup is indexed only under this much smaller cap, and files that
 * parse to zero tags are dropped entirely (see code-graph.service.ts).
 */
export const MAX_INDEXABLE_MARKUP_BYTES = 100_000 // 100 KB
const MARKUP_EXTENSIONS = new Set(['.html', '.htm', '.xml', '.svg'])

/** Returns the size cap that applies to a given file path. */
export function sizeCapForFile(filePath: string): number {
  const ext = path.extname(filePath).toLowerCase()
  return MARKUP_EXTENSIONS.has(ext) ? MAX_INDEXABLE_MARKUP_BYTES : MAX_INDEXABLE_FILE_BYTES
}

/** True when a file is markup whose tags should be discarded if empty. */
export function isMarkupFile(filePath: string): boolean {
  return MARKUP_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}
