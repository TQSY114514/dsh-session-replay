import type { Context } from '@deepseek-ai/cordis'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import { ReplayEngine } from './engine/index.ts'

/**
 * Live follow-along: an engine that starts from a recorded prefix and keeps
 * appending events as the harness records them.
 *
 * The constructor feeds `initial` (typically `session.events` or a
 * `loadRun` result), then subscribes to the `session/event` firehose and
 * appends every event whose `seq` passes the engine's tail check — so a cold
 * start that re-feeds already-recorded history is harmless (duplicate seqs
 * are dropped by `ReplayEngine.append`).
 *
 * The listener contains its own errors: the firehose is stop-on-throw, so an
 * uncaught exception here would starve every other subscriber.
 */
export class LiveReplay {
  readonly engine: ReplayEngine

  private readonly off: () => void
  private disposed = false

  constructor(ctx: Context, targetId: SessionId, initial: readonly SessionEvent[]) {
    this.engine = new ReplayEngine(initial)
    this.off = ctx.on('session/event', (session, event) => {
      if (session.id !== targetId) return
      try {
        this.engine.append([event])
      } catch {
        // Contain: never let a replay failure starve other firehose subscribers.
      }
    })
  }

  /** Stop following. Safe to call more than once. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.off()
  }
}
