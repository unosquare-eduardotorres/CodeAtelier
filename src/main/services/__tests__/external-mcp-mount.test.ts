/**
 * External MCP mounting — the SDK path inside workspace-mcp-config.
 *
 * `mountExternalMcps` is where an integration actually becomes a child process:
 * it decides bundled-vs-PATH command resolution, applies the missing-credential
 * skip, and injects the resolved env. Only the pure allow/disallow list builder
 * was covered before; this file exercises the mount itself.
 *
 * Credentials are supplied through the shell-env fallback so the test needs no
 * database — the same path a user who exports JIRA_* takes.
 *
 * Run: tsx src/main/services/__tests__/external-mcp-mount.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupFullMock, evictFromCache } from './setup-full-mock'
import { EXTERNAL_MCP_INTEGRATIONS, MCP_TOOLS } from '../../../shared/constants'

setupFullMock()

// Re-bind through the mock loader in case an earlier file in a shared run cached
// these modules against the real repositories.
evictFromCache('services/integration-credentials')
evictFromCache('services/workspace-mcp-config')

const { buildWorkspaceMcpConfig } =
  require('../workspace-mcp-config') as typeof import('../workspace-mcp-config')

const NOOP_CALLBACKS = {
  emitPlan: () => {},
  askUser: () => Promise.resolve(''),
  emitMemory: () => {}
} as any

const SHELL_JIRA = {
  JIRA_BASE_URL: 'https://jira.acme.internal',
  JIRA_AUTH_MODE: 'pat',
  JIRA_API_TOKEN: 'shell-tok'
}

/** Run `fn` with the given vars exported, restoring the environment afterwards. */
function withShellEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k]
    process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function build(
  overrides: {
    mode?: 'plan' | 'build'
    externalMcpActive?: Record<string, boolean>
    isLocalProvider?: boolean
    contextTier?: 'small' | 'medium' | 'large'
  } = {}
): ReturnType<typeof buildWorkspaceMcpConfig> {
  const { mode = 'build', externalMcpActive = {}, ...rest } = overrides
  return buildWorkspaceMcpConfig({
    mode,
    workspacePath: '/tmp/test-ws',
    // null → no DB access; credentials come from the shell fallback
    workspaceId: null,
    conversationId: 'conv-1',
    featureFlags: {
      repomapEnabled: false,
      semanticSearchEnabled: false,
      githubConfigured: false,
      externalMcpActive,
      localMcpActive: {}
    },
    controlCallbacks: NOOP_CALLBACKS,
    ...rest
  } as any)
}

// ── Credential gate ──

describe('mountExternalMcps — credential gate', () => {
  test('active but unconfigured integration is not mounted', () => {
    const result = build({ externalMcpActive: { jira: true } })
    assert.equal(
      result.mcpServers?.jira,
      undefined,
      'mounting a server that cannot authenticate stalls session start on the handshake'
    )
  })

  test('unconfigured integration contributes no tool names either', () => {
    const result = build({ mode: 'plan', externalMcpActive: { jira: true } })
    for (const name of MCP_TOOLS.JIRA._ALL_NAMES) {
      assert.equal(
        result.allowedTools?.includes(name),
        false,
        `${name} must not be allowed when the server was skipped`
      )
    }
  })

  test('shell-configured integration is mounted', () => {
    withShellEnv(SHELL_JIRA, () => {
      const result = build({ externalMcpActive: { jira: true } })
      assert.ok(result.mcpServers?.jira, 'shell-exported credentials must satisfy the mount gate')
    })
  })

  test('inactive integration is never mounted, however well configured', () => {
    withShellEnv(SHELL_JIRA, () => {
      assert.equal(build({ externalMcpActive: { jira: false } }).mcpServers, undefined)
      assert.equal(build({ externalMcpActive: {} }).mcpServers, undefined)
    })
  })
})

// ── Bundled server resolution ──

describe('mountExternalMcps — bundled server entry', () => {
  test('bundled entry becomes `node <basePath>/<entry>.js`, never a PATH lookup', () => {
    withShellEnv(SHELL_JIRA, () => {
      const jira = build({ externalMcpActive: { jira: true } }).mcpServers!.jira
      assert.equal(jira.command, 'node')
      assert.equal(jira.args.length, 1)
      assert.match(jira.args[0], /mcp-servers[/\\]jira-server\.js$/)
      assert.equal(jira.type, 'stdio')
      assert.equal(jira.alwaysLoad, true, 'tools must not be deferred behind ToolSearch')
    })
  })

  test('resolved credentials reach the child env', () => {
    withShellEnv(SHELL_JIRA, () => {
      const env = build({ externalMcpActive: { jira: true } }).mcpServers!.jira.env!
      assert.equal(env.JIRA_BASE_URL, 'https://jira.acme.internal')
      assert.equal(env.JIRA_AUTH_MODE, 'pat')
      assert.equal(env.JIRA_API_TOKEN, 'shell-tok')
    })
  })

  test('only declared env keys are forwarded', () => {
    withShellEnv({ ...SHELL_JIRA, SOME_UNRELATED_SECRET: 'nope' }, () => {
      const env = build({ externalMcpActive: { jira: true } }).mcpServers!.jira.env!
      assert.equal(env.SOME_UNRELATED_SECRET, undefined)
    })
  })

  test('fields hidden by the auth mode are not leaked to the child', () => {
    withShellEnv({ ...SHELL_JIRA, JIRA_EMAIL: 'jane@acme.com' }, () => {
      const env = build({ externalMcpActive: { jira: true } }).mcpServers!.jira.env!
      assert.equal(env.JIRA_EMAIL, undefined, 'email is hidden in pat mode')
    })
  })
})

// ── Tool exposure ──

describe('mountExternalMcps — tool exposure', () => {
  test('plan mode exposes the read tools', () => {
    withShellEnv(SHELL_JIRA, () => {
      const result = build({ mode: 'plan', externalMcpActive: { jira: true } })
      for (const name of [MCP_TOOLS.JIRA.GET_ISSUE.name, MCP_TOOLS.JIRA.SEARCH_ISSUES.name]) {
        assert.ok(result.allowedTools?.includes(name), `${name} missing from plan-mode allowlist`)
      }
    })
  })

  test('plan mode withholds add_comment — planning must not write to Jira', () => {
    withShellEnv(SHELL_JIRA, () => {
      const result = build({ mode: 'plan', externalMcpActive: { jira: true } })
      assert.equal(
        result.allowedTools?.includes(MCP_TOOLS.JIRA.ADD_COMMENT.name),
        false,
        'add_comment mutates a shared ticket; it must never be reachable while planning'
      )
    })
  })

  test('build mode has no allowlist to extend (all tools permitted)', () => {
    withShellEnv(SHELL_JIRA, () => {
      const result = build({ mode: 'build', externalMcpActive: { jira: true } })
      assert.equal(result.allowedTools, undefined)
      assert.ok(result.mcpServers?.jira, 'the server still mounts without an allowlist')
    })
  })

  test('local providers mount external servers too, at every context tier', () => {
    withShellEnv(SHELL_JIRA, () => {
      for (const contextTier of ['small', 'medium', 'large'] as const) {
        const result = build({
          externalMcpActive: { jira: true },
          isLocalProvider: true,
          contextTier
        })
        assert.ok(
          result.mcpServers?.jira,
          `jira must mount for local provider (tier=${contextTier})`
        )
      }
    })
  })
})

// ── Packaged-mode command resolution ──

describe('mountExternalMcps — packaged-mode resolution', () => {
  // SVC-04 makes `resolveStdioCommand` throw rather than fall back to a bare
  // command once packaged. An entry with neither `bundledServerEntry` nor
  // `commandPaths` therefore cannot mount in a real build — and, before the
  // per-integration try/catch, took the entire MCP config down with it.
  test('every PATH-resolved integration declares commandPaths', () => {
    for (const integration of EXTERNAL_MCP_INTEGRATIONS) {
      if (integration.bundledServerEntry) continue
      assert.ok(
        integration.commandPaths && integration.commandPaths.length > 0,
        `${integration.id} resolves "${integration.command}" via PATH but declares no commandPaths — it will throw in a packaged build`
      )
    }
  })

  test('an unresolvable integration is skipped, not fatal to the whole config', () => {
    const { app } = require('electron')
    const vision = EXTERNAL_MCP_INTEGRATIONS.find((i) => i.id === 'zai-vision')!
    const realPaths = vision.commandPaths
    const realPackaged = app.isPackaged

    // Force the throw: packaged, with every candidate path guaranteed absent.
    ;(vision as { commandPaths?: readonly string[] }).commandPaths = [
      '/nonexistent/definitely/not/npx'
    ]
    app.isPackaged = true

    try {
      withShellEnv({ ...SHELL_JIRA, Z_AI_API_KEY: 'k', Z_AI_MODE: 'ZAI' }, () => {
        const result = build({ externalMcpActive: { jira: true, 'zai-vision': true } })

        assert.equal(
          result.mcpServers?.['zai-vision'],
          undefined,
          'the integration that could not resolve must not be mounted'
        )
        assert.ok(
          result.mcpServers?.jira,
          'a sibling integration must survive — one bad entry must not strip MCP from the whole conversation'
        )
      })
    } finally {
      ;(vision as { commandPaths?: readonly string[] }).commandPaths = realPaths
      app.isPackaged = realPackaged
    }
  })
})

// ── Idle-timeout classification ──

describe('external MCP registry — longRunningTools', () => {
  test('only device/farm-driving integrations extend the idle budget', () => {
    const byId = Object.fromEntries(EXTERNAL_MCP_INTEGRATIONS.map((i) => [i.id, i]))
    assert.equal(byId.maestro.longRunningTools, true, 'Maestro flows routinely idle for minutes')
    assert.equal(
      byId.jira.longRunningTools,
      undefined,
      'a 20s REST call that goes silent is hung — it must not wait 30 minutes to fail'
    )
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
