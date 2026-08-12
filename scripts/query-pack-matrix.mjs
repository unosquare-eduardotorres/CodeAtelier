/**
 * Query-pack compile matrix.
 *
 * Prints, for every tree-sitter grammar we ship, whether its `.scm` tag query
 * compiles — and how many top-level patterns the recovery splitter salvages
 * when it does not. A pack that compiles to nothing is indistinguishable from
 * a language with no symbols, which is how C#, Lua, Scala, Solidity and Zig
 * indexed to zero tags unnoticed.
 *
 * Usage:  npx tsx scripts/query-pack-matrix.mjs [lang ...]
 * (tsx, not node — it imports the splitter from the TypeScript source so the
 * matrix always reflects the shipping implementation.)
 * With no arguments it covers every grammar that has a query pack.
 * Exits non-zero if any pack is unrecoverable.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { splitTopLevelPatterns } from '../src/main/services/code-graph-tags.ts'

const requireFrom = createRequire(import.meta.url)
const TS = await import('web-tree-sitter')
await TS.Parser.init()

const queriesDir = path.join(
  path.dirname(requireFrom.resolve('repomap-mcp/package.json')),
  'queries'
)
const wasmDir = path.join(path.dirname(requireFrom.resolve('tree-sitter-wasms/package.json')), 'out')

const ALIASES = { c_sharp: ['csharp', 'c_sharp'], tsx: ['typescript'] }

function queryPath(lang) {
  const names = ALIASES[lang] ?? [lang]
  for (const sub of ['tree-sitter-language-pack', 'tree-sitter-languages']) {
    for (const name of names) {
      const p = path.join(queriesDir, sub, `${name}-tags.scm`)
      if (existsSync(p)) return p
    }
  }
  return null
}

const langs =
  process.argv.length > 2
    ? process.argv.slice(2)
    : readdirSync(wasmDir)
        .filter((f) => f.endsWith('.wasm'))
        .map((f) => f.replace(/^tree-sitter-|\.wasm$/g, ''))
        .sort()

let ok = 0
let recovered = 0
let dead = 0
let noPack = 0

for (const lang of langs) {
  const qp = queryPath(lang)
  if (!qp) {
    noPack++
    continue
  }
  const wasm = path.join(wasmDir, `tree-sitter-${lang}.wasm`)
  if (!existsSync(wasm)) {
    console.log(`${lang.padEnd(14)} NO GRAMMAR`)
    continue
  }

  let language
  try {
    language = await TS.Language.load(wasm)
  } catch (e) {
    console.log(`${lang.padEnd(14)} GRAMMAR FAIL   ${e.message}`)
    continue
  }

  const source = readFileSync(qp, 'utf-8')
  try {
    const q = new TS.Query(language, source)
    console.log(`${lang.padEnd(14)} ok             captures=${q.captureNames.length}`)
    ok++
  } catch (e) {
    const patterns = splitTopLevelPatterns(source)
    const kept = patterns.filter((p) => {
      try {
        new TS.Query(language, p).delete()
        return true
      } catch {
        return false
      }
    })
    if (kept.length > 0) {
      const merged = new TS.Query(language, kept.join('\n\n'))
      console.log(
        `${lang.padEnd(14)} RECOVERED      ${kept.length}/${patterns.length} patterns, ` +
          `captures=${merged.captureNames.length}  (${e.message})`
      )
      recovered++
    } else {
      console.log(`${lang.padEnd(14)} DEAD           0/${patterns.length} patterns  (${e.message})`)
      dead++
    }
  }
}

console.log(
  `\n${ok} clean, ${recovered} recovered by splitting, ${dead} unrecoverable, ${noPack} without a query pack`
)
if (dead > 0) process.exitCode = 1
