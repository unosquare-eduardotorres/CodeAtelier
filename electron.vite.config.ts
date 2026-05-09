import { resolve } from 'path'
import { cpSync } from 'fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
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
          cpSync(
            resolve('node_modules/repomap-mcp/queries'),
            resolve('out/queries'),
            { recursive: true }
          )
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
