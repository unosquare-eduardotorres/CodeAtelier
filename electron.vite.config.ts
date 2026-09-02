import { dirname, join, resolve } from 'path'
import { cpSync } from 'fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { MCP_STANDALONE_SHIM } from './src/main/mcp-servers/standalone-shim'

export default defineConfig({
  main: {
    assetsInclude: ['**/*.sql'],
    build: {
      rollupOptions: {
        // Multiple entry points: main process + MCP servers. MCP servers run as
        // child processes spawned by the CLI executor and must be available as
        // standalone JS files in out/main/mcp-servers/.
        input: {
          index: resolve('src/main/index.ts'),
          'mcp-servers/code-graph-server': resolve('src/main/mcp-servers/code-graph-server.ts'),
          'mcp-servers/control-actions-server': resolve(
            'src/main/mcp-servers/control-actions-server.ts'
          ),
          'mcp-servers/git-context-server': resolve('src/main/mcp-servers/git-context-server.ts'),
          'mcp-servers/semantic-search-server': resolve(
            'src/main/mcp-servers/semantic-search-server.ts'
          ),
          'mcp-servers/code-analysis-server': resolve(
            'src/main/mcp-servers/code-analysis-server.ts'
          ),
          'mcp-servers/memory-server': resolve('src/main/mcp-servers/memory-server.ts'),
          'mcp-servers/recall-server': resolve('src/main/mcp-servers/recall-server.ts'),
          'mcp-servers/process-manager-server': resolve(
            'src/main/mcp-servers/process-manager-server.ts'
          ),
          'mcp-servers/jira-server': resolve('src/main/mcp-servers/jira-server.ts')
        }
      }
    },
    plugins: [
      {
        name: 'copy-tree-sitter-assets',
        writeBundle(options, bundle) {
          // repomap-mcp + web-tree-sitter are bundled by Vite (ESM→CJS).
          // web-tree-sitter's Emscripten loader resolves the runtime relative to
          // its OWN file: new URL("tree-sitter.wasm", pathToFileURL(__filename)).
          // Rollup decides where that file lands (currently out/main/chunks/), so
          // derive the destination from the emitted bundle instead of hardcoding a
          // directory — a hardcoded 'out/main' is exactly what broke in v1.0.69.
          // queries/ is separate: resolved via __dirname + "../queries" → out/queries/
          const outDir = options.dir ?? resolve('out/main')
          const wasmSrc = resolve('node_modules/web-tree-sitter/tree-sitter.wasm')

          const targets = new Set<string>([outDir])
          for (const [fileName, output] of Object.entries(bundle)) {
            if (output.type === 'chunk' && output.code.includes('tree-sitter.wasm')) {
              targets.add(dirname(resolve(outDir, fileName)))
            }
          }
          for (const dir of targets) cpSync(wasmSrc, join(dir, 'tree-sitter.wasm'))

          cpSync(resolve('node_modules/repomap-mcp/queries'), resolve('out/queries'), {
            recursive: true
          })
          // Blueprint prompt/template markdown files — needed at runtime by blueprint-prompt-loader
          cpSync(resolve('src/main/blueprints'), resolve('out/main/blueprints'), {
            recursive: true
          })
        }
      },
      {
        name: 'mcp-server-electron-shim',
        renderChunk(code, chunk) {
          // Only instrument MCP server entry points
          if (!chunk.fileName.startsWith('mcp-servers/') || !chunk.isEntry) return null

          // Insert after shebang + "use strict" but before any require()
          const lines = code.split('\n')
          let insertAt = 0
          if (lines[0]?.startsWith('#!')) insertAt = 1
          if (lines[insertAt]?.trim() === '"use strict";') insertAt++
          // Some entries have Object.defineProperty (e.g. code-analysis-server)
          if (lines[insertAt]?.includes('Object.defineProperty')) insertAt++

          lines.splice(insertAt, 0, MCP_STANDALONE_SHIM)
          return { code: lines.join('\n'), map: null }
        }
      }
    ]
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          splash: resolve('src/renderer/splash.html')
        }
      }
    }
  }
})
