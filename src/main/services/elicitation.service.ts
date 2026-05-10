interface PendingElicitation {
  resolve: (result: {
    action: 'accept' | 'decline' | 'cancel'
    content?: Record<string, unknown>
  }) => void
  serverName: string
  mode?: string
}

export class ElicitationService {
  private pendingElicitations = new Map<string, PendingElicitation>()

  resolveElicitation(
    requestId: string,
    result: {
      action: 'accept' | 'decline' | 'cancel'
      content?: Record<string, unknown>
    }
  ): void {
    const pending = this.pendingElicitations.get(requestId)
    if (!pending) return
    this.pendingElicitations.delete(requestId)
    pending.resolve(result)
  }
}

export const elicitationService = new ElicitationService()
