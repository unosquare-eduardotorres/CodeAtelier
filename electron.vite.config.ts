import { resolve } from 'path'
import { cpSync } from 'fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
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
          'mcp-servers/checkpoint-context-server': resolve(
            'src/main/mcp-servers/checkpoint-context-server.ts'
          ),
          'mcp-servers/github-context-server': resolve(
            'src/main/mcp-servers/github-context-server.ts'
          )
        }
      }
    },
    plugins: [
      {
        name: 'copy-tree-sitter-assets',
        writeBundle() {
          // repomap-mcp + web-tree-sitter are bundled by Vite (ESM→CJS).
          // The bundled code resolves paths relative to the output file:
          //   tree-sitter.wasm  → out/main/tree-sitter.wasm   (via import.meta.url)
          //   queries/          → out/queries/                 (via __dirname + "../queries")
          cpSync(
            resolve('node_modules/web-tree-sitter/tree-sitter.wasm'),
            resolve('out/main/tree-sitter.wasm')
          )
          cpSync(resolve('node_modules/repomap-mcp/queries'), resolve('out/queries'), {
            recursive: true
          })
          // Blueprint prompt/template markdown files — needed at runtime by blueprint-prompt-loader
          cpSync(resolve('src/main/blueprints'), resolve('out/main/blueprints'), {
            recursive: true
          })
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
