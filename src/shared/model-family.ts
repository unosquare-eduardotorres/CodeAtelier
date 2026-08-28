/**
 * Model-family heuristics for review decorrelation.
 *
 * Two models from the same training family share blind spots: asking Opus to
 * adversarially review Sonnet's output is closer to self-review than to an
 * external audit. The routing panel uses `sameModelFamily` to warn (never to
 * block) when `blueprint:code-review` resolves to the same family as
 * `blueprint:build`.
 *
 * This is deliberately a heuristic on provider + model-id prefix. It is only
 * ever used to surface advice, so a wrong guess costs a spurious hint, never a
 * blocked pipeline.
 */

import type { LLMProvider } from './types'

/** The minimal shape both `ModelRoleAssignment` and `ResolvedAssignment` satisfy. */
export interface ModelIdentity {
  provider: LLMProvider
  modelId: string
}

/**
 * Known model-id prefixes → training family. Longest match wins, so
 * `gpt-oss` beats `gpt` and `codellama` beats `llama`.
 */
const FAMILY_PREFIXES: readonly (readonly [string, string])[] = [
  ['claude', 'anthropic'],
  ['glm', 'zhipu'],
  ['chatglm', 'zhipu'],
  ['codellama', 'meta'],
  ['llama', 'meta'],
  ['qwq', 'qwen'],
  ['qwen', 'qwen'],
  ['gemma', 'google'],
  ['gemini', 'google'],
  ['codegemma', 'google'],
  ['mixtral', 'mistral'],
  ['mistral', 'mistral'],
  ['codestral', 'mistral'],
  ['devstral', 'mistral'],
  ['deepseek', 'deepseek'],
  ['phi', 'microsoft'],
  ['gpt-oss', 'openai'],
  ['gpt', 'openai'],
  ['o1', 'openai'],
  ['o3', 'openai'],
  ['granite', 'ibm'],
  ['command-r', 'cohere'],
  ['yi', 'zeroone'],
  ['fable', 'fable'],
  ['kimi', 'moonshot'],
  ['minimax', 'minimax'],
  ['grok', 'xai'],
  ['nemotron', 'nvidia'],
  ['starcoder', 'bigcode']
]

/** Provider-level family used when the model id carries no recognised prefix. */
const PROVIDER_FALLBACK: Record<LLMProvider, string> = {
  claude: 'anthropic',
  glm: 'zhipu',
  'local-llm': 'unknown-local'
}

/**
 * Normalise a model id into a training-family key.
 *
 * The vendor prefix that some registries prepend (`anthropic/claude-opus-5`,
 * `hf.co/Qwen/Qwen3-32B`) is stripped, as are size/quant suffixes, before
 * prefix matching.
 */
export function modelFamily(identity: ModelIdentity): string {
  const raw = (identity.modelId ?? '').toLowerCase().trim()
  if (!raw) return PROVIDER_FALLBACK[identity.provider] ?? 'unknown'

  // Strip registry/vendor path segments: keep the last one ("Qwen/Qwen3" → "qwen3").
  const lastSegment = raw.split('/').pop() ?? raw
  // Drop a leading tag namespace some backends use ("library:qwen3" → "qwen3").
  const name = lastSegment.includes(':') ? lastSegment.split(':')[0] : lastSegment

  let best: { family: string; len: number } | null = null
  for (const [prefix, family] of FAMILY_PREFIXES) {
    if (name.startsWith(prefix) && (!best || prefix.length > best.len)) {
      best = { family, len: prefix.length }
    }
  }
  if (best) return best.family

  return PROVIDER_FALLBACK[identity.provider] ?? 'unknown'
}

/**
 * True when two role bindings are likely to share blind spots.
 *
 * Unknown families are treated as NOT the same, even when both are unknown:
 * two unrecognised local models are more plausibly different vendors than the
 * same one, and a false "same family" warning on every exotic model would
 * train users to ignore the hint.
 */
export function sameModelFamily(
  a: ModelIdentity | null | undefined,
  b: ModelIdentity | null | undefined
): boolean {
  if (!a || !b) return false
  const fa = modelFamily(a)
  const fb = modelFamily(b)
  if (fa.startsWith('unknown')) return false
  if (fb.startsWith('unknown')) return false
  return fa === fb
}

/** Display label for a family key, for UI hints. */
export function modelFamilyLabel(family: string): string {
  const labels: Record<string, string> = {
    anthropic: 'Anthropic',
    zhipu: 'Z.ai / GLM',
    meta: 'Meta Llama',
    qwen: 'Qwen',
    google: 'Google',
    mistral: 'Mistral',
    deepseek: 'DeepSeek',
    microsoft: 'Microsoft Phi',
    openai: 'OpenAI',
    ibm: 'IBM Granite',
    cohere: 'Cohere',
    zeroone: '01.AI Yi',
    fable: 'Fable',
    moonshot: 'Moonshot Kimi',
    minimax: 'MiniMax',
    xai: 'xAI Grok',
    nvidia: 'NVIDIA Nemotron',
    bigcode: 'StarCoder'
  }
  return labels[family] ?? family
}
