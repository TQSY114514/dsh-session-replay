import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { MessageId, CallId } from '@deepseek-ai/dsh-llm'
import { ReplayEngine } from '../src/engine/index.ts'
import { LiveReplay } from '../src/live.ts'

function turnStart(seq: number, time: number, turn: number): SessionEvent {
  return { type: 'turn/start', seq, time, data: { turn } }
}

function user(seq: number, time: number, text: string): SessionEvent {
  return {
    type: 'user/message', seq, time, surfaceOp: 'append',
    data: { id: MessageId(`u-${seq}`), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

describe('ReplayEngine.append', () => {
  it('appends new events and extends turn indexing', () => {
    const engine = new ReplayEngine([turnStart(0, 1000, 1), user(1, 1100, 'a')])
    expect(engine.seekToTurn(2)).toBe(false)

    engine.append([turnStart(2, 5000, 2), user(3, 5100, 'b')])
    expect(engine.snapshot.total).toBe(4)
    expect(engine.seekToTurn(2)).toBe(true)
    expect(engine.snapshot.cursor).toBe(2)
  })

  it('drops duplicate seqs (cold-start history followed by firehose repeats)', () => {
    const base = [turnStart(0, 1000, 1), user(1, 1100, 'a')]
    const engine = new ReplayEngine(base)
    engine.append(base) // re-feed the same history
    engine.append([{ ...base[1]! }]) // and one repeated event
    expect(engine.snapshot.total).toBe(2)
  })

  it('plays appended events after seek and resets atEnd', () => {
    const engine = new ReplayEngine([turnStart(0, 1000, 1), user(1, 1100, 'a')])
    const kinds: string[] = []
    engine.onEmit = entry => { kinds.push(entry.kind) }
    while (engine.step() !== null) { /* drain */ }
    expect(engine.snapshot.atEnd).toBe(true)

    engine.append([turnStart(2, 5000, 2)])
    expect(engine.snapshot.atEnd).toBe(false)
    engine.step()
    expect(kinds).toEqual(['turn-start', 'user', 'turn-start'])
  })

  it('resolves tool-result names across an append boundary', () => {
    const call: SessionEvent = {
      type: 'tool/call', seq: 2, time: 3000,
      data: { turn: 1, step: 1, callId: CallId('c1'), name: 'grep', arguments: '{}' },
    }
    const result: SessionEvent = {
      type: 'tool/result', seq: 3, time: 4000, surfaceOp: 'append',
      data: {
        turn: 1, step: 1,
        message: {
          id: MessageId('r3'), role: 'user',
          content: [{ type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'ok' }] }],
          source: { kind: 'tool', callId: CallId('c1') },
        },
      },
    }
    const engine = new ReplayEngine([turnStart(0, 1000, 1), user(1, 1100, 'x')])
    engine.append([call])
    engine.append([result])
    const names: string[] = []
    engine.onEmit = entry => { if (entry.kind === 'tool-result') names.push(entry.name ?? '?') }
    while (engine.step() !== null) { /* drain */ }
    expect(names).toEqual(['grep'])
  })
})

describe('LiveReplay', () => {
  it('starts from the recorded prefix and follows the firehose', () => {
    const ctx = new Context()
    new SessionStore(ctx)
    const session = ctx.sessions.create(SessionId('live-1'))

    const live = new LiveReplay(ctx, session.id, session.events)
    expect(live.engine.snapshot.total).toBe(0)

    // Simulate the harness appending a live event to the session.
    session.append('turn/start', { turn: 1 })
    expect(live.engine.snapshot.total).toBe(1)

    session.append('user/message', {
      id: MessageId('u-live'),
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    expect(live.engine.snapshot.total).toBe(2)
    // Folded state reflects the playback cursor; drain to the tail to see it.
    while (live.engine.step() !== null) { /* drain */ }
    expect(live.engine.folded.turn).toBe(1)
    live.dispose()
  })

  it('ignores events from other sessions and disposes cleanly', () => {
    const ctx = new Context()
    new SessionStore(ctx)
    const target = ctx.sessions.create(SessionId('live-target'))
    const other = ctx.sessions.create(SessionId('live-other'))

    const live = new LiveReplay(ctx, target.id, [])
    other.append('turn/start', { turn: 99 })
    expect(live.engine.snapshot.total).toBe(0)

    target.append('turn/start', { turn: 1 })
    expect(live.engine.snapshot.total).toBe(1)

    live.dispose()
    target.append('user/message', {
      id: MessageId('u-after'),
      role: 'user',
      content: [{ type: 'text', text: 'after' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    expect(live.engine.snapshot.total).toBe(1) // no longer following
  })

  it('keeps the engine playable while events stream in', () => {
    const ctx = new Context()
    new SessionStore(ctx)
    const session = ctx.sessions.create(SessionId('live-play'))
    session.append('turn/start', { turn: 1 })

    const live = new LiveReplay(ctx, session.id, session.events)
    session.append('user/message', {
      id: MessageId('u-play'),
      role: 'user',
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })

    const kinds: string[] = []
    live.engine.onEmit = entry => { kinds.push(entry.kind) }
    live.engine.step()
    live.engine.step()
    expect(kinds).toEqual(['turn-start', 'user'])
    live.dispose()
  })
})
