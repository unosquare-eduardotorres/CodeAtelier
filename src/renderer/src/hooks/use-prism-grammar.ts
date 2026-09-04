/**
 * usePrismGrammar — shared hook behind lazy prism grammar loading
 * (dedupe of the logic formerly inlined in CodeBlock and FileViewerPanel).
 *
 * Subscribes to grammar-load notifications so the consumer re-renders the
 * moment a prismjs chunk registers, and kicks off the load for the requested
 * language. Returns readiness; consumers pass `ready ? language : 'text'` to
 * <Highlight> so first paint is never blocked on a chunk fetch.
 */
import { useEffect, useSyncExternalStore } from 'react'
import {
  ensurePrismLanguage,
  getLoadedLanguageCount,
  isLanguageReady,
  subscribePrismLanguages
} from '@renderer/utils/prism-languages'

/** Languages that need no grammar — plain rendering, nothing to load. */
const PLAIN_LANGUAGES = new Set(['', 'text'])

/**
 * Ensure the prism grammar for `language` is (or becomes) available.
 * Returns true when tokenization can proceed right now.
 */
export function usePrismGrammar(language: string): boolean {
  const wanted = !PLAIN_LANGUAGES.has(language)
  useSyncExternalStore(subscribePrismLanguages, getLoadedLanguageCount)
  useEffect(() => {
    if (wanted && !isLanguageReady(language)) {
      void ensurePrismLanguage(language)
    }
  }, [language, wanted])
  return !wanted || isLanguageReady(language)
}
