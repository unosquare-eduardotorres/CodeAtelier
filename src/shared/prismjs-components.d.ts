/**
 * Ambient module declarations shared by every tsconfig (node + web + e2e).
 *
 * prismjs language component chunks — @types/prismjs only declares the core
 * module, not the per-language files under components/. Each chunk is a
 * side-effect import that registers its grammar onto the global Prism
 * instance (see src/renderer/src/utils/prism-languages.ts).
 */
declare module 'prismjs/components/prism-*' {
  const grammar: unknown
  export default grammar
}
