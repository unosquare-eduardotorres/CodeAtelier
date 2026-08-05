/**
 * Tests for the loopback update feed server (update-feed-server.ts).
 *
 * The cloud-drive update source used to hand electron-updater a `file://` URL,
 * which its generic provider cannot fetch (electron.net supports http:/https:
 * only) — it threw "ClientRequest only supports http: and https: protocols" on
 * every check, on macOS and Windows alike. These tests cover the loopback
 * server that replaced it: token gating, path traversal, percent-encoded
 * artifact names, nested version folders, and range requests.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { resolveFeedPath, startUpdateFeedServer } from '../update-feed-server'

// ── Pure path resolution ──

const TOKEN = 'a'.repeat(32)
const ROOT = resolve(join(tmpdir(), 'feed-root'))

describe('update-feed-server — resolveFeedPath', () => {
  test('resolves_a_plain_file_under_the_token_prefix', () => {
    const result = resolveFeedPath(ROOT, TOKEN, `/${TOKEN}/latest.yml`)
    assert.equal(result, join(ROOT, 'latest.yml'))
  })

  test('resolves_nested_version_folders', () => {
    // publish-to-onedrive.sh patches yml urls to "<version>/win/<artifact>"
    const result = resolveFeedPath(
      ROOT,
      TOKEN,
      `/${TOKEN}/1.0.65/win/code-atelier-1.0.65-setup.exe`
    )
    assert.equal(result, join(ROOT, '1.0.65', 'win', 'code-atelier-1.0.65-setup.exe'))
  })

  test('decodes_percent_encoded_spaces_in_artifact_names', () => {
    const encoded = encodeURIComponent('Code Atelier-1.0.65-arm64-mac.zip')
    const result = resolveFeedPath(ROOT, TOKEN, `/${TOKEN}/1.0.65/mac/${encoded}`)
    assert.equal(result, join(ROOT, '1.0.65', 'mac', 'Code Atelier-1.0.65-arm64-mac.zip'))
  })

  test('strips_the_noCache_query_electron_updater_appends', () => {
    const result = resolveFeedPath(ROOT, TOKEN, `/${TOKEN}/latest.yml?noCache=abc123`)
    assert.equal(result, join(ROOT, 'latest.yml'))
  })

  test('rejects_requests_without_the_token_prefix', () => {
    assert.equal(resolveFeedPath(ROOT, TOKEN, '/latest.yml'), null)
    assert.equal(resolveFeedPath(ROOT, TOKEN, `/${'b'.repeat(32)}/latest.yml`), null)
  })

  test('rejects_bare_token_root_listing', () => {
    assert.equal(resolveFeedPath(ROOT, TOKEN, `/${TOKEN}/`), null)
    assert.equal(resolveFeedPath(ROOT, TOKEN, `/${TOKEN}`), null)
  })

  test('rejects_dot_dot_traversal', () => {
    assert.equal(resolveFeedPath(ROOT, TOKEN, `/${TOKEN}/../secrets.txt`), null)
    assert.equal(resolveFeedPath(ROOT, TOKEN, `/${TOKEN}/1.0.65/../../secrets.txt`), null)
  })

  test('rejects_encoded_dot_dot_traversal', () => {
    assert.equal(resolveFeedPath(ROOT, TOKEN, `/${TOKEN}/%2e%2e/secrets.txt`), null)
    assert.equal(resolveFeedPath(ROOT, TOKEN, `/${TOKEN}/%2E%2E%2Fsecrets.txt`), null)
  })

  test('rejects_windows_backslash_and_drive_letter_segments', () => {
    // On win32 resolve() treats "\" as a separator and "C:x" as drive-relative.
    assert.equal(resolveFeedPath(ROOT, TOKEN, `/${TOKEN}/..%5Csecrets.txt`), null)
    assert.equal(resolveFeedPath(ROOT, TOKEN, `/${TOKEN}/C:secrets.txt`), null)
    assert.equal(resolveFeedPath(ROOT, TOKEN, `/${TOKEN}/C:%5CWindows%5Cwin.ini`), null)
  })

  test('rejects_malformed_percent_encoding', () => {
    assert.equal(resolveFeedPath(ROOT, TOKEN, `/${TOKEN}/%E0%A4%A.yml`), null)
  })

  test('rejects_empty_and_dot_segments', () => {
    assert.equal(resolveFeedPath(ROOT, TOKEN, `/${TOKEN}//latest.yml`), null)
    assert.equal(resolveFeedPath(ROOT, TOKEN, `/${TOKEN}/./latest.yml`), null)
  })

  test('resolved_path_always_stays_under_root', () => {
    const result = resolveFeedPath(ROOT, TOKEN, `/${TOKEN}/1.0.65/mac/app.zip`)
    assert.ok(result !== null)
    assert.ok(result!.startsWith(ROOT + sep))
  })
})

// ── Server integration ──

describe('update-feed-server — HTTP behaviour', () => {
  test('serves_manifests_artifacts_ranges_and_gates_by_token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-feed-'))
    mkdirSync(join(dir, '1.0.65', 'mac'), { recursive: true })

    const manifest = 'version: 1.0.65\npath: 1.0.65/mac/Code Atelier-1.0.65-arm64-mac.zip\n'
    writeFileSync(join(dir, 'latest-mac.yml'), manifest)

    const artifact = Buffer.from('0123456789abcdef')
    const artifactName = 'Code Atelier-1.0.65-arm64-mac.zip'
    writeFileSync(join(dir, '1.0.65', 'mac', artifactName), artifact)

    // A file the server must never expose (sits outside the served root).
    const outsideDir = mkdtempSync(join(tmpdir(), 'update-feed-outside-'))
    writeFileSync(join(outsideDir, 'secrets.txt'), 'do-not-serve')

    const server = await startUpdateFeedServer(dir)
    try {
      assert.ok(
        server.url.startsWith('http://127.0.0.1:'),
        `feed must be loopback http, got ${server.url}`
      )
      assert.ok(server.url.endsWith('/'), 'base URL needs a trailing slash to keep the token')

      // Channel file — the request electron-updater makes first.
      const ymlRes = await fetch(`${server.url}latest-mac.yml?noCache=xyz`)
      assert.equal(ymlRes.status, 200)
      assert.equal(await ymlRes.text(), manifest)

      // Artifact with spaces in a nested version folder.
      const artifactUrl = `${server.url}1.0.65/mac/${encodeURIComponent(artifactName)}`
      const artifactRes = await fetch(artifactUrl)
      assert.equal(artifactRes.status, 200)
      assert.equal(artifactRes.headers.get('content-length'), String(artifact.length))
      assert.equal(Buffer.from(await artifactRes.arrayBuffer()).toString(), artifact.toString())

      // HEAD — body empty, length still advertised.
      const headRes = await fetch(artifactUrl, { method: 'HEAD' })
      assert.equal(headRes.status, 200)
      assert.equal(headRes.headers.get('content-length'), String(artifact.length))
      assert.equal((await headRes.text()).length, 0)

      // Range — 206 with the exact slice.
      const rangeRes = await fetch(artifactUrl, { headers: { Range: 'bytes=4-7' } })
      assert.equal(rangeRes.status, 206)
      assert.equal(rangeRes.headers.get('content-range'), `bytes 4-7/${artifact.length}`)
      assert.equal(await rangeRes.text(), '4567')

      // Suffix range — last 3 bytes.
      const suffixRes = await fetch(artifactUrl, { headers: { Range: 'bytes=-3' } })
      assert.equal(suffixRes.status, 206)
      assert.equal(await suffixRes.text(), 'def')

      // Unsatisfiable range falls back to a plain 200 rather than erroring.
      const badRangeRes = await fetch(artifactUrl, { headers: { Range: 'bytes=999-' } })
      assert.equal(badRangeRes.status, 200)

      // Wrong token — 404, even though the file exists.
      const base = server.url.slice(0, server.url.lastIndexOf('/', server.url.length - 2) + 1)
      const wrongToken = await fetch(`${base}${'f'.repeat(32)}/latest-mac.yml`)
      assert.equal(wrongToken.status, 404)

      // No token at all — 404.
      const noToken = await fetch(`http://127.0.0.1:${new URL(server.url).port}/latest-mac.yml`)
      assert.equal(noToken.status, 404)

      // Traversal to a real file outside the root — 404, not its contents.
      const traversal = await fetch(`${server.url}..%2F..%2Fetc%2Fhosts`)
      assert.equal(traversal.status, 404)

      // Directory request — 404 (no listings).
      const dirRes = await fetch(`${server.url}1.0.65/mac`)
      assert.equal(dirRes.status, 404)

      // Missing file — 404.
      const missing = await fetch(`${server.url}nope.yml`)
      assert.equal(missing.status, 404)

      // Write methods rejected.
      const post = await fetch(`${server.url}latest-mac.yml`, { method: 'POST' })
      assert.equal(post.status, 405)
    } finally {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  test('close_releases_the_port', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-feed-close-'))
    writeFileSync(join(dir, 'latest.yml'), 'version: 1.0.65\n')

    const server = await startUpdateFeedServer(dir)
    const url = `${server.url}latest.yml`
    assert.equal((await fetch(url)).status, 200)

    await server.close()
    await assert.rejects(() => fetch(url), 'server should refuse connections once closed')

    rmSync(dir, { recursive: true, force: true })
  })

  test('manifest_referencing_a_missing_artifact_404s_on_download', async () => {
    // The failure we were blind to: a published manifest whose url points at a
    // file that was never copied (or was copied under a different name — the
    // macOS zip is written with spaces but referenced by its hyphenated safe
    // name). The channel file fetches fine, so the check reports "update
    // available" and only the download fails.
    const dir = mkdtempSync(join(tmpdir(), 'update-feed-missing-'))
    mkdirSync(join(dir, '1.0.66', 'mac'), { recursive: true })

    const referenced = '1.0.66/mac/Code-Atelier-1.0.66-arm64-mac.zip'
    writeFileSync(join(dir, 'latest-mac.yml'), `version: 1.0.66\npath: ${referenced}\n`)
    // Published under the *unsafe* name — the exact mismatch that shipped.
    writeFileSync(join(dir, '1.0.66', 'mac', 'Code Atelier-1.0.66-arm64-mac.zip'), 'zip')

    const server = await startUpdateFeedServer(dir)
    try {
      const manifestRes = await fetch(`${server.url}latest-mac.yml`)
      assert.equal(manifestRes.status, 200, 'the check itself succeeds — that is the trap')

      const downloadRes = await fetch(`${server.url}${referenced}`)
      assert.equal(downloadRes.status, 404, 'referenced artifact is absent under that name')
    } finally {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('two_servers_get_distinct_tokens_and_ports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-feed-multi-'))
    writeFileSync(join(dir, 'latest.yml'), 'version: 1.0.65\n')

    const a = await startUpdateFeedServer(dir)
    const b = await startUpdateFeedServer(dir)
    try {
      assert.notEqual(a.url, b.url)
      assert.notEqual(new URL(a.url).port, new URL(b.url).port)
      assert.notEqual(new URL(a.url).pathname, new URL(b.url).pathname)
    } finally {
      await a.close()
      await b.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
