/**
 * Tests for scripts/patch-feed-manifest.mjs — the channel-manifest rewrite the
 * OneDrive publish step runs.
 *
 * Background: dist/ is not cleaned between platform builds, so a Mac build found
 * the previous Windows `dist/latest.yml` still sitting there and republished it
 * with the *current* version stamped into the URL path. The result was a feed
 * entry whose body said 1.0.64 while its url said `1.0.65/win/…-1.0.64-setup.exe`
 * — a file that can never exist. The old `sed` pipeline could not detect that,
 * and was not idempotent either (a second run produced `1.0.65/win/1.0.65/win/…`).
 *
 * Run: tsx src/main/services/__tests__/feed-manifest-patch.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { parseManifestVersion, rewriteManifest } from '../../../../scripts/patch-feed-manifest.mjs'

const WIN_MANIFEST = [
  'version: 1.0.65',
  'files:',
  '  - url: code-atelier-1.0.65-setup.exe',
  '    sha512: abc==',
  '    size: 172657167',
  'path: code-atelier-1.0.65-setup.exe',
  'sha512: abc==',
  "releaseDate: '2026-08-05T05:23:46.447Z'",
  ''
].join('\n')

const MAC_MANIFEST = [
  'version: 1.0.65',
  'files:',
  '  - url: Code-Atelier-1.0.65-arm64-mac.zip',
  '    sha512: zzz==',
  '    size: 202621380',
  '  - url: code-atelier-1.0.65.dmg',
  '    sha512: ggg==',
  '    size: 199817138',
  'path: Code-Atelier-1.0.65-arm64-mac.zip',
  'sha512: zzz==',
  "releaseDate: '2026-08-05T05:21:01.279Z'",
  ''
].join('\n')

describe('patch-feed-manifest — parseManifestVersion', () => {
  test('reads_the_version_field', () => {
    assert.equal(parseManifestVersion(WIN_MANIFEST), '1.0.65')
  })

  test('strips_surrounding_quotes', () => {
    assert.equal(parseManifestVersion("version: '1.0.65'\n"), '1.0.65')
    assert.equal(parseManifestVersion('version: "1.0.65"\n'), '1.0.65')
  })

  test('returns_null_when_absent_or_empty', () => {
    assert.equal(parseManifestVersion('files:\n  - url: x.exe\n'), null)
    assert.equal(parseManifestVersion('version:\n'), null)
  })
})

describe('patch-feed-manifest — rewriteManifest', () => {
  test('prefixes_bare_filenames_with_version_and_platform', () => {
    const { text, files } = rewriteManifest(WIN_MANIFEST, '1.0.65', 'win')
    assert.match(text, /^ {2}- url: 1\.0\.65\/win\/code-atelier-1\.0\.65-setup\.exe$/m)
    assert.match(text, /^path: 1\.0\.65\/win\/code-atelier-1\.0\.65-setup\.exe$/m)
    assert.deepEqual(files, ['1.0.65/win/code-atelier-1.0.65-setup.exe'])
  })

  test('is_idempotent_a_second_run_changes_nothing', () => {
    const once = rewriteManifest(WIN_MANIFEST, '1.0.65', 'win')
    const twice = rewriteManifest(once.text, '1.0.65', 'win')
    assert.equal(twice.text, once.text, 'second run must not double-prefix urls')
    assert.deepEqual(twice.files, once.files)
    assert.ok(!twice.text.includes('1.0.65/win/1.0.65/win/'))
  })

  test('throws_when_the_manifest_describes_a_different_version', () => {
    // The exact corruption that shipped: a leftover 1.0.64 manifest published
    // during the 1.0.65 build.
    const stale = WIN_MANIFEST.replace('version: 1.0.65', 'version: 1.0.64')
    assert.throws(
      () => rewriteManifest(stale, '1.0.65', 'win'),
      /describes v1\.0\.64 but this build is v1\.0\.65/
    )
  })

  test('throws_when_the_manifest_has_no_version', () => {
    assert.throws(() => rewriteManifest('files:\n  - url: x.exe\n', '1.0.65', 'win'), /no version/)
  })

  test('handles_multi_file_mac_manifests_and_leaves_other_keys_alone', () => {
    const { text, files } = rewriteManifest(MAC_MANIFEST, '1.0.65', 'mac')
    assert.deepEqual(files, [
      '1.0.65/mac/Code-Atelier-1.0.65-arm64-mac.zip',
      '1.0.65/mac/code-atelier-1.0.65.dmg'
    ])
    // sha512/size/releaseDate must survive byte-for-byte.
    assert.match(text, /^ {4}sha512: zzz==$/m)
    assert.match(text, /^ {4}size: 199817138$/m)
    assert.match(text, /^releaseDate: '2026-08-05T05:21:01\.279Z'$/m)
    // The top-level version line is never rewritten.
    assert.match(text, /^version: 1\.0\.65$/m)
  })

  test('maps_a_name_with_spaces_to_the_hyphenated_safe_name', () => {
    // electron-builder names the zip with spaces but writes the safe name into
    // the manifest — publishing the file verbatim 404'd every Mac download.
    const manifest = 'version: 1.0.65\npath: Code Atelier-1.0.65-arm64-mac.zip\n'
    const { text, files } = rewriteManifest(manifest, '1.0.65', 'mac')
    assert.deepEqual(files, ['1.0.65/mac/Code-Atelier-1.0.65-arm64-mac.zip'])
    assert.match(text, /^path: 1\.0\.65\/mac\/Code-Atelier-1\.0\.65-arm64-mac\.zip$/m)
  })

  test('preserves_quoting_style_of_the_rewritten_value', () => {
    const manifest = "version: 1.0.65\npath: 'code-atelier-1.0.65-setup.exe'\n"
    const { text } = rewriteManifest(manifest, '1.0.65', 'win')
    assert.match(text, /^path: '1\.0\.65\/win\/code-atelier-1\.0\.65-setup\.exe'$/m)
  })

  test('does_not_touch_keys_that_merely_end_in_url', () => {
    const manifest = 'version: 1.0.65\nblockMapUrl: something.blockmap\npath: setup.exe\n'
    const { text, files } = rewriteManifest(manifest, '1.0.65', 'win')
    assert.match(text, /^blockMapUrl: something\.blockmap$/m)
    assert.deepEqual(files, ['1.0.65/win/setup.exe'])
  })

  test('deduplicates_repeated_references', () => {
    // url and path point at the same artifact in every real Windows manifest.
    const { files } = rewriteManifest(WIN_MANIFEST, '1.0.65', 'win')
    assert.equal(files.length, 1)
  })
})

if (process.argv[1]?.includes('feed-manifest-patch')) {
  void summaryAsync()
}
