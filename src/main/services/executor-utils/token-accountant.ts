/**
 * Accumulates token usage from messages across the lifecycle of a query.
 *
 * Handles the multi-source nature of token usage:
 * - `stream_event` message_start/message_delta for incremental usage
 * - `result` message for authoritative final usage
 * - Generic `usage` field on any message type
 */
export interface TokenUsage {
  input: number
  output: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  /**
   * Current context-window occupancy — the prompt size of the MOST RECENT API
   * round-trip (input + cache_read + cache_creation of the latest message_start),
   * NOT the per-turn accumulated sum.
   *
   * A single user message triggers an agentic loop with many API round-trips,
   * each of which re-reads the entire cached context. Summing cache_read across
   * those round-trips massively over-counts window occupancy (e.g. a plan turn
   * with 10 tool calls reports ~400K "used" on a 1M window when the real
   * occupancy is ~60K). This snapshot reflects the true current context size.
   */
  contextWindowTokens: number
}

export class TokenAccountant {
  private usage: TokenUsage = {
    input: 0,
    output: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    contextWindowTokens: 0
  }

  /**
   * Accumulate token usage from a stream_event message_start.
   */
  accumulateFromMessageStart(startUsage: Record<string, number> | undefined): void {
    if (!startUsage) return
    this.usage.input += startUsage.input_tokens ?? 0
    this.usage.cacheReadInputTokens += startUsage.cache_read_input_tokens ?? 0
    this.usage.cacheCreationInputTokens += startUsage.cache_creation_input_tokens ?? 0

    // Snapshot current context occupancy = this call's full prompt size.
    // Overwrite (not accumulate) so we track the latest round-trip, not the sum.
    const callContext =
      (startUsage.input_tokens ?? 0) +
      (startUsage.cache_read_input_tokens ?? 0) +
      (startUsage.cache_creation_input_tokens ?? 0)
    if (callContext > 0) this.usage.contextWindowTokens = callContext
  }

  /**
   * Accumulate output tokens from a stream_event message_delta.
   */
  accumulateFromMessageDelta(deltaUsage: Record<string, number> | undefined): void {
    if (!deltaUsage) return
    this.usage.output += deltaUsage.output_tokens ?? 0
  }

  /**
   * Replace totals with authoritative result usage (result message).
   * The result message contains the final, definitive token counts.
   */
  setFromResult(resultUsage: Record<string, number> | undefined): void {
    if (!resultUsage) return
    this.usage.input = resultUsage.input_tokens ?? resultUsage.inputTokens ?? this.usage.input
    this.usage.output = resultUsage.output_tokens ?? resultUsage.outputTokens ?? this.usage.output
    this.usage.cacheReadInputTokens =
      resultUsage.cache_read_input_tokens ??
      resultUsage.cacheReadInputTokens ??
      this.usage.cacheReadInputTokens
    this.usage.cacheCreationInputTokens =
      resultUsage.cache_creation_input_tokens ??
      resultUsage.cacheCreationInputTokens ??
      this.usage.cacheCreationInputTokens

    // Only fall back to the result usage for context occupancy when no
    // message_start snapshot was captured. The CLI's result usage reports the
    // CUMULATIVE (billed) totals for the turn, which would re-introduce the
    // over-count — so we never overwrite an existing message_start snapshot.
    if (this.usage.contextWindowTokens === 0) {
      const resultContext =
        (resultUsage.input_tokens ?? resultUsage.inputTokens ?? 0) +
        (resultUsage.cache_read_input_tokens ?? resultUsage.cacheReadInputTokens ?? 0) +
        (resultUsage.cache_creation_input_tokens ?? resultUsage.cacheCreationInputTokens ?? 0)
      if (resultContext > 0) this.usage.contextWindowTokens = resultContext
    }
  }

  /**
   * Accumulate generic usage from any message type (non-result).
   */
  accumulateGeneric(msgUsage: Record<string, number> | undefined): void {
    if (!msgUsage) return
    this.usage.input += msgUsage.input_tokens ?? 0
    this.usage.output += msgUsage.output_tokens ?? 0
    this.usage.cacheReadInputTokens += msgUsage.cache_read_input_tokens ?? 0
    this.usage.cacheCreationInputTokens += msgUsage.cache_creation_input_tokens ?? 0
  }

  /**
   * Get the current accumulated token usage (copy).
   */
  getSummary(): TokenUsage {
    return { ...this.usage }
  }
}
