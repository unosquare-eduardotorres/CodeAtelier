import { resolve } from 'path'
import { cpSync } from 'fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        // Stub out native-addon packages that @huggingface/transformers imports
        // unconditionally but we never use at runtime:
        //
        // onnxruntime-node — transformers does `require("onnxruntime-node")` at
        //   module load time even though our patch routes to onnxruntime-web (WASM).
        //   Without this stub Vite bundles the native .node binding loader → crash.
        //
        // sharp — transformers bundles sharp for image processing pipelines.
        //   We only use text embeddings (feature-extraction), never images.
        //   sharp's native addon has the same dynamic-require problem.
        'onnxruntime-node': resolve('src/main/stubs/empty-module.ts'),
        sharp: resolve('src/main/stubs/empty-module.ts')
      }
    },
    build: {
      rollupOptions: {
        // Multiple entry points: main process + utility process + MCP servers.
        // The embedding-worker runs in an Electron utilityProcess (separate V8
        // isolate) so WASM inference doesn't block the main thread.
        // MCP servers run as child processes spawned by the CLI executor and
        // must be available as standalone JS files in out/main/mcp-servers/.
        input: {
          index: resolve('src/main/index.ts'),
          'embedding-worker': resolve('src/main/services/embedding-worker.ts'),
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
