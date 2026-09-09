#!/usr/bin/env node
/**
 * check-design-tokens — guards the renderer's token system.
 *
 * 1. DEAD TOKENS (hard fail): any Tailwind token utility used in
 *    src/renderer/src (e.g. `bg-surface-hover`) must resolve to a `--color-*`
 *    variable defined in the theme files or the `@theme inline` block in
 *    main.css. Undefined utilities silently generate no CSS (transparent
 *    backgrounds, missing hovers) — this check makes them build failures.
 *
 * 2. RAW PALETTE RATCHET (fail on growth): counts raw Tailwind palette
 *    utilities (`text-amber-400`, `bg-indigo-500/20`, …) that bypass theme
 *    tokens and break light-theme contrast. The count may only go DOWN.
 *    Lower it by migrating to semantic tokens, then run with
 *    UPDATE_BASELINE=1 to re-pin.
 *
 * Usage: node scripts/check-design-tokens.mjs [--update-baseline]
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src/renderer/src')
const BASELINE_FILE = join(ROOT, 'scripts/design-token-baseline.json')

// ── 1. Dead token utilities ────────────────────────────────────────────────

const THEME_FILES = [
  'assets/themes/code-atelier.css',
  'assets/themes/developer.css',
  'assets/themes/glass.css',
  'assets/themes/porcelain.css'
]

const definedTokens = new Set()
for (const rel of THEME_FILES) {
  const css = readFileSync(join(SRC, rel), 'utf8')
  for (const m of css.matchAll(/(--color-[a-z0-9-]+)\s*:/g)) definedTokens.add(m[1])
}
// @theme inline in main.css maps utilities to the same-named runtime vars.
const mainCss = readFileSync(join(SRC, 'assets/main.css'), 'utf8')
const themeBlock = mainCss.match(/@theme inline \{([\s\S]*?)\}/)
if (themeBlock) {
  for (const m of themeBlock[1].matchAll(/(--color-[a-z0-9-]+)\s*:/g)) definedTokens.add(m[1])
}

const TOKEN_CLASS_RE =
  /(?:text|bg|border|ring|from|to|via|fill|stroke|shadow|outline|divide|accent|caret|decoration)-(?:surface|text|primary|accent|teal|forest|success|warning|danger|info|mode|plan|panel|agent|grill|gold|button|card|input|modal|sidebar|table|selection|code|on)-[a-z0-9-]+/g

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') walk(p, out)
    } else if (/\.(tsx|ts)$/.test(entry)) out.push(p)
  }
  return out
}

const files = walk(SRC)
const deadUsages = []
const rawPaletteRe =
  /(?:^|[\s"'`])(?:hover:|focus:|active:|disabled:|placeholder:|group-hover:|focus-visible:)?(?:text|bg|border|ring|from|to|via|fill|stroke|shadow|outline|divide|accent|caret|decoration|decoration)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}(?:\/\d+)?/g
let rawCount = 0

for (const file of files) {
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(TOKEN_CLASS_RE)) {
    const varName = '--' + m[0].replace(/^[a-z]+-/, 'color-')
    if (!definedTokens.has(varName)) {
      deadUsages.push(`${relative(ROOT, file)}: ${m[0]} (no --${m[0].replace(/^[a-z]+-/, 'color-')} in any theme)`)
    }
  }
  for (const _ of src.matchAll(rawPaletteRe)) rawCount++
}

let failed = false

if (deadUsages.length > 0) {
  failed = true
  console.error(`✗ DEAD TOKEN UTILITIES (${deadUsages.length}) — defined in no theme, generate no CSS:`)
  for (const u of deadUsages.slice(0, 40)) console.error(`  ${u}`)
  if (deadUsages.length > 40) console.error(`  … and ${deadUsages.length - 40} more`)
  console.error('  Fix: use an existing token, or define it in all 4 themes + @theme inline in main.css.')
} else {
  console.log('✓ no dead token utilities')
}

// ── 2. Raw palette ratchet ─────────────────────────────────────────────────

const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
const updateBaseline = process.argv.includes('--update-baseline') || process.env.UPDATE_BASELINE === '1'

if (updateBaseline) {
  writeFileSync(BASELINE_FILE, JSON.stringify({ rawPaletteUtilities: rawCount }, null, 2) + '\n')
  console.log(`↺ baseline updated to ${rawCount} raw palette utilities`)
} else if (rawCount > baseline.rawPaletteUtilities) {
  failed = true
  console.error(
    `✗ RAW PALETTE RATCHET: ${rawCount} > baseline ${baseline.rawPaletteUtilities}. ` +
      `Raw Tailwind palette classes (text-amber-400, bg-indigo-500/20, …) bypass theme tokens ` +
      `and fail contrast on porcelain. Use semantic tokens (text-warning, bg-accent-muted, …) instead. ` +
      `If the count legitimately dropped, re-pin with UPDATE_BASELINE=1.`
  )
} else {
  console.log(`✓ raw palette ratchet: ${rawCount} ≤ baseline ${baseline.rawPaletteUtilities}`)
}

process.exit(failed ? 1 : 0)
