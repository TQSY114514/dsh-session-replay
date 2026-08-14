import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId, SessionEvent, SessionPreparation } from '@deepseek-ai/dsh-session'

/** Fork options: an explicit boundary seq, a turn number, and/or a child id. */
export interface ForkOptions {
  /** Boundary event seq (inclusive); defaults to the last event. */
  readonly boundary?: number
  /** Alternative to `boundary`: fork at this turn's `turn/end` seq. */
  readonly turn?: number
  /** Id for the child session; the store mints one when omitted. */
  readonly childId?: SessionId
}

/** The result of a fork: the live child session plus the discarded tail. */
export interface ForkResult {
  readonly child: Session
  /** The inclusive boundary event seq the child was cut at. */
  readonly boundary: number
  /** Events after the boundary — the tail the fork discarded. */
  readonly cut: readonly SessionEvent[]
}

/** The seq of turn `turn`'s last `turn/end` event, or undefined when absent. */
function turnEndSeq(events: readonly SessionEvent[], turn: number): number | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'turn/end' && event.data.turn === turn) return event.seq
  }
  return undefined
}

/**
 * Fork a recorded run at a boundary: the child session carries the prefix up
 * to (and including) the boundary event, with `parentSession` / `seedLength`
 * lineage metadata, and is ready to continue with a fresh agent — re-running
 * from the failure point with different instructions or a different model.
 *
 * The source may be already live in the store; otherwise it is rebuilt from
 * persistence first (the fork API only accepts live sessions). The boundary
 * must end outside an open turn — `SessionStore.fork` rejects open-turn cuts.
 */
export async function forkRun(
  ctx: Context,
  sourceId: SessionId,
  options: ForkOptions = {},
): Promise<ForkResult> {
  let source = ctx.sessions.get(sourceId)
  let preparation: SessionPreparation | undefined
  if (source === undefined) {
    // A persisted-but-unloaded session must be resumed into the store first:
    // the fork API only accepts live sessions, and `create` would collide with
    // the persisted identity. `prepare` reserves the exact session; enter +
    // announce publish it without re-materializing.
    preparation = await ctx.sessionPersistence.prepare(sourceId)
    source = preparation.session
    ctx.sessions.enter(source)
    ctx.sessions.announce(source)
  }

  try {
    // The restored source carries a projected `session/end-seed` marker
    // (constructor projection), which is not a real event: exclude it from
    // both the default boundary and the discarded tail.
    let boundary = options.boundary
    if (boundary === undefined && options.turn !== undefined) {
      const seq = turnEndSeq(source.events, options.turn)
      if (seq === undefined) {
        throw new Error(`turn ${options.turn} has no completed turn/end in session "${sourceId}"`)
      }
      boundary = seq
    }
    if (boundary === undefined) {
      for (let i = source.events.length - 1; i >= 0; i -= 1) {
        const event = source.events[i]
        if (event !== undefined && event.type !== 'session/end-seed') {
          boundary = event.seq
          break
        }
      }
    }

    const child = ctx.sessions.fork(source, boundary, options.childId)
    const cut = source.events
      .slice((boundary ?? 0) + 1)
      .filter(event => event.type !== 'session/end-seed')
    return {
      child,
      boundary: boundary ?? source.events.at(-1)?.seq ?? -1,
      cut,
    }
  } finally {
    // Publication consumed the preparation; release is a no-op, but dispose
    // regardless so the reserved provider state is never leaked.
    preparation?.[Symbol.dispose]()
  }
}
