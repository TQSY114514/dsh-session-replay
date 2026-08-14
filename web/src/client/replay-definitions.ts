import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {
  ConversationNodeDefinition, ConversationTimelineSnapshot, ConversationViewBuilder,
  ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ReplaySnapshot, ReplayViewNode } from './contract.ts'

const EMPTY_EVENTS: readonly SessionEvent[] = []

/** Stable empty target used until a Session has assembled replay records. */
export const EMPTY_REPLAY_SNAPSHOT: ReplaySnapshot = { events: EMPTY_EVENTS }

/**
 * One Context per raw event: the definition accepts every event in the
 * window (the event itself is the State), so the assembled view snapshot
 * reconstructs the full log with its real `time` gaps. The engine stays
 * O(1) per live event because each append only materializes one node.
 */
export const replayEventDefinition: ConversationNodeDefinition<SessionEvent> = {
  kind: 'replay.event',
  target: 'replay',
  match: event => ({ id: String(event.seq), role: 'start' }),
  start: (_context, match) => {
    return match.event
  },
  update: context => context.state,
  buildViewNode: context => {
    const event = context.state
    if (event === undefined) return null
    return {
      key: context.key,
      kind: context.kind,
      id: context.id,
      target: 'replay',
      anchorSeq: event.seq,
      location: context.start?.location ?? { kind: 'unresolved' },
      data: { event },
    }
  },
}

/**
 * Per-Session builder for the replay target: keeps one seq-keyed event
 * store and a sorted array for the snapshot. Live tail appends stay O(1);
 * an out-of-order upsert (older-history prepend) triggers a full rebuild.
 * Each flush returns a fresh snapshot object so the uSES selector identity
 * moves exactly when the log does.
 */
class ReplaySnapshotBuilder implements ConversationViewBuilder<ReplayViewNode, ReplaySnapshot> {
  private readonly bySeq = new Map<number, SessionEvent>()
  private events: readonly SessionEvent[] = EMPTY_EVENTS
  private tailSeq = -1

  readonly empty = EMPTY_REPLAY_SNAPSHOT

  replace(input: {
    readonly nodes: readonly ReplayViewNode[]
    readonly timeline: ConversationTimelineSnapshot
  }): ReplaySnapshot {
    this.bySeq.clear()
    this.tailSeq = -1
    for (const node of input.nodes) {
      this.bySeq.set(node.anchorSeq, node.data.event)
      if (node.anchorSeq > this.tailSeq) this.tailSeq = node.anchorSeq
    }
    this.events = sortedEvents(this.bySeq)
    return { events: this.events }
  }

  apply(input: {
    readonly upserts: readonly ReplayViewNode[]
    readonly timeline: ConversationTimelineSnapshot
  }): ReplaySnapshot {
    let tailOnly = true
    for (const node of input.upserts) {
      if (node.anchorSeq <= this.tailSeq) {
        tailOnly = false
        break
      }
    }
    if (tailOnly) {
      const additions = [...input.upserts]
        .filter(node => !this.bySeq.has(node.anchorSeq))
        .sort((left, right) => left.anchorSeq - right.anchorSeq)
      const merged = [...this.events, ...additions.map(node => node.data.event)]
      this.events = merged
      for (const node of additions) {
        this.bySeq.set(node.anchorSeq, node.data.event)
        if (node.anchorSeq > this.tailSeq) this.tailSeq = node.anchorSeq
      }
      return { events: this.events }
    }
    for (const node of input.upserts) {
      this.bySeq.set(node.anchorSeq, node.data.event)
      if (node.anchorSeq > this.tailSeq) this.tailSeq = node.anchorSeq
    }
    this.events = sortedEvents(this.bySeq)
    return { events: this.events }
  }
}

function sortedEvents(bySeq: ReadonlyMap<number, SessionEvent>): readonly SessionEvent[] {
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq)
}

/** Replay target factory assembling the raw event log per Session. */
export const replayViewDefinition: ConversationViewDefinition<ReplayViewNode, ReplaySnapshot> = {
  target: 'replay',
  create: () => new ReplaySnapshotBuilder(),
}

/**
 * Register the raw-event capture Definition.
 *
 * @param ctx - Plugin context receiving the Definition.
 */
export function registerReplayEventDefinition(ctx: Context): void {
  ctx.conversationEvents.register(replayEventDefinition)
}

/**
 * Register the replay target builder.
 *
 * @param ctx - Plugin context receiving the view Definition.
 */
export function registerReplayConversationView(ctx: Context): void {
  ctx.conversationViews.register(replayViewDefinition)
}
