/**
 * Tool names that block on human input and so have no meaningful wall-clock
 * timeout. Compared against the *bare* name — see stripMcpNamespace.
 */
const HUMAN_INPUT_TOOLS = new Set(['ask_user', 'elicitation'])

/**
 * Strip the `mcp__<server>__` namespace from a tool name.
 *
 * Tools mounted over MCP arrive on the stream fully qualified — the `name` on
 * a tool_use block is `mcp__control-actions__ask_user`, and that is verbatim
 * what register() stores. Built-in tools (Read, Edit, Bash) arrive bare. Any
 * check against a bare tool name therefore has to normalise first, or it
 * silently never matches the MCP case.
 *
 * Splits after the second `__`, so server names containing `-` or `_`
 * ('control-actions', 'file-tools') are handled.
 */
export function stripMcpNamespace(name: string): string {
  if (!name.startsWith('mcp__')) return name
  const sep = name.indexOf('__', 'mcp__'.length)
  return sep === -1 ? name : name.slice(sep + 2)
}

/**
 * Maps tool use IDs to tool names, enabling tool_result events to include
 * the correct tool name (tool_result only provides the tool_use_id).
 *
 * Also tracks content state for turn boundary detection.
 */
export class ToolTracker {
  private toolIdToName = new Map<string, string>()
  /** Stores summarized tool input for inclusion in tool_result chunks */
  private toolIdToInput = new Map<string, string>()
  /** Stores RAW (unsummarized) JSON tool input — see StreamChunk.toolInputRaw */
  private toolIdToRawInput = new Map<string, string>()
  /** Registration timestamps — enables age-based reaping of never-consumed entries */
  private toolIdToRegisteredAt = new Map<string, number>()

  /** Whether any content has been emitted this turn (text or tools) */
  hasPriorContent = false

  /**
   * Whether *visible text* has been emitted in the current turn (not just
   * tools). Used to suppress turn_boundary for tool-only iterations so a
   * single user prompt produces a single bubble with all its tool activity
   * attached, instead of one bubble per internal Claude tool-loop iteration.
   *
   * Reset to false at every turn_boundary emission.
   */
  hasPriorText = false

  /** Track the last content block type for thinking→text transition detection */
  lastBlockType: 'thinking' | 'text' | 'tool_use' | null = null

  /** Current structured output schema name (set during json_delta streaming) */
  currentSchemaName: string | null = null

  /** Number of tool calls that have been registered but not yet consumed (pending results). */
  get pendingToolCount(): number {
    return this.toolIdToName.size
  }

  /** Names of all still-pending tools — for leak diagnostics. */
  get pendingToolNames(): string[] {
    return [...this.toolIdToName.values()]
  }

  /**
   * `[id, name]` for every still-pending tool. Needed when a caller must emit a
   * synthetic tool_result for work that was orphaned — the id is what downstream
   * consumers merge on, so names alone are not enough.
   */
  get pendingToolEntries(): Array<[string, string]> {
    return [...this.toolIdToName.entries()]
  }

  /**
   * The single pending tool id, when exactly one is outstanding. Used to
   * recover a tool_result that arrived without a tool_use_id — with one tool
   * in flight the correlation is unambiguous.
   */
  getSolePendingId(): string | undefined {
    if (this.toolIdToName.size !== 1) return undefined
    return this.toolIdToName.keys().next().value
  }

  /**
   * Whether any pending tool is an ask_user-type tool that legitimately waits
   * for human input. These tools have no meaningful timeout — the user decides
   * when to respond.
   *
   * Matches on the namespace-stripped name. ask_user is only ever reachable
   * over MCP, so it is registered as `mcp__control-actions__ask_user`; the
   * previous exact comparison against 'ask_user' could not match it, which
   * made cli-executor's untimed human-input branch unreachable and put every
   * ask_user wait on the 10-minute TOOL_RESULT_TIMEOUT_MS instead.
   */
  hasAskUserPending(): boolean {
    for (const name of this.toolIdToName.values()) {
      if (HUMAN_INPUT_TOOLS.has(stripMcpNamespace(name))) return true
    }
    return false
  }

  /**
   * Register a tool use mapping (id → name).
   */
  register(toolId: string, toolName: string, inputSummary?: string, rawInputJson?: string): void {
    this.toolIdToName.set(toolId, toolName)
    this.toolIdToRegisteredAt.set(toolId, Date.now())
    if (inputSummary) {
      this.toolIdToInput.set(toolId, inputSummary)
    }
    if (rawInputJson) {
      this.toolIdToRawInput.set(toolId, rawInputJson)
    }
  }

  /**
   * Resolve a tool use ID to its name. Returns 'Unknown' if not tracked.
   */
  resolve(toolUseId: string | undefined): string {
    if (!toolUseId) return 'Unknown'
    return this.toolIdToName.get(toolUseId) ?? 'Unknown'
  }

  /**
   * Resolve a tool use ID to its stored input summary.
   */
  resolveInput(toolUseId: string | undefined): string | undefined {
    if (!toolUseId) return undefined
    return this.toolIdToInput.get(toolUseId)
  }

  /**
   * Resolve a tool use ID to its stored RAW (unsummarized) JSON input.
   */
  resolveRawInput(toolUseId: string | undefined): string | undefined {
    if (!toolUseId) return undefined
    return this.toolIdToRawInput.get(toolUseId)
  }

  /**
   * Remove a tool mapping after result processing (free memory for long sessions).
   *
   * Returns false when nothing was removed (missing or unknown id). A miss
   * leaves the entry resident forever, which pins pendingToolCount above zero
   * and keeps cli-executor in the 10-min tool-result branch instead of the
   * 5-min message timeout — callers must surface it.
   */
  consume(toolUseId: string | undefined): boolean {
    if (!toolUseId) return false
    const existed = this.toolIdToName.delete(toolUseId)
    this.toolIdToInput.delete(toolUseId)
    this.toolIdToRawInput.delete(toolUseId)
    this.toolIdToRegisteredAt.delete(toolUseId)
    return existed
  }

  /**
   * Drop entries registered more than `maxAgeMs` ago. Returns the removed names.
   */
  sweep(maxAgeMs: number): string[] {
    const cutoff = Date.now() - maxAgeMs
    const removed: string[] = []
    for (const [id, registeredAt] of this.toolIdToRegisteredAt) {
      if (registeredAt <= cutoff) {
        removed.push(this.toolIdToName.get(id) ?? 'Unknown')
        this.consume(id)
      }
    }
    return removed
  }

  /** Drop every pending entry. Used at end-of-turn, where nothing can still be owed. */
  clear(): void {
    this.toolIdToName.clear()
    this.toolIdToInput.clear()
    this.toolIdToRawInput.clear()
    this.toolIdToRegisteredAt.clear()
  }

  /**
   * Fill in a tool's input *only when it is currently missing*.
   *
   * With `--include-partial-messages` the CLI emits Anthropic SSE-shaped
   * events, where a tool_use `content_block_start` always carries `input: {}`
   * — the real arguments stream separately as `input_json_delta`, which the
   * normalizer does not accumulate. The complete `assistant` message that
   * follows *does* carry the full input, so it is used as the backfill source.
   *
   * Never clobbers a value the streaming path did capture (non-partial
   * backends put the real input on content_block_start).
   */
  backfillInput(toolId: string, inputSummary?: string, rawInputJson?: string): void {
    if (inputSummary && !this.toolIdToInput.has(toolId)) {
      this.toolIdToInput.set(toolId, inputSummary)
    }
    if (rawInputJson && !this.toolIdToRawInput.has(toolId)) {
      this.toolIdToRawInput.set(toolId, rawInputJson)
    }
  }

  /**
   * Register tool mappings from an assistant message (complete replay).
   * Only registers tools not already tracked.
   */
  registerFromAssistantMessage(contentBlocks: Record<string, unknown>[]): void {
    for (const block of contentBlocks) {
      if (block.type === 'tool_use') {
        const toolId = block.id as string | undefined
        const toolName = block.name as string
        if (toolId && !this.toolIdToName.has(toolId)) {
          this.toolIdToName.set(toolId, toolName)
          this.toolIdToRegisteredAt.set(toolId, Date.now())
        }
      }
    }
  }
}
