import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import { foldAt } from '../src/engine/fold.ts'

function todo(seq: number, items: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>): SessionEvent {
  return { type: 'todo/write', seq, time: seq * 1000, data: { todos: items } }
}

function toolCall(seq: number, ok: boolean): SessionEvent {
  if (ok) {
    return { type: 'tool/call', seq, time: seq * 1000, data: { turn: 1, step: 1, callId: CallId(`c${seq}`), name: 'bash', arguments: '{}' } }
  }
  return {
    type: 'tool/result', seq, time: seq * 1000,
    data: {
      turn: 1, step: 1,
      message: {
        id: MessageId(`r${seq}`), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId(`c${seq}`), content: [{ type: 'text', text: 'x' }] }],
        source: { kind: 'tool', callId: CallId(`c${seq}`) },
      },
      error: { name: 'ToolError', code: 'E_FAIL' },
    },
  }
}

describe('foldAt', () => {
  it('keeps the latest whole-list todo snapshot', () => {
    const events = [
      todo(0, [{ content: 'a', status: 'pending' }]),
      todo(1, [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }]),
    ]
    expect(foldAt(events, 2).todos).toEqual([
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'pending' },
    ])
    // Before the second write the first snapshot is visible.
    expect(foldAt(events, 1).todos).toEqual([{ content: 'a', status: 'pending' }])
  })

  it('tracks the current turn, tool call count, and error count', () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 3 } },
      toolCall(1, true),
      toolCall(2, true),
      toolCall(3, false),
    ]
    const state = foldAt(events, 4)
    expect(state.turn).toBe(3)
    expect(state.toolCallCount).toBe(2)
    expect(state.errorCount).toBe(1)
  })

  it('records the latest request reason', () => {
    const events: SessionEvent[] = [
      { type: 'request/header', seq: 0, time: 0, data: { header: {} as never, reason: 'initial' } },
      { type: 'request/header', seq: 1, time: 1, data: { header: {} as never, reason: 'change' } },
    ]
    expect(foldAt(events, 2).lastRequestReason).toBe('change')
  })

  it('clamps at the log length and handles an empty prefix', () => {
    expect(foldAt([todo(0, [])], 99).turn).toBeUndefined()
    expect(foldAt([], 0).todos).toEqual([])
  })
})
