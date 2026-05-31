/**
 * Empty module stub for native-addon packages that @huggingface/transformers
 * imports unconditionally but are never used at runtime.
 *
 * Wired via resolve.alias in electron.vite.config.ts for:
 *   - onnxruntime-node — replaced by onnxruntime-web (WASM) via patch-package
 *   - sharp — image processing; unused (we only do text embeddings)
 *
 * Without these stubs, Vite bundles the native .node binding loaders, which
 * use dynamic require() calls that Rollup wraps in a commonjsRequire shim
 * that throws at runtime.
 *
 * Exports both default and named to satisfy CJS (`require()`) and ESM
 * (`import X from` / `import * as X from`) import styles.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = {} as any
export default stub
export {}
