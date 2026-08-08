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

if (errors.length) {
  console.error('\n✗ Build asset verification failed:\n' + errors.map((e) => `  - ${e}`).join('\n'))
  console.error('\nTyped tag extraction would fall back to untyped tags in the packaged app.\n')
  process.exit(1)
}

console.log('✓ Build assets verified: tree-sitter runtime + query packs')
