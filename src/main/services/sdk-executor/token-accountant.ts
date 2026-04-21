/**
 * Accumulates token usage from SDK messages across the lifecycle of a query.
 *
 * Handles the multi-source nature of token usage in the SDK:
 * - `stream_event` message_start/message_delta for incremental usage
 * - `result` message for authoritative final usage
 * - Generic `usage` field on any message type
 */
export interface TokenUsage {
  input: number
  output: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

export class TokenAccountant {
  private usage: TokenUsage = {
    input: 0,
    output: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0
  }

  /**
   * Accumulate token usage from a stream_event message_start.
   */
  accumulateFromMessageStart(startUsage: Record<string, number> | undefined): void {
    if (!startUsage) return
    this.usage.input += startUsage.input_tokens ?? 0
    this.usage.cacheReadInputTokens += startUsage.cache_read_input_tokens ?? 0
    this.usage.cacheCreationInputTokens += startUsage.cache_creation_input_tokens ?? 0
  }

  /**
   * Accumulate output tokens from a stream_event message_delta.
   */
  accumulateFromMessageDelta(deltaUsage: Record<string, number> | undefined): void {
    if (!deltaUsage) return
    this.usage.output += deltaUsage.output_tokens ?? 0
  }

  /**
   * Replace totals with authoritative result usage (SDK result message).
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
