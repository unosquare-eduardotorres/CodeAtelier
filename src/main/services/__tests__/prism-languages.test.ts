/**
 * Unit tests for the shared prism language map + lazy grammar loader.
 *
 * prism-languages.ts is the single source of truth for extension → language
 * and fence-tag → language resolution across CodeBlock, FileViewerPanel and
 * the diff viewers. These tests pin:
 *  - EXT_TO_LANG covers every extension the file-icon map knows about (a new
 *    icon entry without a language mapping would silently highlight nothing).
 *  - Fence-tag aliases resolve the way models actually write them.
 *  - ensurePrismLanguage dedupes concurrent loads, caches results, and
 *    resolves synchronously-available languages instantly.
 *  - A real grammar (ruby) registers onto the vendored Prism instance.
 *
 * Pure logic — no DOM, no React — so it runs from the main-process harness.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { EXT_TO_ICON_NAME } from '../../../renderer/src/components/common/file-language-icons'
import {
  EXT_TO_LANG,
  FENCE_TAG_ALIASES,
  KNOWN_LANGUAGES,
  VENDORED_LANGUAGES,
  ensurePrismLanguage,
  isLanguageReady,
  languageForFenceTag,
  languageForPath
} from '../../../renderer/src/utils/prism-languages'

describe('EXT_TO_LANG completeness', () => {
  test('covers_every_icon_extension', () => {
    const missing = Object.keys(EXT_TO_ICON_NAME).filter((ext) => !(ext in EXT_TO_LANG))
    assert.deepEqual(
      missing,
      [],
      `extensions with an icon but no language mapping: ${missing.join(', ')}`
    )
  })

  test('maps_core_extensions_correctly', () => {
    assert.equal(EXT_TO_LANG.ts, 'typescript')
    assert.equal(EXT_TO_LANG.tsx, 'tsx')
    assert.equal(EXT_TO_LANG.py, 'python')
    assert.equal(EXT_TO_LANG.rb, 'ruby')
    assert.equal(EXT_TO_LANG.rs, 'rust')
    assert.equal(EXT_TO_LANG.go, 'go')
    assert.equal(EXT_TO_LANG.java, 'java')
    assert.equal(EXT_TO_LANG.dart, 'dart')
    assert.equal(EXT_TO_LANG.scala, 'scala')
    assert.equal(EXT_TO_LANG.toml, 'toml')
    assert.equal(EXT_TO_LANG.dockerfile, 'docker')
  })

  test('binary_types_fall_back_to_text', () => {
    for (const ext of ['png', 'jpg', 'pdf', 'zip', 'wasm']) {
      assert.equal(EXT_TO_LANG[ext], 'text', `${ext} should map to plain text`)
    }
  })
})

describe('languageForPath', () => {
  test('resolves_extension_from_path', () => {
    assert.equal(languageForPath('src/main/foo.ts'), 'typescript')
    assert.equal(languageForPath('app.rb'), 'ruby')
    assert.equal(languageForPath('lib/model.ex'), 'elixir')
  })

  test('handles_dotfiles', () => {
    assert.equal(languageForPath('.gitignore'), 'bash')
    assert.equal(languageForPath('.env'), 'ini')
  })

  test('handles_basename_specials', () => {
    assert.equal(languageForPath('Dockerfile'), 'docker')
    assert.equal(languageForPath('Makefile'), 'makefile')
  })

  test('unknown_extension_returns_empty', () => {
    assert.equal(languageForPath('data.xyzunknown'), '')
  })
})

describe('languageForFenceTag', () => {
  test('resolves_common_model_aliases', () => {
    assert.equal(languageForFenceTag('ts'), 'typescript')
    assert.equal(languageForFenceTag('tsx'), 'tsx')
    assert.equal(languageForFenceTag('js'), 'javascript')
    assert.equal(languageForFenceTag('py'), 'python')
    assert.equal(languageForFenceTag('sh'), 'bash')
    assert.equal(languageForFenceTag('shell'), 'bash')
    assert.equal(languageForFenceTag('yml'), 'yaml')
    assert.equal(languageForFenceTag('rs'), 'rust')
    assert.equal(languageForFenceTag('golang'), 'go')
    assert.equal(languageForFenceTag('c#'), 'csharp')
  })

  test('passes_canonical_tags_through', () => {
    assert.equal(languageForFenceTag('typescript'), 'typescript')
    assert.equal(languageForFenceTag('ruby'), 'ruby')
    assert.equal(languageForFenceTag('bash'), 'bash')
  })

  test('unknown_tag_returns_empty', () => {
    assert.equal(languageForFenceTag('no-such-lang'), '')
  })

  test('fence_aliases_are_subset_of_known_languages', () => {
    // Every alias must resolve to something the loader can satisfy — either
    // vendored or a prismjs chunk.
    for (const target of Object.values(FENCE_TAG_ALIASES)) {
      assert.ok(
        KNOWN_LANGUAGES.has(target),
        `fence alias target "${target}" is neither vendored nor loadable`
      )
    }
  })
})

describe('ensurePrismLanguage', () => {
  test('vendored_language_resolves_true_without_load', async () => {
    assert.equal(await ensurePrismLanguage('typescript'), true)
    assert.equal(await ensurePrismLanguage('markup'), true)
    assert.equal(isLanguageReady('typescript'), true)
  })

  test('unknown_language_resolves_false_and_is_cached', async () => {
    assert.equal(await ensurePrismLanguage('no-such-language'), false)
    // Second call must not retry (negative cache) — still false, immediately.
    assert.equal(await ensurePrismLanguage('no-such-language'), false)
  })

  test('empty_id_resolves_false', async () => {
    assert.equal(await ensurePrismLanguage(''), false)
  })

  test('concurrent_loads_share_one_import', async () => {
    // Fire several concurrent ensures for the same non-vendored language —
    // the in-flight map must dedupe them (all resolve, no throw).
    const results = await Promise.all([
      ensurePrismLanguage('lua'),
      ensurePrismLanguage('lua'),
      ensurePrismLanguage('lua')
    ])
    assert.deepEqual(results, [true, true, true])
    assert.equal(isLanguageReady('lua'), true)
  })

  test('loads_real_grammar_onto_prism_instance', async () => {
    // ruby is not vendored by prism-react-renderer — the loader must import
    // the prismjs chunk and register it on the shared instance.
    assert.equal(VENDORED_LANGUAGES.has('ruby'), false)
    assert.equal(await ensurePrismLanguage('ruby'), true)
    assert.equal(isLanguageReady('ruby'), true)
    // Loaded languages stay cached across calls.
    assert.equal(await ensurePrismLanguage('ruby'), true)
  })

  test('dependency_chain_loads_scala_via_java', async () => {
    // scala's grammar extends java — the loader must pull the dep first.
    assert.equal(await ensurePrismLanguage('scala'), true)
    assert.equal(isLanguageReady('java'), true)
    assert.equal(isLanguageReady('scala'), true)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
