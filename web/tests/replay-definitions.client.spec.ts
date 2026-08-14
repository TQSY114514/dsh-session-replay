/** Replay target specs: the raw-event Definition and the per-Session snapshot builder. */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import type {
  ConversationNodeContext, ConversationTimelineSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import { conversationContextKey } from '@deepseek-ai/dsh-client-runtime/client'
import type { ReplayViewNode } from '../src/client/contract.ts'
import {
  EMPTY_REPLAY_SNAPSHOT, replayEventDefinition, replayViewDefinition,
} from '../src/client/replay-definitions.ts'

const TIMELINE: ConversationTimelineSnapshot = { turnOrder: [], turns: new Map() }

function userEvent(seq: number, time: number, text: string): SessionEvent {
  return {
    type: 'user/message', seq, time, surfaceOp: 'append',
    data: {
      id: MessageId(`u-${seq}`), role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
  }
}

function toolCallEvent(seq: number, time: number): SessionEvent {
  return {
    type: 'tool/call', seq, time,
    data: { turn: 1, step: 1, callId: CallId(`c${seq}`), name: 'bash', arguments: '{}' },
  }
}

function node(seq: number, event: SessionEvent): ReplayViewNode {
  return {
    key: conversationContextKey('replay.event', String(seq)),
    kind: 'replay.event',
    id: String(seq),
    target: 'replay',
    anchorSeq: seq,
    location: { kind: 'unresolved' },
    data: { event },
  }
}

describe('replayEventDefinition', () => {
  it('captures every event as its own start Context keyed by seq', () => {
    const event = userEvent(7, 1_000, 'hi')
    const match = replayEventDefinition.match(event)
    expect(match).toEqual({ id: '7', role: 'start' })
  })

  it('keeps the raw event as the State and materializes one node per event', () => {
    const event = toolCallEvent(3, 2_000)
    const match = replayEventDefinition.match(event)
    expect(match).not.toBeNull()
    const start = { event, role: 'start' as const, location: { kind: 'unresolved' } as const }
    const context: ConversationNodeContext<SessionEvent> = {
      key: conversationContextKey('replay.event', '3'),
      kind: 'replay.event',
      id: '3',
      matches: [{ ...start, view: undefined }],
      start: { ...start, view: undefined },
      state: event,
      current: new Map(),
    }
    const node = replayEventDefinition.buildViewNode?.(context)
    expect(node).not.toBeNull()
    // The Definition's declared contract returns the generic view node; the
    // concrete target envelope is the runtime shape the builder consumes.
    const replayNode = node as ReplayViewNode
    expect(replayNode.anchorSeq).toBe(3)
    expect(replayNode.data.event).toBe(event)
  })
})

describe('ReplaySnapshotBuilder', () => {
  const builder = replayViewDefinition.create()

  it('starts from the stable empty snapshot', () => {
    expect(builder.empty).toBe(EMPTY_REPLAY_SNAPSHOT)
    expect(builder.empty.events).toEqual([])
  })

  it('replace sorts the complete window by seq', () => {
    const e1 = userEvent(1, 1_000, 'a')
    const e2 = userEvent(3, 3_000, 'c')
    const e3 = userEvent(2, 2_000, 'b')
    const snapshot = builder.replace({
      nodes: [node(1, e1), node(3, e2), node(2, e3)],
      timeline: TIMELINE,
    })
    expect(snapshot.events.map(event => event.seq)).toEqual([1, 2, 3])
  })

  it('appends live tail events with a fresh snapshot identity per flush', () => {
    const first = builder.replace({
      nodes: [node(1, userEvent(1, 1_000, 'a'))],
      timeline: TIMELINE,
    })
    const second = builder.apply({
      upserts: [node(2, userEvent(2, 2_000, 'b')), node(3, userEvent(3, 3_000, 'c'))],
      timeline: TIMELINE,
    })
    expect(second).not.toBe(first)
    expect(second.events.map(event => event.seq)).toEqual([1, 2, 3])
  })

  it('ignores duplicate tail upserts and keeps one copy per seq', () => {
    const after = builder.apply({
      upserts: [node(3, userEvent(3, 3_000, 'c'))],
      timeline: TIMELINE,
    })
    expect(after.events.map(event => event.seq)).toEqual([1, 2, 3])
  })

  it('rebuilds in seq order when an older-history prepend arrives', () => {
    const older = userEvent(0, 500, 'older')
    const after = builder.apply({
      upserts: [node(0, older)],
      timeline: TIMELINE,
    })
    expect(after.events.map(event => event.seq)).toEqual([0, 1, 2, 3])
    expect(after.events[0]).toBe(older)
  })
})
