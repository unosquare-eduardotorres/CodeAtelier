/**
 * Shared language resolution + lazy prismjs grammar loading.
 *
 * Two highlighting engines coexist in the renderer:
 *  - `prism-react-renderer` (chat CodeBlock, FileViewerPanel) vendors a Prism
 *    instance with a small default language set (markup, clike, js/ts/tsx/jsx,
 *    css, markdown, json, yaml, graphql, sql, go, python, swift, c, cpp,
 *    kotlin, rust, coffeescript, …).
 *  - `react-diff-viewer-continued` (diffs) uses refractor with its own loader
 *    map (36 languages, aliases tsx→typescript / jsx→javascript).
 *
 * This module is the single source of truth for extension → language id and
 * fence-tag → language id, plus `ensurePrismLanguage` which lazily imports
 * `prismjs/components/prism-<id>` chunks onto the vendored instance (the
 * official prism-react-renderer pattern: set the `Prism` global, then import).
 *
 * Pure data + async loaders — no React, no DOM — so it is unit-testable from
 * the main-process harness.
 */
import { Prism } from 'prism-react-renderer'

/**
 * Extension (lowercase, no dot) → prism language id.
 * Covers every key of EXT_TO_ICON_NAME in file-language-icons.ts; languages
 * absent from both engines fall back to the nearest grammar.
 */
export const EXT_TO_LANG: Record<string, string> = {
  // TypeScript / JavaScript
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  // Data / config
  json: 'json',
  jsonc: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  env: 'ini',
  editorconfig: 'ini',
  // Docs
  md: 'markdown',
  mdx: 'markdown',
  txt: 'text',
  csv: 'csv',
  // Web
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  svelte: 'markup',
  graphql: 'graphql',
  gql: 'graphql',
  prisma: 'graphql', // no prismjs grammar; GraphQL is the closest syntax
  // Scripting
  py: 'python',
  rb: 'ruby',
  php: 'php',
  pl: 'perl',
  lua: 'lua',
  r: 'r',
  jl: 'julia',
  sql: 'sql',
  // JVM
  java: 'java',
  kt: 'kotlin',
  scala: 'scala',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  nim: 'nim',
  // Systems
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  swift: 'swift',
  dart: 'dart',
  // Shell
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  ps1: 'powershell',
  gitignore: 'bash', // no grammar; bash is the conventional fallback
  gitattributes: 'bash',
  dockerfile: 'docker',
  // Binary / other (no grammar — plain text)
  png: 'text',
  jpg: 'text',
  jpeg: 'text',
  gif: 'text',
  webp: 'text',
  ico: 'text',
  wasm: 'text',
  zip: 'text',
  gz: 'text',
  tar: 'text',
  pdf: 'text'
}

/**
 * Markdown fence tag → language id. Models write `ts`, `sh`, `py`, `yml`…
 * which are not the canonical ids prism-react-renderer expects.
 */
export const FENCE_TAG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  fish: 'bash',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  'c++': 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  kt: 'kotlin',
  rs: 'rust',
  golang: 'go',
  dockerfile: 'docker',
  ps: 'powershell',
  ps1: 'powershell',
  'c#': 'csharp',
  cs: 'csharp',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  text: 'text',
  txt: 'text'
}

/**
 * Languages the vendored prism-react-renderer Prism ships with — resolving
 * these is synchronous and needs no chunk import.
 */
export const VENDORED_LANGUAGES = new Set([
  'markup',
  'html',
  'xml',
  'svg',
  'mathml',
  'ssml',
  'atom',
  'rss',
  'clike',
  'javascript',
  'js',
  'actionscript',
  'graphql',
  'sql',
  'swift',
  'c',
  'objectivec',
  'objc',
  'reason',
  'go',
  'json',
  'webmanifest',
  'python',
  'py',
  'jsx',
  'tsx',
  'typescript',
  'ts',
  'css',
  'markdown',
  'md',
  'kotlin',
  'kt',
  'kts',
  'rust',
  'rs',
  'yaml',
  'yml',
  'coffeescript',
  'coffee',
  'cpp',
  'regex',
  'flow',
  'jsdoc',
  'n4js',
  'text',
  'txt',
  'plain',
  'plaintext'
])

/**
 * prismjs component dependencies that must load before the target grammar.
 * Derived from prismjs/components.js `require` metadata. Only entries whose
 * deps are NOT already vendored are listed.
 */
const GRAMMAR_DEPS: Record<string, string[]> = {
  php: ['markup-templating'],
  scala: ['java'],
  scss: ['css'],
  markdown: ['markup'],
  jsx: ['markup', 'javascript'],
  tsx: ['jsx', 'typescript'],
  typescript: ['javascript'],
  kotlin: ['clike'],
  csharp: ['clike'],
  java: ['clike'],
  go: ['clike'],
  ruby: ['clike'],
  dart: ['clike'],
  cpp: ['c']
}

// ── Lazy grammar loading ──

/** Install the vendored Prism instance as the global prismjs chunks expect. */
function installPrismGlobal(): void {
  // prismjs component chunks resolve `Prism` from the global scope at
  // registration time (official prism-react-renderer pattern). Guarded for
  // environments without `global` (Electron renderer uses window).
  const scope: Record<string, unknown> =
    typeof globalThis !== 'undefined' ? (globalThis as unknown as Record<string, unknown>) : {}
  scope.Prism = Prism
}

const loadedLanguages = new Set<string>()
/** Loads that failed — never retried, so one bad chunk can't loop. */
const negativeCache = new Set<string>()
/** In-flight imports, deduped so concurrent callers share one load. */
const inflight = new Map<string, Promise<void>>()

// ── Load notifications (useSyncExternalStore support) ──
// Components subscribe so they re-render the moment a grammar registers,
// instead of mirroring readiness in local state.
const listeners = new Set<() => void>()

function notifyLoaded(): void {
  for (const listener of listeners) listener()
}

/** Subscribe to grammar-load events (useSyncExternalStore). */
export function subscribePrismLanguages(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Snapshot for useSyncExternalStore — changes whenever a grammar registers. */
export function getLoadedLanguageCount(): number {
  return loadedLanguages.size
}

/**
 * Lazy grammar loaders. A static map (not `import(`prismjs/components/prism-${id}`)`)
 * so the bundler can see every possible chunk and code-split them individually —
 * only the grammar a consumer actually asks for is fetched. Mirrors the pattern
 * react-diff-viewer-continued uses for its refractor loaders.
 */
const GRAMMAR_LOADERS: Record<string, () => Promise<unknown>> = {
  bash: () => import('prismjs/components/prism-bash'),
  c: () => import('prismjs/components/prism-c'),
  clike: () => import('prismjs/components/prism-clike'),
  cpp: () => import('prismjs/components/prism-cpp'),
  csharp: () => import('prismjs/components/prism-csharp'),
  css: () => import('prismjs/components/prism-css'),
  csv: () => import('prismjs/components/prism-csv'),
  dart: () => import('prismjs/components/prism-dart'),
  docker: () => import('prismjs/components/prism-docker'),
  elixir: () => import('prismjs/components/prism-elixir'),
  erlang: () => import('prismjs/components/prism-erlang'),
  go: () => import('prismjs/components/prism-go'),
  graphql: () => import('prismjs/components/prism-graphql'),
  haskell: () => import('prismjs/components/prism-haskell'),
  ini: () => import('prismjs/components/prism-ini'),
  java: () => import('prismjs/components/prism-java'),
  javascript: () => import('prismjs/components/prism-javascript'),
  json: () => import('prismjs/components/prism-json'),
  jsx: () => import('prismjs/components/prism-jsx'),
  julia: () => import('prismjs/components/prism-julia'),
  kotlin: () => import('prismjs/components/prism-kotlin'),
  less: () => import('prismjs/components/prism-less'),
  lua: () => import('prismjs/components/prism-lua'),
  makefile: () => import('prismjs/components/prism-makefile'),
  markup: () => import('prismjs/components/prism-markup'),
  'markup-templating': () => import('prismjs/components/prism-markup-templating'),
  nim: () => import('prismjs/components/prism-nim'),
  perl: () => import('prismjs/components/prism-perl'),
  php: () => import('prismjs/components/prism-php'),
  powershell: () => import('prismjs/components/prism-powershell'),
  python: () => import('prismjs/components/prism-python'),
  r: () => import('prismjs/components/prism-r'),
  ruby: () => import('prismjs/components/prism-ruby'),
  rust: () => import('prismjs/components/prism-rust'),
  sass: () => import('prismjs/components/prism-sass'),
  scala: () => import('prismjs/components/prism-scala'),
  scss: () => import('prismjs/components/prism-scss'),
  sql: () => import('prismjs/components/prism-sql'),
  swift: () => import('prismjs/components/prism-swift'),
  toml: () => import('prismjs/components/prism-toml'),
  tsx: () => import('prismjs/components/prism-tsx'),
  typescript: () => import('prismjs/components/prism-typescript'),
  yaml: () => import('prismjs/components/prism-yaml')
}

function importGrammar(id: string): Promise<void> {
  const loader = GRAMMAR_LOADERS[id]
  if (!loader) return Promise.reject(new Error(`no prismjs grammar for "${id}"`))
  return loader().then(() => undefined)
}

/** Languages with a prismjs component chunk (lazy-loadable). */
const PRISMJS_LANGUAGES = new Set(Object.keys(GRAMMAR_LOADERS))

/** Every language id this module can resolve or load. */
export const KNOWN_LANGUAGES: ReadonlySet<string> = new Set([
  ...VENDORED_LANGUAGES,
  ...PRISMJS_LANGUAGES
])

/**
 * Ensure the prismjs grammar for `id` is registered on the vendored Prism
 * instance. Loads dependencies first, dedupes concurrent calls, caches
 * successes and failures. Resolves `true` when the language is available
 * (vendored or loaded), `false` when it cannot be provided.
 */
export async function ensurePrismLanguage(id: string): Promise<boolean> {
  if (!id) return false
  if (VENDORED_LANGUAGES.has(id)) return true
  if (loadedLanguages.has(id)) return true
  if (negativeCache.has(id)) return false
  if (!PRISMJS_LANGUAGES.has(id)) {
    negativeCache.add(id)
    return false
  }

  installPrismGlobal()

  // Dependencies first — scala extends java, php tokenizes via
  // markup-templating, etc. Already-loaded deps resolve immediately.
  const deps = GRAMMAR_DEPS[id] ?? []
  await Promise.all(deps.map((dep) => ensurePrismLanguage(dep)))

  let load = inflight.get(id)
  if (!load) {
    load = importGrammar(id)
      .then(() => {
        if (Prism.languages[id]) {
          loadedLanguages.add(id)
          notifyLoaded()
        } else {
          negativeCache.add(id)
        }
      })
      .catch(() => {
        negativeCache.add(id)
      })
      .finally(() => {
        inflight.delete(id)
      })
    inflight.set(id, load)
  }
  await load
  return loadedLanguages.has(id)
}

/** Resolve a file path to a language id ('' when unknown). */
export function languageForPath(filePath: string): string {
  const base = filePath.split('/').pop() ?? ''
  let ext = ''
  if (base.startsWith('.') && base.length > 1) {
    ext = base.slice(1).toLowerCase()
  } else {
    const dot = base.lastIndexOf('.')
    if (dot > 0 && dot < base.length - 1) ext = base.slice(dot + 1).toLowerCase()
  }
  // Dotfile basenames that behave like extensions (e.g. "Dockerfile" has none)
  if (!ext) {
    const lower = base.toLowerCase()
    if (lower === 'dockerfile') return 'docker'
    if (lower === 'makefile') return 'makefile'
  }
  return EXT_TO_LANG[ext] ?? ''
}

/** Resolve a markdown fence tag to a language id ('' when unknown). */
export function languageForFenceTag(tag: string): string {
  const lower = tag.toLowerCase()
  if (lower in FENCE_TAG_ALIASES) return FENCE_TAG_ALIASES[lower]
  if (lower in EXT_TO_LANG) return EXT_TO_LANG[lower]
  // Canonical ids (````typescript`, ````ruby`, ````sql`) pass through when
  // a grammar actually exists for them.
  return KNOWN_LANGUAGES.has(lower) ? lower : ''
}

/** True when the language is already available without any async load. */
export function isLanguageReady(id: string): boolean {
  return VENDORED_LANGUAGES.has(id) || loadedLanguages.has(id)
}
