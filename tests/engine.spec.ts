import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import { ReplayEngine } from '../src/engine/index.ts'

/** A minimal realistic two-turn log with staggered timestamps. */
function sampleLog(): SessionEvent[] {
  const userText = (seq: number, time: number, text: string): SessionEvent => ({
    type: 'user/message', seq, time,
    data: { id: MessageId(`u-${seq}`), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  })
  const assistantText = (seq: number, time: number, turn: number, text: string): SessionEvent => ({
    type: 'assistant/message', seq, time,
    data: {
      turn, step: 1,
      message: {
        id: MessageId(`a-${seq}`), role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
    },
  })
  return [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    userText(1, 1100, 'hello'),
    assistantText(2, 2100, 1, 'hi'),
    { type: 'tool/call', seq: 3, time: 2200, data: { turn: 1, step: 1, callId: CallId('c1'), name: 'grep', arguments: '{"q":"x"}' } },
    {
      type: 'tool/result', seq: 4, time: 5200,
      data: {
        turn: 1, step: 1,
        message: {
          id: MessageId('r4'), role: 'user',
          content: [{ type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'no match' }] }],
          source: { kind: 'tool', callId: CallId('c1') },
        },
      },
    },
    { type: 'turn/end', seq: 5, time: 5300, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 6, time: 9000, data: { turn: 2 } },
    userText(7, 9100, 'again'),
    assistantText(8, 10100, 2, 'done'),
    { type: 'turn/end', seq: 9, time: 10200, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
}

describe('ReplayEngine stepping', () => {
  it('emits one entry per step, in log order, skipping non-renderable events', () => {
    const engine = new ReplayEngine(sampleLog())
    const kinds: string[] = []
    engine.onEmit = entry => { kinds.push(entry.kind) }

    engine.step()
    engine.step()
    engine.step()

    expect(kinds).toEqual(['turn-start', 'user', 'assistant'])
    expect(engine.snapshot.cursor).toBe(3)
  })

  it('returns null and finishes after the final event', () => {
    const engine = new ReplayEngine(sampleLog())
    let ended = false
    engine.onEnd = () => { ended = true }
    while (engine.step() !== null) { /* drain */ }
    expect(ended).toBe(true)
    expect(engine.snapshot.atEnd).toBe(true)
    expect(engine.step()).toBeNull()
  })

  it('resolves tool-result names from preceding tool calls, even after a seek', () => {
    const engine = new ReplayEngine(sampleLog())
    // Drain turn 1 entirely, then seek back into turn 1 and verify resolution still works.
    while (engine.step() !== null) { /* drain */ }
    expect(engine.seekToTurn(1)).toBe(true)
    engine.step() // turn-start
    engine.step() // user
    engine.step() // assistant
    const names: string[] = []
    engine.onEmit = entry => { if (entry.kind === 'tool-result') names.push(entry.name ?? '?') }
    while (engine.step() !== null) { /* drain to end */ }
    expect(names).toEqual(['grep'])
  })
})

describe('ReplayEngine timed playback', () => {
  it('advances only when accumulated time covers the real gap', () => {
    const engine = new ReplayEngine(sampleLog())
    const emitted: string[] = []
    engine.onEmit = entry => { emitted.push(entry.kind) }

    engine.play()
    engine.tick(1000) // anchor
    engine.tick(1500) // +500ms, gap to event 1 is 100ms -> not yet for event 2's 1000ms gap
    // After 500ms: event 0 (delta 0) and event 1 (delta 100) emitted; event 2 needs 1000ms total.
    expect(emitted).toEqual(['turn-start', 'user'])

    engine.tick(2600) // +1100ms
    expect(emitted).toContain('assistant')
  })

  it('applies speed as a multiplier on accumulated time', () => {
    const engine = new ReplayEngine(sampleLog())
    const emitted: string[] = []
    engine.onEmit = entry => { emitted.push(entry.kind) }

    engine.setSpeed(2)
    engine.play()
    engine.tick(1000)
    engine.tick(1550) // +550ms at 2x = 1100ms virtual
    // Virtual 1100ms covers events 0 (0) + 1 (100) + 2 (1000).
    expect(emitted).toEqual(['turn-start', 'user', 'assistant'])
  })

  it('does not advance while paused', () => {
    const engine = new ReplayEngine(sampleLog())
    let emissions = 0
    engine.onEmit = () => { emissions += 1 }

    engine.tick(1000)
    engine.tick(2000)
    expect(emissions).toBe(0)

    engine.play()
    engine.tick(3000) // anchor after play
    engine.tick(3100) // +100ms covers events 0 and 1
    expect(emissions).toBe(2)
  })

  it('pauses and resumes cleanly, resetting the anchor', () => {
    const engine = new ReplayEngine(sampleLog())
    const emitted: string[] = []
    engine.onEmit = entry => { emitted.push(entry.kind) }

    engine.play()
    engine.tick(1000)
    engine.pause()
    engine.tick(99999) // a long pause must not advance the clock
    expect(emitted.length).toBe(0)

    engine.play()
    engine.tick(2000) // fresh anchor
    engine.tick(3110) // +1110ms real covers events 0+1+2 (cumulative 1100ms gap)
    expect(emitted).toEqual(['turn-start', 'user', 'assistant'])
  })
})

describe('ReplayEngine seeking', () => {
  it('seeks to a turn boundary and continues from there', () => {
    const engine = new ReplayEngine(sampleLog())
    const kinds: string[] = []
    engine.onEmit = entry => { kinds.push(entry.kind) }

    expect(engine.seekToTurn(2)).toBe(true)
    expect(engine.snapshot.cursor).toBe(6)
    engine.step()
    engine.step()
    expect(kinds).toEqual(['turn-start', 'user'])
    expect(engine.folded.turn).toBe(2)
  })

  it('seeks by seq and by step', () => {
    const engine = new ReplayEngine(sampleLog())
    expect(engine.seekToSeq(3)).toBe(true)
    expect(engine.snapshot.cursor).toBe(3)

    // seekToStep needs step/start events, which sampleLog does not carry.
    const stepped: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 100, data: { turn: 1, step: 1 } },
      { type: 'step/start', seq: 2, time: 200, data: { turn: 1, step: 2 } },
    ]
    const engine2 = new ReplayEngine(stepped)
    expect(engine2.seekToStep(1, 2)).toBe(true)
    expect(engine2.snapshot.cursor).toBe(2)
  })

  it('rejects absent seek targets', () => {
    const engine = new ReplayEngine(sampleLog())
    expect(engine.seekToTurn(99)).toBe(false)
    expect(engine.seekToSeq(12345)).toBe(false)
    expect(engine.seekToStep(1, 99)).toBe(false)
  })
})
