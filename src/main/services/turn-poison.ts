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
 * A turn the user cancelled through the CLI's own interrupt is NOT poisoned
 * either, whatever its chunk count. The CLI recorded the interruption itself and
 * closed the turn with a `result`, so nothing is left unanswered — the zero-chunk
 * rule would otherwise drop the session for every Stop pressed before the first
 * chunk arrives (roughly the first three seconds of a turn), which is the most
 * common Stop there is.
 *
 * Kept in its own module (no imports) so it can be unit-tested directly
 * without loading agent-session.service and its Electron/native dependencies.
 */
export function isTurnPoisoned(turn: {
  aborted: boolean
  chunkCount: number
  gracefullyCancelled?: boolean
}): boolean {
  // `aborted` still wins: an abort means the process was torn down under the
  // turn, which is exactly the state a graceful cancel avoids.
  if (turn.gracefullyCancelled && !turn.aborted) return false
  return turn.aborted || turn.chunkCount === 0
}
