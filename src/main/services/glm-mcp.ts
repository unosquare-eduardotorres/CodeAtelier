/**
 * GLM-hosted remote MCP servers (Web Search Prime, Web Reader).
 *
 * These are HTTP MCP endpoints run by Z.ai, not local processes — they mount as
 * OpenCode `type: 'remote'` entries with a Bearer header. The stdio Vision server is
 * NOT here: it is a normal registry integration (`zai-vision` in
 * EXTERNAL_MCP_INTEGRATIONS) and mounts through the external-MCP path.
 *
 * Every tool call on these servers is credit-billed against the Coding Plan, so
 * nothing mounts unless the workspace explicitly turned it on.
 */

import { GLM_REMOTE_MCP_SERVERS } from '../../shared/constants'
import type { GlmMcpServerId } from '../../shared/types'

/** Shape consumed by `OpenCodeConfigWriterOptions.remoteMcpServers`. */
export interface RemoteMcpServerEntry {
  url: string
  headers?: Record<string, string>
  enabled?: boolean
}

/**
 * Build the remote MCP entries for a GLM workspace.
 *
 * Returns `undefined` when nothing should mount, so the caller can leave the
 * writer option unset rather than passing an empty object.
 *
 * An API key is required: these endpoints authenticate with `Authorization: Bearer`.
 * A proxy-mode workspace that keeps its key inside the proxy has no key to send, so
 * the servers stay unmounted rather than mounting and failing on every call.
 */
export function buildGlmRemoteMcpServers(
  glmMcpActive: Partial<Record<GlmMcpServerId, boolean>> | undefined,
  apiKey: string | undefined
): Record<string, RemoteMcpServerEntry> | undefined {
  if (!glmMcpActive || !apiKey) return undefined

  const servers: Record<string, RemoteMcpServerEntry> = {}
  for (const def of GLM_REMOTE_MCP_SERVERS) {
    if (!glmMcpActive[def.id]) continue
    servers[def.serverName] = {
      url: def.url,
      headers: { Authorization: `Bearer ${apiKey}` }
    }
  }

  return Object.keys(servers).length > 0 ? servers : undefined
}
