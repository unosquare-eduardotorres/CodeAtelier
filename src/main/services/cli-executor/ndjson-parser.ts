/**
 * NDJSON (Newline-Delimited JSON) parser for Claude CLI interactive mode.
 *
 * Reads raw bytes from a readable stream (stdout) and yields parsed JSON objects.
 * Handles partial lines across chunk boundaries by buffering until a newline.
 *
 * The Claude CLI with `--output-format stream-json` emits one JSON object per line.
 * Each object has a `type` field matching the same NDJSON event types the Agent SDK
 * uses internally (system, assistant, stream_event, user, result, tool_progress, etc.)
 * so the existing stream-normalizer can consume them unchanged.
 */

import { Readable } from 'node:stream'
import log from 'electron-log'

/**
 * Async generator that reads from a Node Readable stream and yields
 * parsed JSON objects, one per NDJSON line.
 *
 * Handles:
 * - Partial lines split across chunks (buffered until newline)
 * - Empty lines (skipped)
 * - Malformed JSON lines (logged + skipped, never throws)
 * - Stream end (flushes any remaining buffer)
 */
export async function* parseNdjsonStream(
  stream: Readable,
  log?: { warn: (msg: string) => void }
): AsyncGenerator<Record<string, unknown>> {
  let buffer = ''

  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf-8')

    // Process all complete lines in the buffer
    let newlineIdx: number
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim()
      buffer = buffer.slice(newlineIdx + 1)

      if (!line) continue // skip empty lines

      try {
        yield JSON.parse(line) as Record<string, unknown>
      } catch (err) {
        log?.warn(
          `[ndjson-parser] Malformed JSON line (${line.length} chars): ${line.slice(0, 120)}`
        )
        // Emit structured parse error so downstream can display it
        yield {
          type: 'parse_error',
          raw: line.slice(0, 200),
          error: (err as Error).message
        }
      }
    }
  }

  // Flush any remaining buffer (partial line at stream end)
  const remaining = buffer.trim()
  if (remaining) {
    try {
      yield JSON.parse(remaining) as Record<string, unknown>
    } catch (err) {
      log?.warn(`[ndjson-parser] Malformed final line: ${remaining.slice(0, 120)}`)
      yield {
        type: 'parse_error',
        raw: remaining.slice(0, 200),
        error: (err as Error).message
      }
    }
  }
}

const ndjsonLog = log.scope('ndjson-parser')

/**
 * Write a JSON message to a writable stream as an NDJSON line.
 * Used for writing user messages to the CLI's stdin.
 *
 * Returns true if the write was accepted by the kernel buffer.
 * Returns false if the buffer is full (backpressure) or the stream errored.
 * Callers should check the return value for critical messages.
 */
export function writeNdjsonMessage(
  stream: NodeJS.WritableStream,
  message: Record<string, unknown>
): boolean {
  try {
    const json = JSON.stringify(message) + '\n'
    const accepted = stream.write(json)
    if (!accepted) {
      ndjsonLog.warn(
        `[ndjson:backpressure] stdin buffer full — message queued (type=${message.type ?? 'unknown'}, len=${json.length})`
      )
    }
    return accepted
  } catch (err) {
    ndjsonLog.error(
      `[ndjson:write-error] Failed to write to stdin: ${(err as Error).message} (type=${message.type ?? 'unknown'})`
    )
    return false
  }
}

/**
 * Build a CLI-protocol user message for `--input-format stream-json`.
 *
 * Accepts either a plain text string or pre-built content blocks (for images).
 *
 * The Claude CLI expects:
 * ```json
 * {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
 * ```
 *
 * For images, content blocks include `{ type: 'image', source: { type: 'base64', ... } }`
 * alongside text blocks — same structure as the Anthropic API.
 */
export function buildUserMessage(
  textOrBlocks: string | Array<Record<string, unknown>>
): Record<string, unknown> {
  const content =
    typeof textOrBlocks === 'string'
      ? [{ type: 'text', text: textOrBlocks }]
      : textOrBlocks

  return {
    type: 'user',
    message: {
      role: 'user',
      content
    }
  }
}
