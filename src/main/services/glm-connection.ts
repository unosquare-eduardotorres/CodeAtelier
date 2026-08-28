/**
 * GLM endpoint probe — validates auth and discovers the model catalogue.
 *
 * Runs in the main process, not the renderer: the API key never has to cross into
 * renderer memory, and there is no CORS wall between us and an arbitrary host.
 *
 * The base URL is used EXACTLY as given. `/models` is appended and nothing else —
 * no `/v1` normalisation. Z.ai's Coding Plan endpoint already ends in `/v4`, and a
 * user's local proxy can expose any path layout it likes.
 *
 * Discovery matters beyond a green tick: Z.ai's own documentation disagrees with
 * itself about model IDs (the overview says "GLM-5-Flash", the credit table says
 * `glm-5.3-flash`), so the catalogue must come from the endpoint rather than a
 * hardcoded list that silently rots.
 */

import log from 'electron-log/main'
import type { GlmConnectionResult } from '../../shared/types'

export type { GlmConnectionResult }

const glmLog = log.scope('GlmConnection')

const PROBE_TIMEOUT_MS = 10_000

/** Join a base URL and a path without normalising or rewriting the base. */
function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/models`
}

/**
 * Probe `GET {baseUrl}/models`.
 *
 * An API key is optional: in proxy mode the proxy commonly injects the
 * Authorization header itself, and refusing to probe without a key would make that
 * setup untestable.
 */
export async function testGlmConnection(
  baseUrl: string,
  apiKey?: string
): Promise<GlmConnectionResult> {
  if (!baseUrl?.trim()) {
    return { ok: false, message: 'Enter a base URL first.', models: [], code: 'bad-url' }
  }

  let url: string
  try {
    url = modelsUrl(new URL(baseUrl).toString())
  } catch {
    return {
      ok: false,
      message: `Not a valid URL: ${baseUrl}`,
      models: [],
      code: 'bad-url'
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      signal: controller.signal
    })

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        // The single most common GLM misconfiguration: a Coding Plan key pointed at
        // the pay-as-you-go host, which is the URL in Z.ai's public quick-start page.
        message:
          `Authentication rejected (${response.status}). A Coding Plan key is only valid on ` +
          `the coding endpoint — check the base URL is not the pay-as-you-go one.`,
        models: [],
        code: 'auth-failed',
        probedUrl: url
      }
    }

    if (response.status === 404) {
      return {
        ok: false,
        message: `No /models endpoint at ${url}. Check the base URL path.`,
        models: [],
        code: 'not-found',
        probedUrl: url
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        message: `Endpoint returned ${response.status}.`,
        models: [],
        code: 'network',
        probedUrl: url
      }
    }

    const payload = await response.json()
    const models = extractModelIds(payload)
    const modelLimits = extractModelLimits(payload)
    return {
      ok: true,
      message:
        models.length > 0
          ? `Connected — ${models.length} model${models.length === 1 ? '' : 's'} available.`
          : 'Connected, but the endpoint listed no models.',
      models,
      ...(Object.keys(modelLimits).length > 0 ? { modelLimits } : {}),
      code: 'ok',
      probedUrl: url
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    glmLog.warn(`[glm] probe failed for ${url}:`, err)
    return {
      ok: false,
      message: aborted
        ? `Timed out after ${PROBE_TIMEOUT_MS / 1000}s reaching ${url}.`
        : // Surfacing the URL matters on corporate networks, where a global
          // HTTP(S)_PROXY silently intercepts even loopback calls.
          `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
      models: [],
      code: aborted ? 'timeout' : 'network',
      probedUrl: url
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Pull per-model context/output limits out of a `/models` response, when present.
 *
 * The OpenAI list schema has no limit fields, so every provider that exposes them
 * invented its own name. Only entries that actually report a limit appear in the
 * result — an absent limit must stay absent so the caller falls back to the
 * documented default rather than persisting a zero.
 */
function extractModelLimits(
  payload: unknown
): Record<string, { contextLimit?: number; outputLimit?: number }> {
  const limits: Record<string, { contextLimit?: number; outputLimit?: number }> = {}
  if (!payload || typeof payload !== 'object') return limits
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return limits

  // A limit of 0 or a negative number is not a usable window — treat it as absent.
  const positiveInt = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined

  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id = record.id
    if (typeof id !== 'string' || id.length === 0) continue

    const contextLimit =
      positiveInt(record.context_length) ??
      positiveInt(record.context_window) ??
      positiveInt(record.max_context_length) ??
      positiveInt(record.max_input_tokens)
    const outputLimit =
      positiveInt(record.max_output_tokens) ?? positiveInt(record.max_completion_tokens)

    if (contextLimit === undefined && outputLimit === undefined) continue
    limits[id] = {
      ...(contextLimit !== undefined ? { contextLimit } : {}),
      ...(outputLimit !== undefined ? { outputLimit } : {})
    }
  }
  return limits
}

/** Pull model IDs out of an OpenAI-shaped `{ data: [{ id }] }` list response. */
function extractModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  return data
    .map((entry) =>
      entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined
    )
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}
