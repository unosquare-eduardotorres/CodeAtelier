/**
 * Build-time extraction of language/file icons from @iconify-json/vscode-icons.
 *
 * Generates src/renderer/src/components/common/file-language-icons.ts — a map
 * of extension → inline SVG path data for ~40 common file types. Committed so
 * the app has zero runtime dependency on the iconify packages (offline-safe,
 * no bundle bloat).
 *
 * Run: npm run icons:extract
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const vscodeIcons = require('@iconify-json/vscode-icons/icons.json')

/** extension (lowercase, no dot) → vscode-icons icon name */
const EXT_TO_ICON: Record<string, string> = {
  ts: 'file-type-typescript',
  tsx: 'file-type-reactts',
  js: 'file-type-js-official',
  jsx: 'file-type-reactjs',
  mjs: 'file-type-js-official',
  cjs: 'file-type-js-official',
  json: 'file-type-json',
  jsonc: 'file-type-json',
  md: 'file-type-markdown',
  mdx: 'file-type-markdown',
  txt: 'file-type-text',
  css: 'file-type-css',
  scss: 'file-type-scss',
  sass: 'file-type-sass',
  less: 'file-type-less',
  html: 'file-type-html',
  htm: 'file-type-html',
  vue: 'file-type-vue',
  svelte: 'file-type-svelte',
  py: 'file-type-python',
  rb: 'file-type-ruby',
  go: 'file-type-go',
  rs: 'file-type-rust',
  java: 'file-type-java',
  kt: 'file-type-kotlin',
  swift: 'file-type-swift',
  c: 'file-type-c',
  h: 'file-type-c',
  cpp: 'file-type-cpp',
  cc: 'file-type-cpp',
  cxx: 'file-type-cpp',
  hpp: 'file-type-cpp',
  cs: 'file-type-csharp',
  php: 'file-type-php',
  sql: 'file-type-sql',
  sh: 'file-type-shell',
  bash: 'file-type-shell',
  zsh: 'file-type-shell',
  fish: 'file-type-shell',
  ps1: 'file-type-powershell',
  yml: 'file-type-yaml',
  yaml: 'file-type-yaml',
  toml: 'file-type-toml',
  xml: 'file-type-xml',
  svg: 'file-type-svg',
  png: 'file-type-image',
  jpg: 'file-type-image',
  jpeg: 'file-type-image',
  gif: 'file-type-image',
  webp: 'file-type-image',
  ico: 'file-type-image',
  env: 'file-type-config',
  gitignore: 'file-type-git',
  gitattributes: 'file-type-git',
  dockerfile: 'file-type-docker',
  editorconfig: 'file-type-config',
  graphql: 'file-type-graphql',
  gql: 'file-type-graphql',
  prisma: 'file-type-prisma',
  wasm: 'file-type-wasm',
  zip: 'file-type-zip',
  gz: 'file-type-zip',
  tar: 'file-type-zip',
  pdf: 'file-type-pdf2',
  csv: 'file-type-excel',
  ex: 'file-type-elixir',
  exs: 'file-type-elixir',
  erl: 'file-type-erlang',
  hs: 'file-type-haskell',
  lua: 'file-type-lua',
  nim: 'file-type-nim',
  scala: 'file-type-scala',
  dart: 'file-type-dartlang',
  r: 'file-type-r',
  jl: 'file-type-julia',
  pl: 'file-type-perl'
}

const OUT_PATH = path.resolve(
  process.cwd(),
  'src/renderer/src/components/common/file-language-icons.ts'
)

interface IconifyIcon {
  body: string
  height?: number
  width?: number
}

function extract(): void {
  const icons = vscodeIcons.icons as Record<string, IconifyIcon>

  const iconEntries: string[] = []
  const extEntries: string[] = []
  const extracted = new Set<string>()

  for (const [ext, iconName] of Object.entries(EXT_TO_ICON)) {
    const icon = icons[iconName]
    if (!icon?.body) {
      console.warn(`⚠ Icon not found: ${iconName} (ext .${ext}) — skipping`)
      continue
    }

    if (!extracted.has(iconName)) {
      extracted.add(iconName)
      iconEntries.push(
        `  '${iconName}': { body: '${icon.body}', height: ${icon.height ?? 32}, width: ${
          icon.width ?? 32
        } }`
      )
    }
    extEntries.push(`  '${ext}': '${iconName}'`)
  }

  const content = `/**
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: npm run icons:extract
 * Source: @iconify-json/vscode-icons (MIT)
 */
export interface FileIconData {
  body: string
  height: number
  width: number
}

/** Icon name → raw SVG path data. */
export const FILE_ICONS: Record<string, FileIconData> = {
${iconEntries.join(',\n')}
}

/** File extension (lowercase, no dot) → icon name. */
export const EXT_TO_ICON_NAME: Record<string, string> = {
${extEntries.join(',\n')}
}
`

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true })
  fs.writeFileSync(OUT_PATH, content)
  console.log(
    `✓ Extracted ${iconEntries.length} icons (${extEntries.length} extension mappings) → ${path.relative(
      process.cwd(),
      OUT_PATH
    )}`
  )
}

extract()
