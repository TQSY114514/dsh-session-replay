import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ReplayEngine } from '../src/engine/index.ts'
import { loadRun } from '../src/store/reader.ts'

const tempRoots: string[] = []

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

function sampleEvents(): SessionEvent[] {
  // Surface-eligible events must carry a surfaceOp marker to round-trip the
  // persistence backend (append origin here).
  const user = (seq: number, time: number, text: string): SessionEvent => ({
    type: 'user/message', seq, time, surfaceOp: 'append',
    data: { id: MessageId(`u-${seq}`), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  })
  const assistant = (seq: number, time: number, text: string): SessionEvent => ({
    type: 'assistant/message', seq, time, surfaceOp: 'append',
    data: {
      turn: 1, step: 1,
      message: {
        id: MessageId(`a-${seq}`), role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
    },
  })
  return [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    user(1, 1100, 'count the files'),
    assistant(2, 2100, 'let me look'),
    { type: 'tool/call', seq: 3, time: 2200, data: { turn: 1, step: 1, callId: CallId('c1'), name: 'bash', arguments: '{"command":"ls"}' } },
    {
      type: 'tool/result', seq: 4, time: 5200, surfaceOp: 'append',
      data: {
        turn: 1, step: 1,
        message: {
          id: MessageId('r4'), role: 'user',
          content: [{ type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'a.ts b.ts' }] }],
          source: { kind: 'tool', callId: CallId('c1') },
        },
      },
    },
    { type: 'turn/end', seq: 5, time: 5300, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('end-to-end: JSONL backend round trip', () => {
  it('records events, loads them back, and replays the run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-replay-integ-'))
    tempRoots.push(root)
    const ctx = new Context()
    // The JSONL coordinator requires the sessions service for its write path.
    new SessionStore(ctx)
    const persistence = new JsonlSessionPersistence(ctx, { root, compression: 'none' })
    const id = SessionId('integ-test-session')
    const header: SessionHeader = { version: 0, id, createdAt: Date.now(), cwd: process.cwd() }
    const events = sampleEvents()

    await persistence.create(header)
    await persistence.append(id, events)

    const run = await loadRun(persistence, id)
    expect(run.meta.id).toBe(id)
    expect(run.events.length).toBe(events.length)
    expect(run.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5])

    const engine = new ReplayEngine(run.events)
    const rows: string[] = []
    engine.onEmit = entry => { rows.push(entry.kind) }
    while (engine.step() !== null) { /* drain */ }

    expect(rows).toEqual([
      'turn-start', 'user', 'assistant', 'tool-call', 'tool-result', 'turn-end',
    ])
    expect(engine.folded.turn).toBe(1)
    expect(engine.folded.toolCallCount).toBe(1)
  })
})
