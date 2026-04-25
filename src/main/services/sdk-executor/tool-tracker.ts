/**
 * Maps tool use IDs to tool names, enabling tool_result events to include
 * the correct tool name (SDK tool_result only provides the tool_use_id).
 *
 * Also tracks content state for turn boundary detection.
 */
export class ToolTracker {
  private toolIdToName = new Map<string, string>()

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

  /**
   * Register a tool use mapping (id → name).
   */
  register(toolId: string, toolName: string): void {
    this.toolIdToName.set(toolId, toolName)
  }

  /**
   * Resolve a tool use ID to its name. Returns 'Unknown' if not tracked.
   */
  resolve(toolUseId: string | undefined): string {
    if (!toolUseId) return 'Unknown'
    return this.toolIdToName.get(toolUseId) ?? 'Unknown'
  }

  /**
   * Remove a tool mapping after result processing (free memory for long sessions).
   */
  consume(toolUseId: string | undefined): void {
    if (toolUseId) {
      this.toolIdToName.delete(toolUseId)
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
        }
      }
    }
  }
}
