// Fails the build if the tree-sitter runtime is not adjacent to the chunk that
// loads it. Plain node, no deps: runs before build-win.sh/build-mac.sh prune.
//
// Why this exists: web-tree-sitter's Emscripten loader resolves the wasm
// relative to its own file. When Rollup moved that loader into out/main/chunks/
// the copy target in electron.vite.config.ts silently became wrong, typed tag
// extraction fell back to untyped tags, and nothing failed loudly. The unit
// suite cannot catch this — it runs against src/ with node_modules resolution.
import { readdirSync, readFileSync, existsSync, statSync } from 'fs'
import { join, dirname } from 'path'

const walk = (d) =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })

const errors = []

if (!existsSync('out/main')) {
  errors.push('out/main is missing — run `electron-vite build` first')
} else {
  for (const file of walk('out/main').filter((f) => f.endsWith('.js'))) {
    if (!readFileSync(file, 'utf-8').includes('tree-sitter.wasm')) continue
    const sibling = join(dirname(file), 'tree-sitter.wasm')
    if (!existsSync(sibling)) {
      errors.push(`${file} loads tree-sitter.wasm but ${sibling} is missing`)
    }
  }
}

if (!existsSync('out/queries/tree-sitter-language-pack')) {
  errors.push('out/queries/tree-sitter-language-pack is missing')
}

// ── Relative require() resolution ────────────────────────────────────────────
// Rollup rewrites `import` and `import()` to emitted chunks, but copies a
// `require('./x')` through verbatim — so it resolves against the flat out/main
// layout, not the source tree. Every such call is MODULE_NOT_FOUND in the
// packaged app while working fine in dev, and they all sit inside try/catch,
// so the feature just quietly stops existing. `require('./maintenance')` killed
// the startup VACUUM for three releases before anyone read the warning.
//
// eslint bans these at the source level; this is the backstop that proves it
// against the actual build output. Pre-existing offenders are baselined so the
// build stays green while still failing on anything new.
const BASELINE = new Set([
  'blueprint-lead-review.service -> ../db/repositories',
  'blueprint-lead-review.service -> ./memory-extraction.service',
  'blueprint-lead-review.service -> ../db/repositories/blueprint-event.repository',
  'code-graph.service -> ../db/repositories',
  'code-graph.service -> ../db',
  'index -> ../db/repositories',
  'index -> ../db/index',
  'blueprint.service -> ./blueprint-spec.service'
])

if (existsSync('out/main')) {
  const RELATIVE_REQUIRE = /require\(\s*["'](\.[^"']*)["']\s*\)/g
  const stale = new Set(BASELINE)

  for (const file of walk('out/main').filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(file, 'utf-8')
    // Chunk filenames carry a content hash that changes every build.
    const chunk = file
      .split(/[/\\]/)
      .pop()
      .replace(/(-[\w-]{8})?\.js$/, '')

    for (const [, spec] of src.matchAll(RELATIVE_REQUIRE)) {
      const base = join(dirname(file), spec)
      const resolves = [
        base,
        `${base}.js`,
        `${base}.cjs`,
        `${base}.json`,
        join(base, 'index.js')
      ].some((candidate) => existsSync(candidate))
      if (resolves) continue

      const id = `${chunk} -> ${spec}`
      stale.delete(id)
      if (!BASELINE.has(id)) {
        errors.push(
          `${file} requires "${spec}", which is not emitted — MODULE_NOT_FOUND at runtime`
        )
      }
    }
  }

  if (stale.size > 0) {
    console.log(
      `  note: ${stale.size} baselined relative require(s) are now fixed — ` +
        `remove from BASELINE in ${'scripts/verify-build-assets.mjs'}:\n` +
        [...stale].map((e) => `    - ${e}`).join('\n')
    )
  }
}

if (errors.length) {
  console.error('\n✗ Build asset verification failed:\n' + errors.map((e) => `  - ${e}`).join('\n'))
  console.error(
    '\nThese defects are invisible in dev and silent in production — see the notes above.\n'
  )
  process.exit(1)
}

console.log(
  `✓ Build assets verified: tree-sitter runtime + query packs, relative require() resolution ` +
    `(${BASELINE.size} pre-existing offenders baselined)`
)
