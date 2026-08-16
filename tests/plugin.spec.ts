import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { runReplayCommand } from '../src/plugin.ts'

const tempRoots: string[] = []

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

function sampleEvents(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    {
      type: 'user/message', seq: 1, time: 1100, surfaceOp: 'append',
      data: { id: MessageId('u1'), role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
    },
    { type: 'tool/call', seq: 2, time: 2200, data: { turn: 1, step: 1, callId: CallId('c1'), name: 'grep', arguments: '{"q":"x"}' } },
    { type: 'turn/end', seq: 3, time: 3000, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

async function makeCtx(extraEvents: readonly SessionEvent[] = []): Promise<{ ctx: Context; id: SessionId }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-replay-cmd-'))
  tempRoots.push(root)
  const ctx = new Context()
  new SessionStore(ctx)
  const persistence = new JsonlSessionPersistence(ctx, { root })
  const id = SessionId('cmd-test-session')
  const header: SessionHeader = { version: 0, id, createdAt: Date.now(), cwd: process.cwd() }
  await persistence.create(header)
  await persistence.append(id, [...sampleEvents(), ...extraEvents])
  return { ctx, id }
}

describe('runReplayCommand', () => {
  it('renders a recorded run as a text timeline', async () => {
    const { ctx, id } = await makeCtx()
    const result = await runReplayCommand(ctx, id, false)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      // Rows carry ANSI color codes, so match on stable fragments.
      expect(result.text).toContain('== Turn 1 ==')
      expect(result.text).toContain('user:')
      expect(result.text).toContain('hello')
      expect(result.text).toContain('grep')
      expect(result.text).toContain('== Turn 1 end (completed) ==')
    }
  })

  it('returns an error result for an unknown session', async () => {
    const { ctx } = await makeCtx()
    const result = await runReplayCommand(ctx, SessionId('no-such-session'), false)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text.length).toBeGreaterThan(0)
  })

  it('attaches a live follow tail when requested', async () => {
    const { ctx, id } = await makeCtx()
    const result = await runReplayCommand(ctx, id, true)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text).toContain('following live events')
    }
  })

  it('caps a giant run at 6000 chars and skips the tail rows', async () => {
    // ~120 user messages of ~110 chars each render to well over 12k chars of
    // timeline: the drain must stop once the cap is covered and the final
    // text must end with the truncation marker instead of the last rows.
    // This is the only test that exercises the chars/capped path in plugin.ts
    // (the other fixtures are far below the 6000-char cap).
    const tailText = 'MARKER-TAIL-ROW'
    const bigRun: SessionEvent[] = Array.from({ length: 120 }, (_, i) => ({
      type: 'user/message', seq: i + 4, time: 1100 + i, surfaceOp: 'append',
      data: {
        id: MessageId(`u-cap-${i}`), role: 'user',
        content: [{ type: 'text', text: i === 119 ? tailText : `pad-${i}-`.repeat(16) }],
        source: { kind: 'user' },
      },
    }))
    const { ctx, id } = await makeCtx(bigRun)
    const result = await runReplayCommand(ctx, id, false)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text.endsWith('… (truncated at 6000 chars)')).toBe(true)
      // The final row was never rendered (drain stopped at the cap).
      expect(result.text).not.toContain(tailText)
    }
  })
})
