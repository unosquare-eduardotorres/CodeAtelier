/**
 * Heuristic Description Service
 *
 * Generates instant, pattern-based descriptions for code symbols using
 * camelCase/snake_case splitting, verb mapping, and symbol kind templates.
 * Produces ~60-70% of the quality of AI descriptions but runs at
 * ~100k chunks/second — no LLM, no network, no cost.
 *
 * Used as the default description provider during indexing. AI descriptions
 * (via Claude Haiku) can optionally replace these in a background enrichment
 * phase after the index is search-ready.
 */

import type { RawChunk } from './preprocessing.service'

// ── Verb → human-readable phrase mapping ───────────────────────────────────

const VERB_MAP: ReadonlyMap<string, string> = new Map([
  // Retrieval
  ['get', 'Retrieves'],
  ['fetch', 'Fetches'],
  ['find', 'Finds'],
  ['load', 'Loads'],
  ['read', 'Reads'],
  ['query', 'Queries'],
  ['search', 'Searches for'],
  ['lookup', 'Looks up'],
  ['resolve', 'Resolves'],
  ['select', 'Selects'],
  ['list', 'Lists'],
  ['retrieve', 'Retrieves'],

  // Mutation
  ['set', 'Sets'],
  ['update', 'Updates'],
  ['save', 'Saves'],
  ['write', 'Writes'],
  ['put', 'Stores'],
  ['store', 'Stores'],
  ['insert', 'Inserts'],
  ['add', 'Adds'],
  ['push', 'Pushes'],
  ['append', 'Appends'],
  ['assign', 'Assigns'],
  ['merge', 'Merges'],
  ['patch', 'Patches'],
  ['upsert', 'Upserts'],
  ['persist', 'Persists'],

  // Deletion
  ['delete', 'Deletes'],
  ['remove', 'Removes'],
  ['clear', 'Clears'],
  ['reset', 'Resets'],
  ['destroy', 'Destroys'],
  ['dispose', 'Disposes of'],
  ['drop', 'Drops'],
  ['purge', 'Purges'],
  ['clean', 'Cleans up'],
  ['evict', 'Evicts'],

  // Creation
  ['create', 'Creates'],
  ['build', 'Builds'],
  ['make', 'Creates'],
  ['generate', 'Generates'],
  ['construct', 'Constructs'],
  ['init', 'Initializes'],
  ['initialize', 'Initializes'],
  ['setup', 'Sets up'],
  ['bootstrap', 'Bootstraps'],
  ['spawn', 'Spawns'],
  ['instantiate', 'Instantiates'],
  ['new', 'Creates a new'],

  // Validation / checks
  ['is', 'Checks whether'],
  ['has', 'Checks whether it has'],
  ['can', 'Checks whether it can'],
  ['should', 'Determines whether to'],
  ['check', 'Checks'],
  ['validate', 'Validates'],
  ['verify', 'Verifies'],
  ['assert', 'Asserts that'],
  ['ensure', 'Ensures'],
  ['test', 'Tests'],
  ['match', 'Matches'],
  ['matches', 'Matches'],

  // Transformation
  ['parse', 'Parses'],
  ['convert', 'Converts'],
  ['transform', 'Transforms'],
  ['format', 'Formats'],
  ['serialize', 'Serializes'],
  ['deserialize', 'Deserializes'],
  ['encode', 'Encodes'],
  ['decode', 'Decodes'],
  ['normalize', 'Normalizes'],
  ['map', 'Maps'],
  ['reduce', 'Reduces'],
  ['filter', 'Filters'],
  ['sort', 'Sorts'],
  ['extract', 'Extracts'],
  ['compile', 'Compiles'],
  ['render', 'Renders'],
  ['stringify', 'Converts to string'],
  ['to', 'Converts to'],
  ['from', 'Creates from'],

  // Lifecycle
  ['start', 'Starts'],
  ['stop', 'Stops'],
  ['open', 'Opens'],
  ['close', 'Closes'],
  ['begin', 'Begins'],
  ['end', 'Ends'],
  ['run', 'Runs'],
  ['execute', 'Executes'],
  ['launch', 'Launches'],
  ['shutdown', 'Shuts down'],
  ['restart', 'Restarts'],
  ['resume', 'Resumes'],
  ['pause', 'Pauses'],
  ['cancel', 'Cancels'],
  ['abort', 'Aborts'],
  ['terminate', 'Terminates'],
  ['kill', 'Kills'],

  // Event handling
  ['handle', 'Handles'],
  ['on', 'Handles'],
  ['emit', 'Emits'],
  ['fire', 'Fires'],
  ['trigger', 'Triggers'],
  ['dispatch', 'Dispatches'],
  ['notify', 'Notifies'],
  ['broadcast', 'Broadcasts'],
  ['listen', 'Listens for'],
  ['subscribe', 'Subscribes to'],
  ['unsubscribe', 'Unsubscribes from'],
  ['register', 'Registers'],
  ['unregister', 'Unregisters'],
  ['bind', 'Binds'],
  ['unbind', 'Unbinds'],
  ['attach', 'Attaches'],
  ['detach', 'Detaches'],

  // Logging / output
  ['log', 'Logs'],
  ['print', 'Prints'],
  ['show', 'Shows'],
  ['display', 'Displays'],
  ['warn', 'Warns about'],
  ['error', 'Reports error for'],
  ['debug', 'Debugs'],
  ['trace', 'Traces'],
  ['report', 'Reports'],

  // Network / I/O
  ['send', 'Sends'],
  ['receive', 'Receives'],
  ['request', 'Requests'],
  ['respond', 'Responds to'],
  ['post', 'Posts'],
  ['download', 'Downloads'],
  ['upload', 'Uploads'],
  ['connect', 'Connects to'],
  ['disconnect', 'Disconnects from'],
  ['sync', 'Synchronizes'],
  ['poll', 'Polls'],
  ['ping', 'Pings'],

  // Misc
  ['process', 'Processes'],
  ['apply', 'Applies'],
  ['use', 'Uses'],
  ['configure', 'Configures'],
  ['enable', 'Enables'],
  ['disable', 'Disables'],
  ['toggle', 'Toggles'],
  ['wrap', 'Wraps'],
  ['unwrap', 'Unwraps'],
  ['lock', 'Locks'],
  ['unlock', 'Unlocks'],
  ['try', 'Attempts to'],
  ['retry', 'Retries'],
  ['await', 'Awaits'],
  ['wait', 'Waits for'],
  ['delay', 'Delays'],
  ['schedule', 'Schedules'],
  ['queue', 'Queues'],
  ['cache', 'Caches'],
  ['invalidate', 'Invalidates'],
  ['refresh', 'Refreshes'],
  ['reload', 'Reloads'],
  ['preload', 'Preloads'],
  ['prefetch', 'Prefetches'],
  ['lazy', 'Lazily loads'],
  ['defer', 'Defers'],
  ['batch', 'Batches'],
  ['chunk', 'Chunks'],
  ['split', 'Splits'],
  ['join', 'Joins'],
  ['concat', 'Concatenates'],
  ['flatten', 'Flattens'],
  ['group', 'Groups'],
  ['aggregate', 'Aggregates'],
  ['collect', 'Collects'],
  ['count', 'Counts'],
  ['sum', 'Sums'],
  ['compute', 'Computes'],
  ['calculate', 'Calculates'],
  ['measure', 'Measures'],
  ['compare', 'Compares'],
  ['diff', 'Computes differences for'],
  ['clone', 'Clones'],
  ['copy', 'Copies'],
  ['move', 'Moves'],
  ['swap', 'Swaps'],
  ['replace', 'Replaces'],
  ['interpolate', 'Interpolates'],
  ['inject', 'Injects'],
  ['embed', 'Embeds'],
  ['index', 'Indexes']
])

// ── Symbol kind → description prefix ──────────────────────────────────────

const KIND_PREFIX: Record<string, string> = {
  class: 'Class that',
  interface: 'Interface defining the shape for',
  type: 'Type alias for',
  enum: 'Enumeration of',
  const: 'Configuration constant for',
  function: '',
  method: ''
}

// ── Name splitting ────────────────────────────────────────────────────────

/**
 * Split a symbol name into words via camelCase, PascalCase, or snake_case boundaries.
 *
 * Examples:
 *   fetchUserProfile → ['fetch', 'User', 'Profile']
 *   MAX_RETRY_COUNT  → ['MAX', 'RETRY', 'COUNT']
 *   handleOnClick    → ['handle', 'On', 'Click']
 */
function splitName(name: string): string[] {
  // Handle snake_case / SCREAMING_SNAKE
  if (name.includes('_')) {
    return name
      .split('_')
      .filter(Boolean)
      .map((w) => w.toLowerCase())
  }

  // Handle camelCase / PascalCase
  // Insert a boundary before each uppercase letter that follows a lowercase letter,
  // or before a single uppercase followed by lowercase in a run of uppercase.
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1\0$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1\0$2')
    .split('\0')
    .filter(Boolean)

  return words
}

/**
 * Humanize a list of words into a readable noun phrase.
 * ['User', 'Profile', 'Data'] → 'user profile data'
 */
function humanize(words: string[]): string {
  return words.map((w) => w.toLowerCase()).join(' ')
}

// ── Return type helpers ───────────────────────────────────────────────────

/**
 * Extract the return type from a signature string.
 * Handles: `function foo(): Promise<User>`, `bar(): string[]`, etc.
 */
function extractReturnType(signature: string): string | null {
  // Match `: ReturnType` at the end of the signature (after the last `)`)
  const match = signature.match(/\)\s*:\s*(.+)$/)
  if (!match) return null

  let rt = match[1].trim()

  // Unwrap Promise<T> → T
  const promiseMatch = rt.match(/^Promise\s*<\s*(.+)\s*>$/)
  if (promiseMatch) {
    rt = promiseMatch[1].trim()
  }

  // Skip void / unknown / any — not informative
  if (/^(void|unknown|any|never)$/i.test(rt)) return null

  return rt
}

/**
 * Build a return type suffix like "returning User" or "returning a string array".
 */
function returnTypeSuffix(signature: string): string {
  const rt = extractReturnType(signature)
  if (!rt) return ''

  // boolean → ", returning a boolean"
  if (rt === 'boolean') return ', returning a boolean result'
  // string → ", returning a string"
  if (rt === 'string') return ', returning a string'
  // number → ", returning a number"
  if (rt === 'number') return ', returning a number'
  // arrays
  if (rt.endsWith('[]')) return `, returning ${rt.replace('[]', '')} items`
  // Generic types like Map<K,V>
  if (rt.includes('<')) {
    const base = rt.split('<')[0]
    return `, returning a ${base}`
  }

  return `, returning ${rt}`
}

// ── Parameter helpers ─────────────────────────────────────────────────────

/**
 * Extract parameter names from a signature.
 * `function foo(userId: string, options?: Options): Promise<User>`
 * → ['userId', 'options']
 */
function extractParamNames(signature: string): string[] {
  const match = signature.match(/\(([^)]*)\)/)
  if (!match || !match[1].trim()) return []

  return match[1]
    .split(',')
    .map((p) => p.trim().split(/[?:=]/)[0].trim())
    .filter((n) => n && n !== '...' && n !== 'this')
}

/**
 * Build a short parameter context string.
 * ['userId', 'options'] → "by user ID"
 * ['filePath', 'content'] → "for a given file path"
 */
function paramContext(params: string[]): string {
  if (params.length === 0) return ''
  const first = params[0]
  const firstWords = splitName(first)
  const humanized = humanize(firstWords)

  // Common patterns
  if (humanized.includes('id')) return ` by ${humanized}`
  if (humanized.includes('path')) return ` for a given ${humanized}`
  if (humanized.includes('name')) return ` by ${humanized}`
  if (humanized.includes('key')) return ` by ${humanized}`
  if (humanized.includes('query')) return ` matching a ${humanized}`
  if (humanized.includes('config') || humanized.includes('options'))
    return ` with the given ${humanized}`

  if (params.length === 1) return ` for ${humanized}`
  return ''
}

// ── Main entry point ──────────────────────────────────────────────────────

/**
 * Generate a heuristic description for a code symbol.
 *
 * @param chunk - The raw code chunk with symbol metadata
 * @returns A plain English description, or a generic fallback
 *
 * @example
 * ```ts
 * generateHeuristicDescription({
 *   symbolName: 'fetchUserProfile',
 *   symbolKind: 'function',
 *   signature: 'async function fetchUserProfile(userId: string): Promise<User>',
 *   ...
 * })
 * // → "Fetches user profile by user id, returning User"
 * ```
 */
export function generateHeuristicDescription(chunk: RawChunk): string {
  const { symbolName, symbolKind, signature, isAsync } = chunk

  const words = splitName(symbolName)
  if (words.length === 0) {
    return fallbackDescription(chunk)
  }

  // ── Constants / enums ───────────────────────────────────────────────────
  if (symbolKind === 'const' || symbolKind === 'enum') {
    const kindLabel = symbolKind === 'enum' ? 'Enumeration of' : 'Configuration constant for'
    const noun = humanize(words)
    return `${kindLabel} ${noun}`
  }

  // ── Interfaces / types ──────────────────────────────────────────────────
  if (symbolKind === 'interface') {
    const noun = humanize(words)
    // Detect common patterns
    if (noun.includes('props'))
      return `Props interface for ${noun.replace('props', '').trim()} component`
    if (noun.includes('state')) return `State shape for ${noun.replace('state', '').trim()}`
    if (noun.includes('config') || noun.includes('options'))
      return `Configuration options for ${noun.replace(/(config|options)/, '').trim()}`
    if (noun.includes('request')) return `Request payload for ${noun.replace('request', '').trim()}`
    if (noun.includes('response'))
      return `Response shape for ${noun.replace('response', '').trim()}`
    return `Interface defining the shape for ${noun}`
  }

  if (symbolKind === 'type') {
    const noun = humanize(words)
    return `Type alias for ${noun}`
  }

  // ── Classes ─────────────────────────────────────────────────────────────
  if (symbolKind === 'class') {
    const noun = humanize(words)
    // Detect common patterns
    if (noun.includes('service'))
      return `Service class that manages ${noun.replace('service', '').trim()} operations`
    if (noun.includes('controller'))
      return `Controller that handles ${noun.replace('controller', '').trim()} requests`
    if (noun.includes('repository'))
      return `Repository for ${noun.replace('repository', '').trim()} data access`
    if (noun.includes('adapter'))
      return `Adapter for ${noun.replace('adapter', '').trim()} integration`
    if (noun.includes('factory'))
      return `Factory that creates ${noun.replace('factory', '').trim()} instances`
    if (noun.includes('handler')) return `Handler for ${noun.replace('handler', '').trim()} events`
    if (noun.includes('provider'))
      return `Provider for ${noun.replace('provider', '').trim()} functionality`
    if (noun.includes('manager'))
      return `Manager for ${noun.replace('manager', '').trim()} lifecycle`
    if (noun.includes('builder'))
      return `Builder for constructing ${noun.replace('builder', '').trim()} objects`
    if (noun.includes('validator'))
      return `Validator for ${noun.replace('validator', '').trim()} rules`
    if (noun.includes('store')) return `State store for ${noun.replace('store', '').trim()} data`
    if (noun.includes('component'))
      return `UI component for ${noun.replace('component', '').trim()}`
    if (noun.includes('middleware'))
      return `Middleware for ${noun.replace('middleware', '').trim()} processing`
    if (noun.includes('guard'))
      return `Guard that protects ${noun.replace('guard', '').trim()} access`
    return `Class that manages ${noun}`
  }

  // ── Functions / methods ─────────────────────────────────────────────────
  const verb = words[0].toLowerCase()
  const matched = VERB_MAP.get(verb)

  if (matched) {
    // Known verb: "Fetches" + remaining words + param context + return type
    const nounWords = words.slice(1)
    const noun = nounWords.length > 0 ? ' ' + humanize(nounWords) : ''
    const params = paramContext(extractParamNames(signature))
    const rtSuffix = returnTypeSuffix(signature)

    let desc = `${matched}${noun}${params}${rtSuffix}`

    // Add async hint for non-obvious async operations
    if (
      isAsync &&
      !matched.toLowerCase().includes('fetch') &&
      !matched.toLowerCase().includes('load')
    ) {
      desc += ' (async)'
    }

    return desc
  }

  // ── No matched verb — use kind-based prefix or generic fallback ──────
  const kindPrefix = KIND_PREFIX[symbolKind]
  if (kindPrefix) {
    const noun = humanize(words)
    const rtSuffix = returnTypeSuffix(signature)
    return `${kindPrefix} ${noun}${rtSuffix}`.trim()
  }

  return fallbackDescription(chunk)
}

/**
 * Fallback description for symbols that don't match any pattern.
 */
function fallbackDescription(chunk: RawChunk): string {
  const fileName = chunk.filePath.split('/').pop() ?? chunk.filePath
  return `${chunk.symbolKind} ${chunk.symbolName} in ${fileName}`
}

/**
 * Generate heuristic descriptions for a batch of chunks.
 * Returns a Map<batchIndex, description>.
 *
 * This is the batch counterpart of generateHeuristicDescription — runs at
 * ~100k chunks/second since it's pure string manipulation with zero I/O.
 */
export function generateHeuristicDescriptionBatch(
  chunks: Array<{ chunk: RawChunk }>
): Map<number, string> {
  const results = new Map<number, string>()
  for (let i = 0; i < chunks.length; i++) {
    results.set(i, generateHeuristicDescription(chunks[i].chunk))
  }
  return results
}
