import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { forkRun } from '../src/fork.ts'

const tempRoots: string[] = []

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

function user(seq: number, time: number, text: string): SessionEvent {
  return {
    type: 'user/message', seq, time, surfaceOp: 'append',
    data: { id: MessageId(`u-${seq}`), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

function assistant(seq: number, time: number, turn: number, text: string): SessionEvent {
  return {
    type: 'assistant/message', seq, time, surfaceOp: 'append',
    data: {
      turn, step: 1,
      message: {
        id: MessageId(`a-${seq}`), role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
    },
  }
}

/** Two completed turns, ready for persistence round-trip. */
function sampleEvents(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    user(1, 1100, 'first'),
    assistant(2, 2100, 1, 'one'),
    { type: 'turn/end', seq: 3, time: 2200, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 4, time: 5000, data: { turn: 2 } },
    user(5, 5100, 'second'),
    assistant(6, 6100, 2, 'two'),
    { type: 'turn/end', seq: 7, time: 6200, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
}

async function persistedSource(ctx: Context, id: SessionId): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fork-src-'))
  tempRoots.push(root)
  const persistence = new JsonlSessionPersistence(ctx, { root })
  const header: SessionHeader = { version: 0, id, createdAt: Date.now(), cwd: process.cwd() }
  await persistence.create(header)
  await persistence.append(id, sampleEvents())
}

function freshCtx(): Context {
  const ctx = new Context()
  new SessionStore(ctx)
  return ctx
}

describe('forkRun', () => {
  it('forks a persisted run at the default tail boundary', async () => {
    const ctx = freshCtx()
    const sourceId = SessionId('fork-tail')
    await persistedSource(ctx, sourceId)

    const { child, boundary, cut } = await forkRun(ctx, sourceId)
    expect(String(child.id)).not.toBe(String(sourceId))
    expect(boundary).toBe(7)
    expect(cut).toEqual([])
    expect(child.header.parentSession).toBe(sourceId)
    expect(child.header.seedLength).toBe(8)
  })

  it('forks at an explicit seq and reports the discarded tail', async () => {
    const ctx = freshCtx()
    const sourceId = SessionId('fork-seq')
    await persistedSource(ctx, sourceId)

    const { child, boundary, cut } = await forkRun(ctx, sourceId, { boundary: 3 })
    expect(boundary).toBe(3)
    expect(child.header.seedLength).toBe(4)
    expect(cut.map(event => event.seq)).toEqual([4, 5, 6, 7])
    // Lineage metadata is recorded on the child.
    expect(child.header.parentSession).toBe(sourceId)
  })

  it('forks at the end of a given turn', async () => {
    const ctx = freshCtx()
    const sourceId = SessionId('fork-turn')
    await persistedSource(ctx, sourceId)

    const { boundary, cut } = await forkRun(ctx, sourceId, { turn: 1 })
    expect(boundary).toBe(3)
    expect(cut.length).toBe(4)
  })

  it('rejects an unknown turn with no turn/end', async () => {
    const ctx = freshCtx()
    const sourceId = SessionId('fork-noturn')
    await persistedSource(ctx, sourceId)
    await expect(forkRun(ctx, sourceId, { turn: 9 })).rejects.toThrow(/no completed turn\/end/)
  })

  it('rejects a boundary inside an open turn', async () => {
    const ctx = freshCtx()
    const sourceId = SessionId('fork-open')
    // Build a live session with an unclosed turn directly.
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      user(1, 1100, 'open'),
      assistant(2, 2100, 1, 'still going'),
    ]
    ctx.sessions.create(sourceId, { seed: events })

    await expect(forkRun(ctx, sourceId, { boundary: 2 })).rejects.toThrow(/open turn 1/)
  })

  it('reuses an already-live source instead of reloading', async () => {
    const ctx = freshCtx()
    const sourceId = SessionId('fork-live')
    ctx.sessions.create(sourceId, { seed: sampleEvents() })

    const { child, boundary } = await forkRun(ctx, sourceId, { turn: 2 })
    expect(boundary).toBe(7)
    expect(child.header.parentSession).toBe(sourceId)
  })
})
