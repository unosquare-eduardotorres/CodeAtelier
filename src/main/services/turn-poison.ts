/**
 * Decide whether a finished turn left the CLI session unsafe to `--resume`.
 *
 * A turn that was aborted (user Stop, workspace switch) or that yielded zero
 * chunks pushed a user turn into the CLI session that was never answered.
 * `--resume` replays that session and the model answers the OLDEST unanswered
 * turn, which is how replies started landing on the previous message. Such a
 * session must be abandoned rather than resumed.
 *
 * A turn that produced chunks but no `result` event is NOT poisoned: the CLI
 * still answered the turn, so resuming stays correct.
 *
 * Kept in its own module (no imports) so it can be unit-tested directly
 * without loading agent-session.service and its Electron/native dependencies.
 */
export function isTurnPoisoned(turn: { aborted: boolean; chunkCount: number }): boolean {
  return turn.aborted || turn.chunkCount === 0
}
