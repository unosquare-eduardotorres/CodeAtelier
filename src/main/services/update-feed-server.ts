/**
 * Loopback HTTP server for cloud-drive update feeds.
 *
 * electron-updater's generic provider fetches every request through
 * `electron.net.request`, which only supports http:/https:. Handing it a
 * `file://` URL throws "ClientRequest only supports http: and https: protocols"
 * on every check (and on Windows the URL is doubly invalid — backslashes and a
 * drive letter). Serving the synced folder over 127.0.0.1 puts electron-updater
 * back on its fully supported HTTP code path.
 *
 * This mirrors what electron-updater's own MacUpdater does to feed Squirrel.Mac.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface FeedServerHandle {
  /** Base URL with trailing slash, e.g. http://127.0.0.1:51234/<token>/ */
  url: string
  /** Absolute directory being served */
  root: string
  close: () => Promise<void>
}

/** Reject a decoded path segment that could escape the served root. */
function isUnsafeSegment(segment: string): boolean {
  return (
    segment.length === 0 ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    // Windows treats "\" as a separator and "C:" as a drive-relative root.
    segment.includes('\\') ||
    segment.includes('\0') ||
    /^[a-zA-Z]:/.test(segment)
  )
}

/**
 * Map a request URL to an absolute path inside `rootDir`.
 * Returns null when the request is outside the token prefix, malformed, or
 * attempts to traverse out of the root.
 *
 * Exported for unit testing.
 */
export function resolveFeedPath(rootDir: string, token: string, requestUrl: string): string | null {
  // electron-updater appends a ?noCache=… query to channel-file requests.
  const pathOnly = requestUrl.split('?')[0].split('#')[0]

  const prefix = `/${token}/`
  if (!pathOnly.startsWith(prefix)) return null

  const rest = pathOnly.slice(prefix.length)
  if (rest.length === 0) return null

  const segments: string[] = []
  for (const raw of rest.split('/')) {
    let decoded: string
    try {
      // Artifact names contain spaces ("Code Atelier-1.0.64-arm64-mac.zip"),
      // which electron-updater percent-encodes.
      decoded = decodeURIComponent(raw)
    } catch {
      return null // malformed percent-encoding
    }
    if (isUnsafeSegment(decoded)) return null
    segments.push(decoded)
  }

  const root = resolve(rootDir)
  const target = resolve(join(root, ...segments))
  // Defence in depth — segment filtering should already prevent this.
  if (!target.startsWith(root + sep)) return null
  return target
}

/** Parse a single-range `Range` header. Returns null when absent/unsupported. */
function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match

  let start: number
  let end: number
  if (rawStart === '') {
    // Suffix range: last N bytes
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

function handleRequest(
  root: string,
  token: string,
  req: IncomingMessage,
  res: ServerResponse
): void {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' })
    res.end()
    return
  }

  const filePath = resolveFeedPath(root, token, req.url ?? '')
  if (!filePath) {
    res.writeHead(404)
    res.end()
    return
  }

  void stat(filePath)
    .then((stats) => {
      if (!stats.isFile()) {
        res.writeHead(404)
        res.end()
        return
      }

      const size = stats.size
      const range = parseRange(req.headers.range, size)
      const start = range ? range.start : 0
      const end = range ? range.end : size - 1
      const length = size === 0 ? 0 : end - start + 1

      const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(length),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      }
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`

      res.writeHead(range ? 206 : 200, headers)

      if (method === 'HEAD' || length === 0) {
        res.end()
        return
      }

      const stream = createReadStream(filePath, { start, end })
      stream.on('error', () => res.destroy())
      res.on('close', () => stream.destroy())
      stream.pipe(res)
    })
    .catch(() => {
      res.writeHead(404)
      res.end()
    })
}

/**
 * Start a read-only static server bound to 127.0.0.1 on an ephemeral port.
 * All paths are namespaced under a random token so other local processes can't
 * enumerate the served folder.
 */
export function startUpdateFeedServer(rootDir: string): Promise<FeedServerHandle> {
  const root = resolve(rootDir)
  const token = randomBytes(16).toString('hex')

  return new Promise<FeedServerHandle>((resolvePromise, rejectPromise) => {
    const server: Server = createServer((req, res) => handleRequest(root, token, req, res))

    const onStartupError = (err: Error): void => {
      server.close()
      rejectPromise(err)
    }
    server.once('error', onStartupError)

    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onStartupError)
      // Post-startup errors must not crash the app.
      server.on('error', () => {})

      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        rejectPromise(new Error('Update feed server failed to bind to a port'))
        return
      }

      resolvePromise({
        // Trailing slash matters: electron-updater resolves the channel file
        // relative to this base, and a missing slash would drop the token.
        url: `http://127.0.0.1:${address.port}/${token}/`,
        root,
        close: () =>
          new Promise<void>((done) => {
            // Keep-alive sockets would otherwise hold close() open.
            server.closeAllConnections?.()
            server.close(() => done())
          })
      })
    })
  })
}
