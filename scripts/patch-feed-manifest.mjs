#!/usr/bin/env node
/**
 * Rewrite an electron-builder channel manifest (latest.yml / latest-mac.yml) so
 * every artifact reference points into the `<version>/<platform>/` subfolder the
 * publish script copies artifacts into.
 *
 * Why this exists instead of `sed`:
 *   1. The manifest must be *asserted* to describe the version being published.
 *      dist/ keeps the previous platform's channel file around, so a Mac build
 *      would happily republish the leftover Windows manifest under a 1.0.65 path
 *      while its body still said 1.0.64 — a feed entry that can never resolve.
 *   2. The sed version was not idempotent: running the publish twice produced
 *      `1.0.65/win/1.0.65/win/…`. Here an already-prefixed value is left alone.
 *
 * No dependencies — the publish step runs after `npm prune --omit=dev`, so only
 * plain node and production deps exist at that point.
 *
 * CLI: node scripts/patch-feed-manifest.mjs <src.yml> <dest.yml> <version> <platform>
 * Prints one `<relative-path>\t<size>` line per referenced file to stdout, for the
 * caller to verify on disk. The size is the manifest's own `size:` field and is
 * empty when the manifest does not carry one. Existence alone is not a useful
 * check: a cloud drive exposes a partially copied artifact at its final name, so
 * the byte count is what separates "published" from "still being written".
 */
import { readFileSync, writeFileSync } from 'node:fs'

/** Strip matching surrounding quotes from a scalar YAML value. */
function unquote(value) {
  const match = /^(['"])([\s\S]*)\1$/.exec(value)
  return match ? { quote: match[1], value: match[2] } : { quote: '', value }
}

/**
 * Read the `version:` field from a channel manifest.
 * Returns null when the field is absent.
 */
export function parseManifestVersion(text) {
  const match = /^version:[ \t]*(.*)$/m.exec(text)
  if (!match) return null
  const parsed = unquote(match[1].trim()).value.trim()
  return parsed.length > 0 ? parsed : null
}

/**
 * Rewrite every `url:` / `path:` value to `<version>/<platform>/<basename>`.
 *
 * - Asserts the manifest describes `version` — throws otherwise.
 * - A value that already contains `/` is assumed to be prefixed and is left
 *   untouched, which makes the transform safe to re-run.
 * - Spaces are replaced with `-`, matching the "safe name" electron-builder
 *   writes into the manifest for artifacts whose filenames contain spaces
 *   (`Code Atelier-1.0.65-arm64-mac.zip` → `Code-Atelier-1.0.65-arm64-mac.zip`).
 *
 * @returns the rewritten text, the de-duplicated list of referenced paths, and a
 * `path -> size` map for the entries whose manifest block declares a `size:`.
 */
export function rewriteManifest(text, version, platform) {
  const found = parseManifestVersion(text)
  if (found === null) {
    throw new Error('manifest has no version field')
  }
  if (found !== version) {
    throw new Error(`manifest describes v${found} but this build is v${version}`)
  }

  const files = []
  const sizes = {}
  // The `size:` of a files[] entry sits on a later line than its `url:`, so the
  // most recent url is what a size line attaches to.
  let currentRef = null

  const lines = text.split('\n').map((line) => {
    const sizeMatch = /^[ \t]+size:[ \t]*(\d+)[ \t]*$/.exec(line)
    if (sizeMatch && currentRef !== null) {
      sizes[currentRef] = Number(sizeMatch[1])
      return line
    }

    const match = /^([ \t]*-?[ \t]*)(url|path):([ \t]*)(.*)$/.exec(line)
    if (!match) return line

    const [, indent, key, gap, rawValue] = match
    const { quote, value } = unquote(rawValue.trim())
    if (value.length === 0) return line

    // Already prefixed by an earlier run — record it, change nothing.
    if (value.includes('/')) {
      files.push(value)
      currentRef = value
      return line
    }

    const rel = `${version}/${platform}/${value.replace(/ /g, '-')}`
    files.push(rel)
    currentRef = rel
    return `${indent}${key}:${gap}${quote}${rel}${quote}`
  })

  return { text: lines.join('\n'), files: [...new Set(files)], sizes }
}

// ── CLI
const isCli = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isCli) {
  const [src, dest, version, platform] = process.argv.slice(2)
  if (!src || !dest || !version || !platform) {
    console.error('usage: patch-feed-manifest.mjs <src.yml> <dest.yml> <version> <platform>')
    process.exit(2)
  }
  try {
    const { text, files, sizes } = rewriteManifest(readFileSync(src, 'utf8'), version, platform)
    writeFileSync(dest, text)
    for (const file of files) console.log(`${file}\t${sizes[file] ?? ''}`)
  } catch (err) {
    console.error(`patch-feed-manifest: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
